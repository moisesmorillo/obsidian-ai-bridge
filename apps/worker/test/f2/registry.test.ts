import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
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
