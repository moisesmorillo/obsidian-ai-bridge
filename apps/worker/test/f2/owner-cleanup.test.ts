import { env, runInDurableObject, SELF } from "cloudflare:test";
import {
	type ClientRegistryGateway,
	listClients,
} from "@worker/application/clients";
import type { Vault } from "@worker/infrastructure/durable-object/vault";
import { SqliteClientRegistry } from "@worker/infrastructure/sqlite/clients";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Owner identity used only with isolated test storage. */
const OWNER = "synthetic-owner";
/** Stale registration age in milliseconds. */
const DAY = 24 * 60 * 60 * 1_000;

/** Create an accepted grant through the real consent fence. */
async function acceptGrant(stub: DurableObjectStub<Vault>, clientId: string) {
	const consent = await stub.beginClientConsent(OWNER, clientId, clientId);
	const grant = {
		owner_subject: OWNER,
		client_id: clientId,
		grant_id: `grant-${crypto.randomUUID()}`,
		generation: consent.generation,
		consent_id: consent.consent_id,
	};
	expect(await stub.registerClientGrant(grant)).toBe(true);
	return grant;
}

/** Sign a synthetic Access assertion and serve only its public verification key. */
async function ownerAssertion() {
	const pair = await generateKeyPair("RS256");
	const jwk = await exportJWK(pair.publicKey);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				keys: [{ ...jwk, kid: "cleanup-owner", alg: "RS256", use: "sig" }],
			}),
		),
	);
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: "cleanup-owner" })
		.setIssuer("https://team.test")
		.setAudience("synthetic-access-app")
		.setSubject(OWNER)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(pair.privateKey);
}

/** Read a fresh browser-bound form state from the production console. */
async function ownerForm(assertion: string) {
	const response = await SELF.fetch("https://service.test/owner/clients", {
		headers: { "Cf-Access-Jwt-Assertion": assertion },
	});
	expect(response.status).toBe(200);
	const html = await response.text();
	const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!csrf || !cookie) throw new Error("Owner form state is absent");
	return { csrf, cookie, html };
}

/** Send a removal request through the production owner transport. */
async function removeRequest(
	assertion: string,
	clientId: string,
	form: { csrf: string; cookie: string },
	origin = "https://service.test",
) {
	return SELF.fetch(
		`https://service.test/owner/clients/${encodeURIComponent(clientId)}/remove`,
		{
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": assertion,
				"content-type": "application/x-www-form-urlencoded",
				origin,
				cookie: form.cookie,
			},
			body: new URLSearchParams({ csrf: form.csrf }),
		},
	);
}

/** Snapshot vault tables whose rows must survive console registry removal unchanged. */
function contentSnapshot(storage: DurableObjectStorage) {
	return {
		files: storage.sql.exec("SELECT * FROM files").toArray(),
		revisions: storage.sql.exec("SELECT * FROM revisions").toArray(),
		changes: storage.sql.exec("SELECT * FROM changes").toArray(),
		receipts: storage.sql.exec("SELECT * FROM receipts").toArray(),
	};
}

describe("owner client cleanup", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("removes revoked registry rows but preserves denial, files, and opaque history", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(crypto.randomUUID()));
		const grant = await acceptGrant(stub, "removed-client");
		await stub.revokeClient(OWNER, grant.client_id);
		await stub.markGrantCleanupComplete(grant.client_id, grant.grant_id);
		await runInDurableObject(stub, (_instance, state) => {
			const registry = new SqliteClientRegistry(state.storage, Date.now);
			state.storage.sql.exec(
				"INSERT INTO receipts (client_id, key, fingerprint, status, body, at) VALUES (?, 'receipt', 'fingerprint', 200, '{}', 1)",
				grant.client_id,
			);
			state.storage.sql.exec(
				"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, content, updated_at, origin) VALUES ('keep.md', 'keep.md', 1, 1, 'hash', 4, 'text', 'keep', 1, ?)",
				grant.client_id,
			);
			state.storage.sql.exec(
				"INSERT INTO revisions (path, rev, hash, size, kind, content, deleted, origin, at) VALUES ('keep.md', 1, 'hash', 4, 'text', 'keep', 0, ?, 1)",
				grant.client_id,
			);
			state.storage.sql.exec(
				"INSERT INTO changes (op, path, rev, hash, origin, at) VALUES ('put', 'keep.md', 1, 'hash', ?, 1)",
				grant.client_id,
			);
			const before = contentSnapshot(state.storage);
			expect(registry.removeClient(OWNER, grant.client_id)).toBe(true);
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM client_generations WHERE client_id = ?",
						grant.client_id,
					)
					.toArray(),
			).toEqual([]);
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM client_consents WHERE client_id = ?",
						grant.client_id,
					)
					.toArray(),
			).toEqual([]);
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM client_grants WHERE client_id = ?",
						grant.client_id,
					)
					.toArray(),
			).toEqual([]);
			expect(contentSnapshot(state.storage)).toEqual(before);
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM revoked_grants WHERE grant_id = ?",
						grant.grant_id,
					)
					.toArray(),
			).toHaveLength(1);
		});
		expect(await stub.registerClientGrant(grant)).toBe(false);
		await stub.beginClientConsent(OWNER, grant.client_id, "Fresh consent");
		expect(await stub.registerClientGrant(grant)).toBe(false);
		expect(
			await stub.getCurrentEpoch(
				{
					client_id: grant.client_id,
					grant_id: grant.grant_id,
					scopes: ["vault:read"],
				},
				"read",
			),
		).toEqual({ ok: false, failure: { kind: "revoked" } });
	});

	it("refuses active, mixed, wrong-owner, unrevoked, and cleanup-pending clients", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(crypto.randomUUID()));
		const grant = await acceptGrant(stub, "guarded-client");
		await runInDurableObject(stub, (_instance, state) => {
			const registry = new SqliteClientRegistry(state.storage, Date.now);
			expect(registry.removeClient(OWNER, grant.client_id)).toBe(false);
		});
		await stub.revokeClient(OWNER, grant.client_id);
		await runInDurableObject(stub, (_instance, state) => {
			const registry = new SqliteClientRegistry(state.storage, Date.now);
			expect(registry.removeClient(OWNER, grant.client_id)).toBe(false);
		});
		await stub.markGrantCleanupComplete(grant.client_id, grant.grant_id);
		await acceptGrant(stub, grant.client_id);
		await stub.beginClientConsent(OWNER, "never-revoked", "Pending");
		await runInDurableObject(stub, (_instance, state) => {
			const registry = new SqliteClientRegistry(state.storage, Date.now);
			expect(registry.removeClient(OWNER, grant.client_id)).toBe(false);
			expect(registry.removeClient("other-owner", grant.client_id)).toBe(false);
			expect(registry.removeClient(OWNER, "never-revoked")).toBe(false);
			expect(registry.removeClient(OWNER, "missing")).toBe(false);
		});
	});

	it("sweeps only old ungranted registrations without current consent", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(crypto.randomUUID()));
		await stub.beginClientConsent(OWNER, "initialize", "Initialize");
		await runInDurableObject(stub, (_instance, state) => {
			const now = Date.now();
			const registry = new SqliteClientRegistry(state.storage, () => now);
			for (const id of [
				"stale",
				"boundary",
				"recent",
				"fresh-consent",
				"accepted",
				"revoked",
				"foreign",
			]) {
				const consent = registry.beginClientConsent(
					id === "foreign" ? "other-owner" : OWNER,
					id,
					id,
				);
				if (id === "accepted" || id === "revoked") {
					expect(
						registry.registerClientGrant({
							owner_subject: OWNER,
							client_id: id,
							grant_id: `grant-${id}`,
							generation: consent.generation,
							consent_id: consent.consent_id,
						}),
					).toBe(true);
					if (id === "revoked") registry.revokeClient(OWNER, id);
				}
				state.storage.sql.exec(
					"UPDATE client_generations SET created_at = ? WHERE client_id = ?",
					now - DAY - 1,
					id,
				);
				if (id !== "fresh-consent")
					state.storage.sql.exec(
						"UPDATE client_consents SET created_at = ? WHERE client_id = ?",
						now - DAY,
						id,
					);
			}
			state.storage.sql.exec(
				"UPDATE client_generations SET created_at = ? WHERE client_id = 'boundary'",
				now - DAY,
			);
			state.storage.sql.exec(
				"UPDATE client_generations SET created_at = ? WHERE client_id = 'recent'",
				now - DAY + 1,
			);
			registry.sweepStaleClients(OWNER);
			expect(
				registry.listClients(OWNER).clients.map((client) => client.client_id),
			).not.toContain("stale");
			for (const id of [
				"boundary",
				"recent",
				"fresh-consent",
				"accepted",
				"revoked",
			])
				expect(
					registry
						.listClients(OWNER)
						.clients.some((client) => client.client_id === id),
				).toBe(true);
			expect(registry.listClients("other-owner").clients).toHaveLength(1);
			expect(
				state.storage.sql
					.exec("SELECT * FROM client_consents WHERE client_id = 'stale'")
					.toArray(),
			).toEqual([]);
		});
	});

	it("orders active clients before revoked clients across page boundaries", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName(crypto.randomUUID()));
		await stub.beginClientConsent(OWNER, "initialize", "Initialize");
		await runInDurableObject(stub, (_instance, state) => {
			const registry = new SqliteClientRegistry(state.storage, Date.now);
			for (let index = 0; index < 34; index += 1) {
				const id =
					index === 0
						? "a-revoked"
						: `z-active-${String(index).padStart(2, "0")}`;
				const consent = registry.beginClientConsent(OWNER, id, id);
				registry.registerClientGrant({
					owner_subject: OWNER,
					client_id: id,
					grant_id: `grant-${id}`,
					generation: consent.generation,
					consent_id: consent.consent_id,
				});
				if (index === 0) registry.revokeClient(OWNER, id);
			}
			const first = registry.listClients(OWNER);
			expect(first.clients).toHaveLength(32);
			expect(
				first.clients.every((client) => client.active_grant_count === 1),
			).toBe(true);
			const last = registry.listClients(OWNER, first.next_cursor ?? undefined);
			expect(last.clients.map((client) => client.client_id)).toEqual([
				"z-active-33",
				"initialize",
				"a-revoked",
			]);
		});
	});

	it("sweeps before the application reads the console page", async () => {
		const sweepStaleClients = vi.fn(async () => undefined);
		const read = vi.fn(async () => ({ clients: [], next_cursor: null }));
		/** Reject unrelated port calls so this test isolates application list order. */
		const unused = async (): Promise<never> => {
			throw new Error("Unexpected registry call");
		};
		const registry: ClientRegistryGateway = {
			sweepStaleClients,
			listClients: read,
			beginClientConsent: unused,
			registerClientGrant: unused,
			removeClient: unused,
			listClientGrants: unused,
			renameClient: unused,
			revokeClient: unused,
			markGrantCleanupComplete: unused,
			storeOwnerCsrf: unused,
			consumeOwnerCsrf: unused,
		};
		await listClients(registry, OWNER);
		expect(sweepStaleClients).toHaveBeenCalledWith(OWNER);
		expect(sweepStaleClients.mock.invocationCallOrder[0]).toBeLessThan(
			read.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("renders Remove, sweeps stale rows, rejects CSRF, and removes only revoked clients", async () => {
		const assertion = await ownerAssertion();
		const stub = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
		const revoked = await acceptGrant(stub, "a-revoked");
		await stub.revokeClient(OWNER, revoked.client_id);
		await stub.markGrantCleanupComplete(revoked.client_id, revoked.grant_id);
		await acceptGrant(stub, "z-active");
		await stub.beginClientConsent(OWNER, "stale-console", "Stale console");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE client_generations SET created_at = ? WHERE client_id = 'stale-console'",
				Date.now() - DAY - 1_000,
			);
			state.storage.sql.exec(
				"UPDATE client_consents SET created_at = ? WHERE client_id = 'stale-console'",
				Date.now() - DAY,
			);
		});
		const form = await ownerForm(assertion);
		expect(form.html).toContain("/owner/clients/a-revoked/remove");
		expect(form.html).not.toContain("/owner/clients/z-active/remove");
		expect(form.html).not.toContain("stale-console");
		expect(form.html.indexOf("Client: z-active")).toBeLessThan(
			form.html.indexOf("Client: a-revoked"),
		);
		expect(
			(
				await removeRequest(
					assertion,
					"a-revoked",
					form,
					"https://attacker.test",
				)
			).status,
		).toBe(403);
		expect(
			(
				await removeRequest(assertion, "a-revoked", {
					...form,
					cookie: `__Host-oab-owner=${crypto.randomUUID()}`,
				})
			).status,
		).toBe(403);
		expect(
			(
				await removeRequest(assertion, "a-revoked", {
					...form,
					csrf: crypto.randomUUID(),
				})
			).status,
		).toBe(403);
		expect((await removeRequest(assertion, "a-revoked", form)).status).toBe(
			303,
		);
		expect((await removeRequest(assertion, "a-revoked", form)).status).toBe(
			403,
		);
		const fresh = await ownerForm(assertion);
		expect((await removeRequest(assertion, "z-active", fresh)).status).toBe(
			409,
		);
		expect(
			(await stub.listClients(OWNER)).clients.map((client) => client.client_id),
		).toEqual(["z-active"]);
	});
});
