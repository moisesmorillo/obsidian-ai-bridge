import {
	type ClientRegistryGateway,
	type ProviderGrantCleanup,
	revokeClient,
} from "@worker/application/clients";
import { describe, expect, it } from "vitest";

/** Build a registry stub with pending grants that cleanup can retire across requests. */
function cleanupRegistry(
	calls: string[],
	pendingGrants: string[] = ["grant"],
): ClientRegistryGateway {
	return {
		/** Reject consent setup because this stub only exercises cleanup. */
		async beginClientConsent() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject grant registration because the test starts after durable denial. */
		async registerClientGrant() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject removal because these tests cover provider cleanup only. */
		async removeClient() {
			throw new Error("Not used by cleanup tests");
		},
		/** Reject stale cleanup because these tests do not render the console. */
		async sweepStaleClients() {
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
			return {
				generation: 2,
				cleanup_pending: false,
				grants: [...pendingGrants],
			};
		},
		/** Retire one pending grant after provider cleanup succeeds. */
		async markGrantCleanupComplete(_clientId, grantId) {
			calls.push("complete");
			const index = pendingGrants.indexOf(grantId);
			if (index >= 0) pendingGrants.splice(index, 1);
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

	it("resumes more than nine empty grants within each request budget", async () => {
		const calls: string[] = [];
		const pendingGrants = Array.from(
			{ length: 11 },
			(_unused, index) => `grant-${index + 1}`,
		);
		const registry = cleanupRegistry(calls, pendingGrants);
		const provider = cleanupProvider(calls);
		const firstBudget = { remainingCalls: 48 };
		firstBudget.remainingCalls -= 1;
		calls.push("csrf");
		const first = await revokeClient(
			registry,
			provider,
			"synthetic-owner",
			"synthetic-client",
			firstBudget,
		);
		expect(calls.filter((call) => call === "step")).toHaveLength(9);
		expect(calls.filter((call) => call === "complete")).toHaveLength(9);
		expect(pendingGrants).toEqual(["grant-10", "grant-11"]);
		expect(first?.cleanup_pending).toBe(true);
		expect(48 - firstBudget.remainingCalls).toBe(47);
		expect(firstBudget.remainingCalls).toBe(1);

		const secondBudget = { remainingCalls: 48 };
		secondBudget.remainingCalls -= 1;
		calls.push("csrf");
		const second = await revokeClient(
			registry,
			provider,
			"synthetic-owner",
			"synthetic-client",
			secondBudget,
		);
		expect(pendingGrants).toEqual([]);
		expect(second?.cleanup_pending).toBe(false);
		expect(48 - secondBudget.remainingCalls).toBe(12);
		expect(secondBudget.remainingCalls).toBe(36);
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
