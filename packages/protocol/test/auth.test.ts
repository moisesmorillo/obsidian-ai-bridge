import { OwnerClientSchema, OwnerGrantSchema } from "@vaultwire/protocol";
import { describe, expect, it } from "vitest";

describe("owner client authority schemas", () => {
	it("accepts durable active-grant counts and per-grant revocation", () => {
		expect(
			OwnerClientSchema.parse({
				client_id: "client-1",
				name: "Client",
				generation: 1,
				created_at: 1,
				last_seen_at: 2,
				grant_count: 2,
				active_grant_count: 1,
				cleanup_pending_count: 1,
				grants: [],
				grants_cursor: null,
			}),
		).toMatchObject({ grant_count: 2, active_grant_count: 1 });
		expect(
			OwnerGrantSchema.parse({
				grant_id: "grant-1",
				created_at: 1,
				revoked: true,
				cleanup_pending: false,
			}),
		).toMatchObject({ revoked: true, cleanup_pending: false });
	});

	it("rejects invalid active counts and non-boolean revocation state", () => {
		const client = {
			client_id: "client-1",
			name: "Client",
			generation: 1,
			created_at: 1,
			last_seen_at: null,
			grant_count: 1,
			active_grant_count: 2,
			cleanup_pending_count: 0,
			grants: [],
			grants_cursor: null,
		};
		expect(OwnerClientSchema.safeParse(client).success).toBe(false);
		expect(
			OwnerClientSchema.safeParse({
				...client,
				active_grant_count: 0,
				cleanup_pending_count: 2,
			}).success,
		).toBe(false);
		expect(
			OwnerGrantSchema.safeParse({
				grant_id: "grant-1",
				created_at: 1,
				revoked: "true",
				cleanup_pending: false,
			}).success,
		).toBe(false);
	});
});
