import type {
	AuthorizationContext,
	SearchResponse,
} from "@obsidian-ai-bridge/protocol";
import { EMPTY_PAYLOAD_HASH } from "@obsidian-ai-bridge/protocol";
import type { SearchVaultGateway } from "@worker/application/search";
import { readSearch } from "@worker/application/search";
import { describe, expect, it, vi } from "vitest";

const context: AuthorizationContext = {
	client_id: "app-search",
	grant_id: "app-search-grant",
	scopes: ["vault:read"],
};
const body = {
	epoch: "0123456789abcdef0123456789abcdef",
	results: [],
	indexed_files: 0,
	unindexed_large_files: 0,
};

/** Build the smallest gateway that observes search authorization and settlement. */
function makeGateway(response: SearchResponse) {
	const authorize = vi.fn(async () => ({
		ok: true as const,
		ticket: { id: "ticket" },
	}));
	const search = vi.fn(async () => response);
	const finishAdmission = vi.fn(async () => ({ ok: true as const }));
	const gateway = {
		authorize,
		search,
		finishAdmission,
	} as unknown as SearchVaultGateway;
	return { gateway, authorize, search, finishAdmission };
}

describe("application search", () => {
	it("uses one body-free ticket and returns response ownership", async () => {
		const observed = makeGateway({ ok: true, body });
		const outcome = await readSearch(observed.gateway, context, {
			query: "abc",
			limit: 20,
		});
		expect(observed.authorize).toHaveBeenCalledWith(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(observed.search).toHaveBeenCalledWith(
			context,
			{ query: "abc", limit: 20 },
			"ticket",
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) await outcome.finish("settled");
		expect(observed.finishAdmission).toHaveBeenCalledTimes(1);
	});

	it("does not authorize after a pre-aborted request", async () => {
		const observed = makeGateway({ ok: true, body });
		const controller = new AbortController();
		controller.abort();
		await expect(
			readSearch(
				observed.gateway,
				context,
				{ query: "abc", limit: 20 },
				controller.signal,
			),
		).rejects.toThrow();
		expect(observed.authorize).not.toHaveBeenCalled();
	});

	it("does not start search after authorization completes following abort", async () => {
		const observed = makeGateway({ ok: true, body });
		let authorize: (() => void) | undefined;
		observed.authorize.mockImplementation(
			() =>
				new Promise<{ ok: true; ticket: { id: string } }>((resolve) => {
					authorize = () => resolve({ ok: true, ticket: { id: "ticket" } });
				}),
		);
		const controller = new AbortController();
		const pending = readSearch(
			observed.gateway,
			context,
			{ query: "abc", limit: 20 },
			controller.signal,
		);
		controller.abort();
		authorize?.();
		await expect(pending).rejects.toThrow();
		expect(observed.search).not.toHaveBeenCalled();
		expect(observed.finishAdmission).toHaveBeenCalledWith(
			context,
			"ticket",
			"settled",
		);
	});

	it("joins a started native search before settling an aborted request", async () => {
		const observed = makeGateway({ ok: true, body });
		let markStarted!: () => void;
		let releaseSearch!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const held = new Promise<void>((resolve) => {
			releaseSearch = resolve;
		});
		observed.search.mockImplementation(async () => {
			markStarted();
			await held;
			return { ok: true, body };
		});
		const controller = new AbortController();
		const pending = readSearch(
			observed.gateway,
			context,
			{ query: "abc", limit: 20 },
			controller.signal,
		);
		await started;
		controller.abort();
		releaseSearch();
		await expect(pending).rejects.toThrow();
		expect(observed.finishAdmission).toHaveBeenCalledWith(
			context,
			"ticket",
			"settled",
		);
	});

	it("retains unknown search outcomes instead of settling their tickets", async () => {
		const observed = makeGateway({ ok: true, body });
		observed.search.mockRejectedValue(new Error("uncertain RPC outcome"));
		await expect(
			readSearch(observed.gateway, context, { query: "abc", limit: 20 }),
		).rejects.toThrow("uncertain RPC outcome");
		expect(observed.finishAdmission).not.toHaveBeenCalled();
	});

	it("settles a canonical native policy failure", async () => {
		const observed = makeGateway({ ok: false, failure: { kind: "revoked" } });
		await expect(
			readSearch(observed.gateway, context, { query: "abc", limit: 20 }),
		).resolves.toEqual({
			ok: false,
			failure: { kind: "revoked" },
		});
		expect(observed.finishAdmission).toHaveBeenCalledWith(
			context,
			"ticket",
			"settled",
		);
	});
});
