import type {
	AdmissionCompletion,
	AdmissionResult,
	AuthorizationContext,
	SearchRequest,
	SearchResponse,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import type { SearchVaultGateway } from "@worker/application/search";
import type { Env } from "@worker/env";
import {
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { createSearchRouter } from "@worker/transport/search";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

/** Hold an operation until the test releases its completion barrier. */
function barrier<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Verify search output retains shared response ownership through EOF. */
describe("search response ownership", () => {
	it("releases search capacity before bounded preparation settlement", async () => {
		const settling = barrier<void>();
		const cleanup = barrier<void>();
		const finished: AdmissionCompletion[] = [];
		const gateway: SearchVaultGateway = {
			authorize: async (): Promise<AdmissionResult> => ({
				ok: true,
				ticket: { id: "1".repeat(32), expires_at: 60_000 },
			}),
			search: async (
				_identity: AuthorizationContext,
				_query: SearchRequest,
			): Promise<SearchResponse> => ({
				ok: false,
				failure: { kind: "revoked" },
			}),
			finishAdmission: async (_identity, _ticket, completion) => {
				finished.push(completion);
				settling.resolve();
				await cleanup.promise;
				return { ok: true };
			},
		};
		const worker = new Hono<{ Bindings: Env }>().route(
			"/",
			createSearchRouter(
				async () => ({
					client_id: "search",
					grant_id: "grant",
					scopes: ["vault:read"],
				}),
				() => gateway,
			),
		);
		const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
		const pending = worker.fetch(
			new Request("https://search.invalid/search?q=abc"),
			{} as Env,
		);
		let available: (() => void) | undefined;
		try {
			await settling.promise;
			available = tryAcquireReadSlot();
			const response = await Promise.race([
				pending,
				new Promise<undefined>((resolve) =>
					setTimeout(() => resolve(undefined), 6_500),
				),
			]);
			expect(available).toBeTypeOf("function");
			expect(response?.status).toBe(500);
			if (response)
				expect(await response.json()).toMatchObject({
					error: "internal_error",
				});
			expect(finished).toEqual(["settled"]);
		} finally {
			cleanup.resolve();
			available?.();
			for (const release of held) release?.();
		}
		await pending;
	}, 10_000);
	it("keeps the slot after the data chunk until the consumer requests EOF", async () => {
		const release = vi.fn();
		const finish = vi.fn(async () => ({ ok: true as const }));
		const response = ownedReadResponse(
			jsonReadSource(encodeJsonChunks({ results: [] })),
			{ finish },
			release,
		);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		let json = "";
		while (!json.endsWith("}")) {
			const data = await reader?.read();
			expect(data?.done).toBe(false);
			json += new TextDecoder().decode(data?.value);
		}
		expect(json).toBe('{"results":[]}');
		expect(release).not.toHaveBeenCalled();
		await reader?.read();
		expect(finish).toHaveBeenCalledWith("settled");
		expect(release).toHaveBeenCalledTimes(1);
	});
});
