import {
	type ClientRegistryGateway,
	type ProviderGrantCleanup,
	revokeClient,
} from "@worker/application/clients";
import { describe, expect, it } from "vitest";

/** Build a minimal registry with one durably denied grant for budget tests. */
function cleanupRegistry(calls: string[]): ClientRegistryGateway {
	return {
		/** Reject consent setup because this stub only exercises cleanup. */
		async beginClientConsent() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject grant registration because the test starts after durable denial. */
		async registerClientGrant() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject client listing because cleanup tests do not read owner pages. */
		async listClients() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject grant listing because cleanup tests assert direct cleanup effects. */
		async listClientGrants() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject rename calls because cleanup tests do not change client names. */
		async renameClient() {
			throw new Error("Not used by cleanup tests");
		},
		/** Record durable denial and expose one grant for provider cleanup. */
		async revokeClient() {
			calls.push("deny");
			return { generation: 2, cleanup_pending: false, grants: ["grant"] };
		},
		/** Record durable cleanup completion after provider cleanup succeeds. */
		async markGrantCleanupComplete() {
			calls.push("complete");
		},
		/** Reject CSRF writes because the cleanup use case does not create form state. */
		async storeOwnerCsrf() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject CSRF reads because the cleanup use case receives verified form state. */
		async consumeOwnerCsrf() {
			throw new Error("Not used by cleanup tests");
		},
	};
}

/** Build one cleanup step that consumes the four calls needed for both namespaces. */
function cleanupProvider(calls: string[]): ProviderGrantCleanup {
	return {
		minimumStepCalls: 4,
		/** Spend both namespace lists and grant deletes, then report completion. */
		async cleanupStep(_grantId, _ownerSubject, budget) {
			calls.push("step");
			budget.remainingCalls -= 4;
			return true;
		},
	};
}

describe("client revocation cleanup call reservation", () => {
	it("keeps cleanup pending when only four calls remain", async () => {
		const calls: string[] = [];
		const budget = { remainingCalls: 5 };
		const result = await revokeClient(
			cleanupRegistry(calls),
			cleanupProvider(calls),
			"synthetic-owner",
			"synthetic-client",
			budget,
		);
		expect(calls).toEqual(["deny"]);
		expect(result?.cleanup_pending).toBe(true);
		expect(budget.remainingCalls).toBe(4);
	});

	it("stops when an incomplete cleanup step makes no budget progress", async () => {
		const calls: string[] = [];
		const provider: ProviderGrantCleanup = {
			minimumStepCalls: 4,
			/** Return incomplete without spending calls to test the progress guard. */
			async cleanupStep() {
				calls.push("step");
				return false;
			},
		};
		const budget = { remainingCalls: 6 };
		const result = await revokeClient(
			cleanupRegistry(calls),
			provider,
			"synthetic-owner",
			"synthetic-client",
			budget,
		);
		expect(calls).toEqual(["deny", "step"]);
		expect(result?.cleanup_pending).toBe(true);
		expect(budget.remainingCalls).toBe(5);
	});

	it("reserves and spends the fifth call on durable completion", async () => {
		const calls: string[] = [];
		const budget = { remainingCalls: 6 };
		const result = await revokeClient(
			cleanupRegistry(calls),
			cleanupProvider(calls),
			"synthetic-owner",
			"synthetic-client",
			budget,
		);
		expect(calls).toEqual(["deny", "step", "complete"]);
		expect(result?.cleanup_pending).toBe(false);
		expect(budget.remainingCalls).toBe(0);
	});
});
