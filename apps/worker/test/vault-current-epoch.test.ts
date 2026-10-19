import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import { withTextStore } from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Verify metadata reads check policy and never create durable admission work. */
describe("Vault current epoch capability", () => {
	it("returns the epoch to an allowed scope without creating a reservation", async () => {
		await withTextStore(async ({ admissions, storage }) => {
			const writeOnly: AuthorizationContext = {
				client_id: "epoch-client",
				grant_id: "epoch-grant",
				scopes: ["vault:write"],
			};
			const result = await admissions.getCurrentEpoch(writeOnly, "put");
			expect(result).toEqual({
				ok: true,
				current_epoch: "0123456789abcdef0123456789abcdef",
			});
			expect(
				storage.sql.exec("SELECT id FROM operation_admissions").toArray(),
			).toHaveLength(0);
			expect(
				storage.sql.exec("SELECT * FROM mutation_claims").toArray(),
			).toHaveLength(0);
		});
	});

	it("returns scope and revocation failures without exposing epoch metadata", async () => {
		await withTextStore(async ({ admissions }) => {
			const context: AuthorizationContext = {
				client_id: "epoch-client",
				grant_id: "epoch-grant",
				scopes: ["vault:read"],
			};
			expect(await admissions.getCurrentEpoch(context, "put")).toEqual({
				ok: false,
				failure: { kind: "forbidden_scope" },
			});
			admissions.recordRevocation(context.grant_id);
			expect(
				await admissions.getCurrentEpoch(
					{ ...context, scopes: ["vault:write"] },
					"put",
				),
			).toEqual({ ok: false, failure: { kind: "revoked" } });
		});
	});
});
