import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import {
	MAX_OAUTH_GRANTS,
	MAX_PENDING_CONSENTS,
	SqliteClientRegistry,
} from "@worker/infrastructure/sqlite/clients";
import { describe, expect, it } from "vitest";

describe("durable client registry", () => {
	it("fences callbacks across revocation and allows fresh consent without clearing old denial", async () => {
		const clientId = `registry-${crypto.randomUUID()}`;
		const ownerSubject = "synthetic-owner";
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`registry-${crypto.randomUUID()}`),
		);
		const first = await stub.beginClientConsent(
			ownerSubject,
			clientId,
			"First name",
		);
		const callbackBeforeRevoke = {
			owner_subject: ownerSubject,
			client_id: clientId,
			grant_id: `grant-${crypto.randomUUID()}`,
			generation: first.generation,
			consent_id: first.consent_id,
		};
		expect(await stub.registerClientGrant(callbackBeforeRevoke)).toBe(true);
		const context: AuthorizationContext = {
			client_id: clientId,
			grant_id: callbackBeforeRevoke.grant_id,
			scopes: ["vault:read", "vault:write"],
		};
		const epochResult = await stub.getCurrentEpoch(context, "put");
		if (!epochResult.ok)
			throw new Error("Fresh grant did not authorize the current epoch");
		const descriptor = {
			op: "put" as const,
			epoch: epochResult.current_epoch,
			paths: ["reserved.md"],
			precondition: { kind: "absent" as const },
		};
		const reservation = await stub.beginMutation(context, descriptor);
		if (!reservation.ok)
			throw new Error("Mutation reservation failed before revocation");
		const revoked = await stub.revokeClient(ownerSubject, clientId);
		expect(revoked).not.toBeNull();
		expect(revoked?.grants).toEqual([callbackBeforeRevoke.grant_id]);
		await expect(stub.getCurrentEpoch(context, "read")).resolves.toEqual({
			ok: false,
			failure: { kind: "revoked" },
		});
		expect(
			await stub.registerClientGrant({
				...callbackBeforeRevoke,
				grant_id: `late-${crypto.randomUUID()}`,
			}),
		).toBe(false);
		await expect(
			stub.authorize(
				context,
				{ ...descriptor, payload_hash: "a".repeat(64), size: 1 },
				reservation.lease.admission_id,
			),
		).resolves.toEqual({ ok: false, failure: { kind: "revoked" } });
		const second = await stub.beginClientConsent(
			ownerSubject,
			clientId,
			"Reconnected name",
		);
		expect(second.generation).toBe(revoked?.generation ?? 0);
		const freshGrant = {
			...callbackBeforeRevoke,
			grant_id: `fresh-${crypto.randomUUID()}`,
			generation: second.generation,
			consent_id: second.consent_id,
		};
		expect(await stub.registerClientGrant(freshGrant)).toBe(true);
		await expect(stub.getCurrentEpoch(context, "read")).resolves.toEqual({
			ok: false,
			failure: { kind: "revoked" },
		});
		const freshContext = { ...context, grant_id: freshGrant.grant_id };
		await expect(
			stub.getCurrentEpoch(freshContext, "read"),
		).resolves.toMatchObject({ ok: true });
		const listing = await stub.listClients(ownerSubject);
		expect(
			listing.clients.find((client) => client.client_id === clientId)?.name,
		).toBe("Reconnected name");
		await runInDurableObject(stub, (_instance, state) => {
			expect(
				state.storage.sql
					.exec(
						"SELECT grant_id FROM revoked_grants WHERE grant_id = ?",
						callbackBeforeRevoke.grant_id,
					)
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("pages client and grant listings at 32 rows", async () => {
		const ownerSubject = "synthetic-owner";
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`pages-${crypto.randomUUID()}`),
		);
		const clientId = "page-client-000";
		await runInDurableObject(stub, (_instance, state) => {
			for (let index = 0; index < 33; index += 1) {
				const id = `page-client-${String(index).padStart(3, "0")}`;
				state.storage.sql.exec(
					"INSERT INTO client_generations (client_id, owner_subject, generation, name, created_at, last_seen_at) VALUES (?, ?, 0, ?, 1, NULL)",
					id,
					ownerSubject,
					id,
				);
			}
			for (let index = 0; index < 33; index += 1)
				state.storage.sql.exec(
					"INSERT INTO client_grants (client_id, grant_id, owner_subject, generation, consent_id, created_at, cleanup_pending) VALUES (?, ?, ?, 0, ?, 1, 0)",
					clientId,
					`page-grant-${String(index).padStart(3, "0")}`,
					ownerSubject,
					crypto.randomUUID(),
				);
		});
		const clients = await stub.listClients(ownerSubject);
		expect(clients.clients).toHaveLength(32);
		expect(clients.next_cursor).toBe("v1:32");
		const nextClients = await stub.listClients(
			ownerSubject,
			clients.next_cursor ?? undefined,
		);
		expect(nextClients.clients).toHaveLength(1);
		const grants = await stub.listClientGrants(ownerSubject, clientId);
		expect(grants.grants).toHaveLength(32);
		expect(grants.next_cursor).toBe("v1:32");
		const nextGrants = await stub.listClientGrants(
			ownerSubject,
			clientId,
			grants.next_cursor ?? undefined,
		);
		expect(nextGrants.grants).toHaveLength(1);
		expect(nextGrants.next_cursor).toBeNull();
	});

	it("limits provider cleanup to sixteen known grants per revocation call", async () => {
		const clientId = `cleanup-${crypto.randomUUID()}`;
		const ownerSubject = "synthetic-owner";
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`cleanup-${crypto.randomUUID()}`),
		);
		let generation = 0;
		for (let index = 0; index < 17; index += 1) {
			const consent = await stub.beginClientConsent(
				ownerSubject,
				clientId,
				"Cleanup client",
			);
			generation = consent.generation;
			expect(
				await stub.registerClientGrant({
					owner_subject: ownerSubject,
					client_id: clientId,
					grant_id: `grant-${index}-${crypto.randomUUID()}`,
					generation,
					consent_id: consent.consent_id,
				}),
			).toBe(true);
		}
		const first = await stub.revokeClient(ownerSubject, clientId);
		expect(first?.grants).toHaveLength(16);
		expect(first?.cleanupPending).toBe(true);
		for (const grantId of first?.grants ?? [])
			await stub.markGrantCleanupComplete(clientId, grantId);
		const second = await stub.revokeClient(ownerSubject, clientId);
		expect(second?.grants).toHaveLength(1);
		expect(second?.cleanupPending).toBe(false);
		for (const grantId of second?.grants ?? [])
			await stub.markGrantCleanupComplete(clientId, grantId);
		expect((await stub.revokeClient(ownerSubject, clientId))?.grants).toEqual(
			[],
		);
	});

	it("revokes one client at the registry ceiling with bounded results and stable denial rows", async () => {
		const ownerSubject = "synthetic-owner";
		const clientId = "registry-near-cap-client";
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`registry-near-cap-${crypto.randomUUID()}`),
		);
		const consent = await stub.beginClientConsent(
			ownerSubject,
			clientId,
			"Near-cap client",
		);
		await runInDurableObject(stub, (_instance, state) => {
			for (let offset = 0; offset < MAX_OAUTH_GRANTS; offset += 512) {
				const count = Math.min(512, MAX_OAUTH_GRANTS - offset);
				state.storage.sql.exec(
					`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
					INSERT INTO client_grants (client_id, grant_id, owner_subject, generation, consent_id, created_at, cleanup_pending)
					SELECT ?, printf('near-cap-grant-%05d', n + ?), ?, 0, printf('near-cap-consent-%05d', n + ?), 1, 0 FROM seq`,
					count - 1,
					clientId,
					offset,
					ownerSubject,
					offset,
				);
			}
			state.storage.sql.exec(
				"INSERT INTO client_consents (consent_id, client_id, owner_subject, generation, created_at) SELECT printf('near-cap-pending-%04d', n), ?, ?, 0, 1 FROM (WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?) SELECT n FROM seq)",
				clientId,
				ownerSubject,
				MAX_PENDING_CONSENTS - 2,
			);
			state.storage.sql.exec(
				"INSERT INTO revoked_grants (grant_id, at) SELECT grant_id, 1700000000000 + CAST(substr(grant_id, -5) AS INTEGER) FROM client_grants WHERE client_id = ? AND CAST(substr(grant_id, -5) AS INTEGER) < 10",
				clientId,
			);
			state.storage.sql.exec(
				"UPDATE client_grants SET cleanup_pending = 1 WHERE client_id = ? AND CAST(substr(grant_id, -5) AS INTEGER) BETWEEN 5 AND 9",
				clientId,
			);
			const grantRows = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM client_grants WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { total: number };
			const consentRows = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM client_consents WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { total: number };
			expect(grantRows.total).toBe(MAX_OAUTH_GRANTS);
			expect(consentRows.total).toBe(MAX_PENDING_CONSENTS);
		});

		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				`CREATE TRIGGER reject_near_cap_denial BEFORE INSERT ON revoked_grants
				WHEN NEW.grant_id = 'near-cap-grant-04000'
				BEGIN SELECT RAISE(ABORT, 'injected near-cap denial failure'); END`,
			);
			const registry = new SqliteClientRegistry(state.storage, () =>
				Date.now(),
			);
			expect(() => registry.revokeClient(ownerSubject, clientId)).toThrow();
			const client = state.storage.sql
				.exec(
					"SELECT generation FROM client_generations WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { generation: number };
			const status = state.storage.sql
				.exec(
					"SELECT SUM(cleanup_pending) AS pending FROM client_grants WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { pending: number };
			const denied = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM revoked_grants WHERE grant_id LIKE 'near-cap-grant-%'",
				)
				.toArray()[0] as { total: number };
			const pendingConsents = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM client_consents WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { total: number };
			expect(client.generation).toBe(consent.generation);
			expect(status.pending).toBe(5);
			expect(denied.total).toBe(10);
			expect(pendingConsents.total).toBe(MAX_PENDING_CONSENTS);
			state.storage.sql.exec("DROP TRIGGER reject_near_cap_denial");
		});

		const first = await stub.revokeClient(ownerSubject, clientId);
		expect(first).toMatchObject({
			generation: consent.generation + 1,
			cleanupPending: true,
		});
		expect(first?.grants).toEqual(
			Array.from(
				{ length: 16 },
				(_, index) => `near-cap-grant-${String(index + 5).padStart(5, "0")}`,
			),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const grants = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total, SUM(cleanup_pending) AS pending FROM client_grants WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { total: number; pending: number };
			const denied = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM revoked_grants WHERE grant_id LIKE 'near-cap-grant-%'",
				)
				.toArray()[0] as { total: number };
			const consentRows = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM client_consents WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { total: number };
			const priorDenials = state.storage.sql
				.exec(
					"SELECT grant_id, at FROM revoked_grants WHERE grant_id LIKE 'near-cap-grant-%' AND CAST(substr(grant_id, -5) AS INTEGER) < 10 ORDER BY grant_id",
				)
				.toArray();
			const generation = state.storage.sql
				.exec(
					"SELECT generation FROM client_generations WHERE client_id = ?",
					clientId,
				)
				.toArray()[0] as { generation: number };
			expect(grants).toEqual({
				total: MAX_OAUTH_GRANTS,
				pending: MAX_OAUTH_GRANTS - 5,
			});
			expect(denied.total).toBe(MAX_OAUTH_GRANTS);
			expect(consentRows.total).toBe(0);
			expect(generation.generation).toBe(consent.generation + 1);
			expect(priorDenials).toEqual(
				Array.from({ length: 10 }, (_, index) => ({
					grant_id: `near-cap-grant-${String(index).padStart(5, "0")}`,
					at: 1_700_000_000_000 + index,
				})),
			);
		});

		for (const grantId of first?.grants ?? [])
			await stub.markGrantCleanupComplete(clientId, grantId);
		const retried = await stub.revokeClient(ownerSubject, clientId);
		expect(retried).toMatchObject({
			generation: consent.generation + 2,
			cleanupPending: true,
		});
		expect(retried?.grants).toEqual(
			Array.from(
				{ length: 16 },
				(_, index) => `near-cap-grant-${String(index + 21).padStart(5, "0")}`,
			),
		);
		await runInDurableObject(stub, (_instance, state) => {
			const pending = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM client_grants WHERE client_id = ? AND cleanup_pending = 1",
					clientId,
				)
				.toArray()[0] as { total: number };
			const retained = state.storage.sql
				.exec(
					"SELECT COUNT(*) AS total FROM revoked_grants WHERE grant_id LIKE 'near-cap-grant-%'",
				)
				.toArray()[0] as { total: number };
			expect(pending.total).toBe(MAX_OAUTH_GRANTS - 21);
			expect(retained.total).toBe(MAX_OAUTH_GRANTS);
		});
	});

	it("consumes browser-bound owner state once and denies another browser", async () => {
		const stub = env.VAULTS.get(
			env.VAULTS.idFromName(`csrf-${crypto.randomUUID()}`),
		);
		const state = crypto.randomUUID();
		const browser = crypto.randomUUID();
		await stub.storeOwnerCsrf({
			owner_subject: "synthetic-owner",
			browser_id: browser,
			state,
			expires_at: Date.now() + 60_000,
		});
		await expect(
			stub.consumeOwnerCsrf({
				owner_subject: "synthetic-owner",
				browser_id: crypto.randomUUID(),
				state,
				now: Date.now(),
			}),
		).resolves.toBe(false);
		await expect(
			stub.consumeOwnerCsrf({
				owner_subject: "synthetic-owner",
				browser_id: browser,
				state,
				now: Date.now(),
			}),
		).resolves.toBe(true);
		await expect(
			stub.consumeOwnerCsrf({
				owner_subject: "synthetic-owner",
				browser_id: browser,
				state,
				now: Date.now(),
			}),
		).resolves.toBe(false);
	});
});
