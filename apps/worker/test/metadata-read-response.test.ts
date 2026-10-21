import type {
	AdmissionCompletion,
	AuthorizationContext,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { Env } from "@worker/env";
import { createReadRouter } from "@worker/transport/reads";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const identity: AuthorizationContext = {
	client_id: "metadata",
	grant_id: "grant",
	scopes: ["vault:read"],
};
/** Expose explicit RPC and cleanup barriers without elapsed-time ordering. */
function barrier<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Build native-shaped batches for all three metadata collections. */
function controlledGateway() {
	const state = { calls: 0, finished: [] as AdmissionCompletion[] };
	const started = barrier<void>();
	const release = barrier<void>();
	const gateway: ReadVaultGateway = {
		authorize: async () => ({
			ok: true,
			ticket: { id: "1".repeat(32), expires_at: 60_000 },
		}),
		finishAdmission: async (_identity, _ticket, completion) => {
			state.finished.push(completion);
			return { ok: true };
		},
		readVault: async () => ({
			ok: true,
			body: {
				epoch,
				head_seq: 130,
				counts: { live: 130, deleted: 0 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
			},
		}),
		readHistoryUpper: async () => ({
			ok: true,
			body: { epoch, head_seq: 130, upper_etag: `"${epoch}.130"` },
		}),
		readBatch: async (_identity, request) => {
			state.calls++;
			if (state.calls === 2) {
				started.resolve();
				await release.promise;
			}
			const rows = Array.from({ length: 65 }, (_, i) => ({
				path: `files/${i}.md`,
				rev: i + 1,
				hash: "a".repeat(64),
				size: 1,
				deleted: false,
				origin: "device",
				at: 1,
			}));
			if (request.collection === "history")
				return { ok: true, body: { collection: "history", rows } };
			if (request.collection === "manifest")
				return {
					ok: true,
					body: {
						collection: "manifest",
						rows: rows.map((row, i) => ({
							path: row.path,
							etag: `"${epoch}.1"`,
							hash: row.hash,
							size: row.size,
							deleted: false,
							kind: "text",
							large: false,
							seq: i + 1,
						})),
					},
				};
			return {
				ok: true,
				body: {
					collection: "changes",
					rows: rows.map((row, i) => ({
						seq: i + 1,
						op: "put",
						path: row.path,
						etag: `"${epoch}.1"`,
						hash: row.hash,
						origin: row.origin,
						at: 1,
					})),
				},
			};
		},
	};
	return { gateway, state, started, release };
}

describe("metadata HTTP response demand", () => {
	it("shares read capacity across router instances, clients, and vault hosts", async () => {
		const responses: Response[] = [];
		const fixture = controlledGateway();
		const app = (await import("hono")).Hono;
		try {
			for (let i = 0; i < 5; i++) {
				const worker = new app<{ Bindings: Env }>().route(
					"/v1",
					createReadRouter(
						async () => ({ ...identity, client_id: `client-${i}` }),
						() => fixture.gateway,
					),
				);
				const response = await worker.fetch(
					new Request(`https://host-${i}.invalid/v1/vault`),
					{} as Env,
				);
				expect(response.status).toBe(i === 4 ? 429 : 200);
				responses.push(response);
			}
			expect(fixture.state.finished).toEqual([]);
		} finally {
			for (const response of responses) await response.body?.cancel();
		}
		expect(fixture.state.finished).toEqual([
			"settled",
			"settled",
			"settled",
			"settled",
		]);
	});

	it.each([
		"/v1/manifest",
		"/v1/history/files/a.md",
		`/v1/changes?epoch=${epoch}&since=0`,
	])("joins a pending batch before cancellation releases %s", async (route) => {
		const fixture = controlledGateway();
		const router = createReadRouter(
			async () => identity,
			() => fixture.gateway,
		);
		const app = (await import("hono")).Hono;
		const worker = new app<{ Bindings: Env }>().route("/v1", router);
		const response = await worker.fetch(
			new Request(`https://metadata.invalid${route}`),
			{} as Env,
		);
		expect(response.status).toBe(200);
		expect(fixture.state.calls).toBe(1);
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		await reader.read();
		expect(fixture.state.calls).toBe(1);
		const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
		const drain = (async () => {
			while (!(await reader.read()).done) {
				/* Demand until the second RPC blocks. */
			}
		})();
		await fixture.started.promise;
		expect(fixture.state.calls).toBe(2);
		const cancelled = reader.cancel();
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(fixture.state.finished).toEqual([]);
		fixture.release.resolve();
		await Promise.all([drain, cancelled]);
		expect(fixture.state.calls).toBe(2);
		expect(fixture.state.finished).toEqual(["settled"]);
		const free = tryAcquireReadSlot();
		expect(free).toBeTypeOf("function");
		free?.();
		for (const release of held) release?.();
	});
	it.each([false, true])(
		"fails the stream rather than closing partial JSON after a later batch fault %s",
		async (unknown) => {
			const fixture = controlledGateway();
			const original = fixture.gateway.readBatch;
			fixture.gateway.readBatch = async (...args) => {
				if (fixture.state.calls === 1) {
					if (unknown) throw new Error("Lost batch RPC");
					return { ok: false, failure: { kind: "revoked" } };
				}
				return original(...args);
			};
			const app = (await import("hono")).Hono;
			const worker = new app<{ Bindings: Env }>().route(
				"/v1",
				createReadRouter(
					async () => identity,
					() => fixture.gateway,
				),
			);
			const response = await worker.fetch(
				new Request("https://metadata.invalid/v1/manifest"),
				{} as Env,
			);
			expect(response.status).toBe(200);
			await expect(response.json()).rejects.toThrow();
			expect(fixture.state.finished).toEqual([
				unknown ? "uncertain" : "settled",
			]);
		},
	);
});
