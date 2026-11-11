import { env, runInDurableObject } from "cloudflare:test";
import {
	isCallToolResult,
	isJSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import type { AuthorizationContext } from "@vaultwire/protocol";
import {
	McpMutationOutputSchema,
	McpToolErrorSchema,
	MutationSuccessSchema,
} from "@vaultwire/protocol";
import {
	admissionByteSnapshot,
	MCP_ADMISSION_WAIT_MS,
} from "@worker/application/admission-budget";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import { readSlotCapacitySnapshot } from "@worker/application/read-budget";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { TEXT_FIXTURE_EPOCH } from "@worker/test-fixtures/text-files";
import { createWorker } from "@worker/transport/worker";
import { afterEach, describe, expect, it, vi } from "vitest";

/** One immutable synthetic migration operation, reused only after explicit admission refusal. */
interface MigrationOperation {
	name: string;
	args: object;
}

/** Test-only timer observation retains handles, never request data. */
function observeTimers() {
	const active = new Set<Parameters<typeof clearTimeout>[0]>();
	const start = globalThis.setTimeout;
	const stop = globalThis.clearTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(
		(callback, delay, ...args) => {
			const handle = start(() => {
				active.delete(handle);
				callback(...args);
			}, delay);
			active.add(handle);
			return handle;
		},
	);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
		active.delete(handle);
		stop(handle);
	});
	return active;
}

/** Use a distinct device identity while MCP keeps its existing authorization contract. */
async function identity(request: Request): Promise<AuthorizationContext> {
	const client = request.headers.get("x-test-device")
		? "migration-device"
		: "migration-agent";
	return {
		client_id: client,
		grant_id: `${client}-grant`,
		scopes: ["vault:read", "vault:write"],
	};
}

/** Create the real HTTP router with native SQLite and R2 in isolated test bindings. */
async function fixture() {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("migration.invalid"));
	await runInDurableObject(stub, (_instance, state) => {
		clearTestVault(state.storage);
		state.storage.sql.exec("PRAGMA foreign_keys = ON");
		initializeVaultStorage(
			state.storage,
			() => TEXT_FIXTURE_EPOCH,
			() => Date.now(),
		);
	});
	const gateway = {
		getCurrentEpoch: (...args: Parameters<typeof stub.getCurrentEpoch>) =>
			stub.getCurrentEpoch(...args),
		beginMutation: (...args: Parameters<typeof stub.beginMutation>) =>
			stub.beginMutation(...args),
		authorize: (...args: Parameters<typeof stub.authorize>) =>
			stub.authorize(...args),
		commitText: (...args: Parameters<typeof stub.commitText>) =>
			stub.commitText(...args),
		authorizeBlob: (...args: Parameters<typeof stub.authorizeBlob>) =>
			stub.authorizeBlob(...args),
		commitBlob: (...args: Parameters<typeof stub.commitBlob>) =>
			stub.commitBlob(...args),
		readBlobMetadata: (...args: Parameters<typeof stub.readBlobMetadata>) =>
			stub.readBlobMetadata(...args),
		finishAdmission: (...args: Parameters<typeof stub.finishAdmission>) =>
			stub.finishAdmission(...args),
		readText: (...args: Parameters<typeof stub.readText>) =>
			stub.readText(...args),
		beginRenameSource: (...args: Parameters<typeof stub.beginRenameSource>) =>
			stub.beginRenameSource(...args),
		authorizeRenameSource: (
			...args: Parameters<typeof stub.authorizeRenameSource>
		) => stub.authorizeRenameSource(...args),
		commitFileCommand: (...args: Parameters<typeof stub.commitFileCommand>) =>
			stub.commitFileCommand(...args),
		readHistory: (...args: Parameters<typeof stub.readHistory>) =>
			stub.readHistory(...args),
		readVault: (...args: Parameters<typeof stub.readVault>) =>
			stub.readVault(...args),
		readHistoryUpper: (...args: Parameters<typeof stub.readHistoryUpper>) =>
			stub.readHistoryUpper(...args),
		readBatch: (...args: Parameters<typeof stub.readBatch>) =>
			stub.readBatch(...args),
		search: (...args: Parameters<typeof stub.search>) => stub.search(...args),
	};
	const worker = createWorker(
		identity,
		() => gateway,
		() => new R2BlobStore(env.R2_BUCKET),
	);
	return { worker, stub };
}

/** Demand bytes only after production MCP admission accepts this request. */
function requestFor(operation: MigrationOperation, id: number) {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: operation.name, arguments: operation.args },
		}),
	);
	let reads = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			type: "bytes",
			/** Transfer the small synthetic envelope on its first admitted read. */
			pull(controller) {
				reads++;
				controller.enqueue(bytes);
				controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		request: new Request("https://migration.invalid/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"content-length": String(bytes.length),
			},
			body,
		}),
		reads: () => reads,
	};
}

/**
 * Extra time in milliseconds that one request may take after the MCP admission wait.
 * It covers the operation work, the response, and timer jitter on shared CI runners.
 * The spec bounds only the admission wait, so the test bound is the wait plus this margin.
 */
const RESPONSE_MARGIN_MS = 1_000;

/** Fail on uncertain results. Only explicit admission refusal returns false to the fixture retry driver. */
async function runOperation(
	worker: Awaited<ReturnType<typeof fixture>>["worker"],
	operation: MigrationOperation,
	id: number,
) {
	const input = requestFor(operation, id);
	const started = Date.now();
	const response = await worker.fetch(input.request, env);
	expect(Date.now() - started).toBeLessThanOrEqual(
		MCP_ADMISSION_WAIT_MS + RESPONSE_MARGIN_MS,
	);
	if (response.status === 429) {
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			2,
		);
		expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
		expect(input.reads()).toBe(0);
		await response.text();
		return false;
	}
	expect(response.status).toBe(200);
	const message: unknown = await response.json();
	if (!isJSONRPCResultResponse(message) || !isCallToolResult(message.result))
		throw new Error("Expected a tool result");
	if (message.result.isError) {
		const failure = McpToolErrorSchema.parse(message.result.structuredContent);
		expect(failure.code).toBe("admission_limited");
		return false;
	}
	if (["create_note", "update_note", "append_to_note"].includes(operation.name))
		McpMutationOutputSchema.parse(message.result.structuredContent);
	return true;
}

/** Exercise both device metadata paths while each batch of MCP calls runs. */
async function deviceRead(
	worker: Awaited<ReturnType<typeof fixture>>["worker"],
) {
	for (const route of ["vault", "manifest"]) {
		const response = await worker.fetch(
			new Request(`https://migration.invalid/v1/${route}`, {
				headers: { "x-test-device": "true" },
			}),
			env,
		);
		expect(response.status).toBe(200);
		const body: unknown = await response.json();
		expect(body).toHaveProperty("epoch", TEXT_FIXTURE_EPOCH);
	}
}

afterEach(() => vi.restoreAllMocks());

describe("synthetic Linear migration admission", () => {
	it.each(["waves30", "spike300"] as const)(
		"completes 300 mixed operations with device reads: %s",
		async (schedule) => {
			const { worker, stub } = await fixture();
			const etags: string[] = [];
			for (let index = 0; index < 120; index++) {
				const response = await worker.fetch(
					new Request(
						`https://migration.invalid/v1/files/Agents/seed-${index}.md`,
						{
							method: "PUT",
							headers: {
								"if-none-match": "*",
								"x-vault-epoch": TEXT_FIXTURE_EPOCH,
							},
							body: "Synthetic task note\n",
						},
					),
					env,
				);
				expect(response.status).toBe(201);
				etags.push(MutationSuccessSchema.parse(await response.json()).etag);
			}
			const operations: MigrationOperation[] = Array.from(
				{ length: 300 },
				(_, index) => {
					const note = Math.floor(index / 5);
					switch (index % 5) {
						case 0:
							return {
								name: "create_note",
								args: {
									path: `Agents/new-${note}.md`,
									epoch: TEXT_FIXTURE_EPOCH,
									content: `Synthetic task ${note}\n`,
								},
							};
						case 1:
							return {
								name: "update_note",
								args: {
									path: `Agents/seed-${note}.md`,
									etag: etags[note],
									content: `Updated synthetic task ${note}\n`,
								},
							};
						case 2:
							return {
								name: "append_to_note",
								args: {
									path: `Agents/seed-${note + 60}.md`,
									epoch: TEXT_FIXTURE_EPOCH,
									text: `Append task ${note}\n`,
									idempotency_key: `migration-append-${note}`,
								},
							};
						case 3:
							return { name: "list_notes", args: { prefix: "Agents/" } };
						default:
							return {
								name: "search_notes",
								args: { query: "Synthetic", limit: 5 },
							};
					}
				},
			);
			const timers = observeTimers();
			let refusals = 0;
			let completed = 0;
			let deviceReads = 0;
			const waveSize = schedule === "waves30" ? 30 : 300;
			for (let offset = 0; offset < operations.length; offset += waveSize) {
				let remaining = operations.slice(offset, offset + waveSize);
				for (let round = 0; remaining.length > 0 && round < 20; round++) {
					const calls = remaining.map((operation, index) =>
						runOperation(worker, operation, offset + index),
					);
					const [accepted] = await Promise.all([
						Promise.all(calls),
						deviceRead(worker),
					]);
					deviceReads += 2;
					completed += accepted.filter(Boolean).length;
					refusals += accepted.filter((value) => !value).length;
					remaining = remaining.filter((_, index) => !accepted[index]);
					expect(
						admissionByteSnapshot().queued_mcp_requests,
					).toBeLessThanOrEqual(30);
				}
				expect(remaining).toEqual([]);
			}
			expect(completed).toBe(300);
			if (schedule === "spike300") expect(refusals).toBeGreaterThan(0);
			else expect(refusals).toBe(0);
			expect(deviceReads).toBeGreaterThanOrEqual(
				schedule === "waves30" ? 20 : 2,
			);
			const stored = await runInDurableObject(stub, (_instance, state) => ({
				files: state.storage.sql
					.exec("SELECT path, rev, content FROM files ORDER BY path")
					.toArray(),
				receipts: state.storage.sql
					.exec("SELECT key FROM receipts WHERE key LIKE 'migration-append-%'")
					.toArray(),
				admissions: state.storage.sql
					.exec("SELECT state FROM operation_admissions")
					.toArray(),
			}));
			expect(stored.files).toHaveLength(180);
			expect(stored.receipts).toHaveLength(60);
			expect(stored.admissions).toEqual([]);
			for (let index = 0; index < 60; index++) {
				expect(
					stored.files.find(
						(row) => row.path === `Agents/seed-${index + 60}.md`,
					),
				).toMatchObject({
					rev: 2,
					content: `Synthetic task note\nAppend task ${index}\n`,
				});
				expect(
					stored.files.find((row) => row.path === `Agents/seed-${index}.md`),
				).toMatchObject({
					rev: 2,
					content: `Updated synthetic task ${index}\n`,
				});
			}
			expect(admissionByteSnapshot()).toEqual({
				shared_bytes: 0,
				rest_read_bytes: 0,
				active_reservations: 0,
				queued_mcp_requests: 0,
			});
			expect(readSlotCapacitySnapshot().active_slots).toBe(0);
			const capacity = Array.from({ length: 8 }, () => tryAcquireBodySlot());
			try {
				expect(capacity.every(Boolean)).toBe(true);
			} finally {
				for (const release of capacity) release?.();
			}
			expect(timers.size).toBe(0);
		},
		60_000,
	);
});
