import { env, runInDurableObject } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	pathKey,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import type { SearchVaultGateway } from "@worker/application/search";
import { readSearch } from "@worker/application/search";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const context: AuthorizationContext = {
	client_id: "search-client",
	grant_id: "search-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};

/** Hold one operation at an explicit native RPC boundary until the test releases it. */
function barrier() {
	let release!: () => void;
	let arrive!: () => void;
	const reached = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { reached, held, arrive, release };
}

/** Hash exact UTF-8 text for real native mutation descriptors. */
async function hashText(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Publish a real conditional PUT through the Vault admission and mutation owners. */
async function putText(
	stub: ReturnType<typeof env.VAULTS.get>,
	path: string,
	content: string,
	revision: number | undefined,
	key: string,
): Promise<string> {
	const payload = new TextEncoder().encode(content);
	const intent = TextMutationIntentSchema.parse({
		op: "put",
		epoch,
		paths: [path],
		precondition:
			revision === undefined
				? { kind: "absent" }
				: { kind: "match", etag: formatETag(epoch, revision) },
		payload_hash: await hashText(content),
		size: payload.byteLength,
	});
	const idempotencyKey = IdempotencyKeySchema.parse(key);
	const reservation = await stub.beginMutation(
		context,
		{
			op: intent.op,
			epoch: intent.epoch,
			paths: intent.paths,
			precondition: intent.precondition,
		},
		idempotencyKey,
	);
	if (!reservation.ok)
		throw new Error(`PUT reservation failed: ${reservation.failure.kind}`);
	const authorized = await stub.authorize(
		context,
		intent,
		reservation.lease.admission_id,
	);
	if (!authorized.ok)
		throw new Error(`PUT authorization failed: ${authorized.failure.kind}`);
	const result = await stub.commitText(
		context,
		intent,
		authorized.ticket.id,
		content,
		idempotencyKey,
	);
	if (!result.ok) throw new Error(`PUT failed: ${result.failure.kind}`);
	return result.response.body.etag;
}

/** Publish an exact-revision tombstone through the real mutation authority. */
async function deleteText(
	stub: ReturnType<typeof env.VAULTS.get>,
	path: string,
	revision: number,
	key: string,
): Promise<void> {
	const idempotencyKey = IdempotencyKeySchema.parse(key);
	const intent = TextMutationIntentSchema.parse({
		op: "delete",
		epoch,
		paths: [path],
		precondition: { kind: "match", etag: formatETag(epoch, revision) },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	});
	const reservation = await stub.beginMutation(
		context,
		{
			op: intent.op,
			epoch: intent.epoch,
			paths: intent.paths,
			precondition: intent.precondition,
		},
		idempotencyKey,
	);
	if (!reservation.ok)
		throw new Error(`Delete reservation failed: ${reservation.failure.kind}`);
	const authorized = await stub.authorize(
		context,
		intent,
		reservation.lease.admission_id,
	);
	if (!authorized.ok)
		throw new Error(`Delete authorization failed: ${authorized.failure.kind}`);
	const result = await stub.commitText(
		context,
		intent,
		authorized.ticket.id,
		undefined,
		idempotencyKey,
	);
	if (!result.ok) throw new Error(`Delete failed: ${result.failure.kind}`);
}

/** Search through a fresh real ticket and finish it after the native response. */
async function searchNative(
	stub: ReturnType<typeof env.VAULTS.get>,
	query: string,
	limit = 20,
) {
	const authorized = await stub.authorize(context, {
		op: "read",
		paths: [],
		precondition: { kind: "none" },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	});
	if (!authorized.ok)
		throw new Error(`Search authorization failed: ${authorized.failure.kind}`);
	try {
		return await stub.search(context, { query, limit }, authorized.ticket.id);
	} finally {
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	}
}

/** Commit a real append, restore, or rename command through Vault admission. */
async function commitCommand(
	stub: ReturnType<typeof env.VAULTS.get>,
	command: ReturnType<typeof FileCommandSchema.parse>,
): Promise<string> {
	const key = IdempotencyKeySchema.parse(command.key);
	let admissionId: string;
	if (command.op === "rename") {
		if (command.intent.precondition.kind !== "match")
			throw new Error("Rename needs an exact source revision");
		const reservation = await stub.beginRenameSource(
			context,
			{
				path: command.intent.paths[0],
				if_match: command.intent.precondition.etag,
			},
			key,
		);
		if (!reservation.ok)
			throw new Error(`Rename reservation failed: ${reservation.failure.kind}`);
		admissionId = reservation.lease.admission_id;
	} else {
		const reservation = await stub.beginMutation(
			context,
			{
				op: command.op,
				epoch: command.intent.epoch,
				paths: command.intent.paths,
				precondition: command.intent.precondition,
			},
			key,
		);
		if (!reservation.ok)
			throw new Error(
				`Command reservation failed: ${reservation.failure.kind}`,
			);
		admissionId = reservation.lease.admission_id;
	}
	const authorized =
		command.op === "rename"
			? await stub.authorizeRenameSource(
					context,
					command.intent,
					admissionId,
					key,
				)
			: await stub.authorize(context, command.intent, admissionId);
	if (!authorized.ok)
		throw new Error(`Command authorization failed: ${authorized.failure.kind}`);
	const committed = await stub.commitFileCommand(
		context,
		command.intent,
		authorized.ticket.id,
		command,
		key,
	);
	if (!committed.ok)
		throw new Error(`File command failed: ${committed.failure.kind}`);
	return committed.response.body.etag;
}

/** Verify literal native FTS selection through the real SQLite Durable Object. */
describe("native vault search", () => {
	it("returns a bounded current Markdown result with exact epoch metadata", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, 15, 'text', ?, 0, 10, 'seed')",
				"notes/search.md",
				pathKey("notes/search.md"),
				"a".repeat(64),
				"café literal AND text",
			);
			state.storage.sql.exec(
				"INSERT INTO files_fts(path,content) VALUES (?, ?)",
				"notes/search.md",
				"café literal AND text",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '1' WHERE key = 'head_seq'",
			);
		});
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const response = await stub.search(
			context,
			{ query: "cafe", limit: 20 },
			authorized.ticket.id,
		);
		expect(response).toMatchObject({
			ok: true,
			body: {
				epoch,
				results: [
					{
						path: "notes/search.md",
						etag: `"${epoch}.1"`,
						snippet: expect.stringContaining("café"),
					},
				],
				indexed_files: 1,
				unindexed_large_files: 0,
			},
		});
		if (response.ok)
			expect(Number.isFinite(response.body.results[0]?.score)).toBe(true);
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});

	it("tracks append, rename across Markdown and Canvas, delete, recreate, and restore", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
		});
		const path = "notes/lifecycle.md";
		await putText(
			stub,
			path,
			"sourceword",
			undefined,
			"search-lifecycle-put-01",
		);
		const appendContent = " appendedword";
		const appendIntent = {
			op: "append" as const,
			epoch,
			paths: [path],
			precondition: { kind: "none" as const },
			payload_hash: await hashText(appendContent),
			size: new TextEncoder().encode(appendContent).byteLength,
		};
		await commitCommand(
			stub,
			FileCommandSchema.parse({
				op: "append",
				intent: appendIntent,
				content: appendContent,
				key: "search-lifecycle-append-01",
			}),
		);
		expect(await searchNative(stub, "appendedword")).toMatchObject({
			ok: true,
			body: { results: [{ path, etag: `"${epoch}.2"` }] },
		});

		const canvasPath = "notes/lifecycle.canvas";
		const renameCanvasBody = { to: canvasPath };
		const renameCanvasBytes = JSON.stringify(renameCanvasBody);
		await commitCommand(
			stub,
			FileCommandSchema.parse({
				op: "rename",
				intent: {
					op: "rename",
					epoch,
					paths: [path, canvasPath],
					precondition: { kind: "match", etag: formatETag(epoch, 2) },
					payload_hash: await hashText(renameCanvasBytes),
					size: new TextEncoder().encode(renameCanvasBytes).byteLength,
				},
				body: renameCanvasBody,
				key: "search-lifecycle-rename-canvas-01",
			}),
		);
		expect(await searchNative(stub, "appendedword")).toMatchObject({
			ok: true,
			body: { results: [], indexed_files: 0 },
		});

		const markdownPath = "notes/lifecycle-return.md";
		const renameBackBody = { to: markdownPath };
		const renameBackBytes = JSON.stringify(renameBackBody);
		await commitCommand(
			stub,
			FileCommandSchema.parse({
				op: "rename",
				intent: {
					op: "rename",
					epoch,
					paths: [canvasPath, markdownPath],
					precondition: { kind: "match", etag: formatETag(epoch, 1) },
					payload_hash: await hashText(renameBackBytes),
					size: new TextEncoder().encode(renameBackBytes).byteLength,
				},
				body: renameBackBody,
				key: "search-lifecycle-rename-markdown-01",
			}),
		);
		const renamed = await searchNative(stub, "appendedword");
		expect(renamed).toMatchObject({
			ok: true,
			body: { results: [{ path: markdownPath, etag: `"${epoch}.1"` }] },
		});

		await deleteText(stub, markdownPath, 1, "search-lifecycle-delete-01");
		await putText(
			stub,
			markdownPath,
			"recreatedword",
			2,
			"search-lifecycle-recreate-01",
		);
		expect(await searchNative(stub, "appendedword")).toMatchObject({
			ok: true,
			body: { results: [] },
		});
		expect(await searchNative(stub, "recreatedword")).toMatchObject({
			ok: true,
			body: { results: [{ path: markdownPath, etag: `"${epoch}.3"` }] },
		});

		const restorePath = "notes/lifecycle-restore.md";
		await putText(
			stub,
			restorePath,
			"restorableword",
			undefined,
			"search-lifecycle-restore-put-01",
		);
		await deleteText(
			stub,
			restorePath,
			1,
			"search-lifecycle-restore-delete-01",
		);
		const restoreBody = { source_rev: 1, as_conflict_copy: false };
		const restoreBytes = JSON.stringify(restoreBody);
		await commitCommand(
			stub,
			FileCommandSchema.parse({
				op: "restore",
				intent: {
					op: "restore",
					epoch,
					paths: [restorePath],
					precondition: { kind: "match", etag: formatETag(epoch, 2) },
					payload_hash: await hashText(restoreBytes),
					size: new TextEncoder().encode(restoreBytes).byteLength,
				},
				body: restoreBody,
				key: "search-lifecycle-restore-01",
			}),
		);
		expect(await searchNative(stub, "restorableword")).toMatchObject({
			ok: true,
			body: { results: [{ path: restorePath, etag: `"${epoch}.3"` }] },
		});
	});

	it.each([
		["revoked", { kind: "revoked" }],
		["scope", { kind: "forbidden_scope" }],
		["expired", { kind: "invalid_ticket" }],
		["foreign", { kind: "invalid_ticket" }],
		["old-epoch", { kind: "invalid_ticket" }],
	] as const)(
		"rechecks %s authority inside the native search",
		async (policy, failure) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				clearTestVault(state.storage);
				initializeVaultStorage(
					state.storage,
					() => epoch,
					() => 10_000,
				);
			});
			const authorized = await stub.authorize(context, {
				op: "read",
				paths: [],
				precondition: { kind: "none" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			expect(authorized.ok).toBe(true);
			if (!authorized.ok) return;
			const ticketId =
				policy === "foreign" ? "f".repeat(32) : authorized.ticket.id;
			await runInDurableObject(stub, (_instance, state) => {
				switch (policy) {
					case "revoked":
						state.storage.sql.exec(
							"INSERT INTO revoked_grants(grant_id, at) VALUES (?, 1)",
							context.grant_id,
						);
						break;
					case "expired":
						state.storage.sql.exec(
							"UPDATE operation_admissions SET expires_at = 0 WHERE id = ?",
							authorized.ticket.id,
						);
						break;
					case "old-epoch":
						state.storage.sql.exec(
							"UPDATE meta SET value = 'fedcba9876543210fedcba9876543210' WHERE key = 'epoch'",
						);
						break;
					case "scope":
					case "foreign":
						break;
				}
			});
			const searchContext =
				policy === "scope"
					? {
							...context,
							scopes: ["vault:write"] as AuthorizationContext["scopes"],
						}
					: context;
			expect(
				await stub.search(searchContext, { query: "abc", limit: 20 }, ticketId),
			).toEqual({ ok: false, failure });
		},
	);

	it("caps long combining-mark snippets before native RPC output", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
		});
		const content = `needle${"\u0301".repeat(1600)} tail`;
		await putText(
			stub,
			"notes/combining.md",
			content,
			undefined,
			"search-combining-put-01",
		);
		const response = await searchNative(stub, "needle");
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		const hit = response.body.results[0];
		expect(hit).toBeDefined();
		expect(Array.from(hit?.snippet ?? "").length).toBeLessThanOrEqual(1024);
		expect(hit?.snippet).not.toBe(content);
		expect(Object.keys(hit ?? {}).sort()).toEqual([
			"etag",
			"path",
			"score",
			"snippet",
		]);
	});

	it("orders equal native scores by binary path and applies 20 and 50 result limits", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			for (let index = 0; index < 55; index += 1) {
				const path = `notes/rank-${String(index).padStart(2, "0")}.md`;
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 14, 'text', 'ranking needle', 0, 10, 'seed')",
					path,
					pathKey(path),
					index + 1,
					"a".repeat(64),
				);
				state.storage.sql.exec(
					"INSERT INTO files_fts(path,content) VALUES (?, 'ranking needle')",
					path,
				);
			}
		});
		const twenty = await searchNative(stub, "needle", 20);
		const fifty = await searchNative(stub, "needle", 50);
		expect(twenty).toMatchObject({
			ok: true,
			body: { results: expect.any(Array), indexed_files: 55 },
		});
		if (!twenty.ok || !fifty.ok) return;
		expect(twenty.body.results).toHaveLength(20);
		expect(fifty.body.results).toHaveLength(50);
		const paths = fifty.body.results.map((hit) => hit.path);
		expect(paths).toEqual(
			[...paths].sort((left, right) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		);
		expect(
			fifty.body.results.every(
				(hit) => hit.score === fifty.body.results[0]?.score,
			),
		).toBe(true);
	});

	it("ranks repeated native phrase matches before less relevant rows", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			for (const [index, [path, content]] of (
				[
					["notes/rare.md", "needle once"],
					["notes/repeated.md", "needle needle needle needle"],
				] as const
			).entries()) {
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, ?, 'text', ?, 0, 10, 'seed')",
					path,
					pathKey(path),
					index + 1,
					"a".repeat(64),
					new TextEncoder().encode(content).byteLength,
					content,
				);
				state.storage.sql.exec(
					"INSERT INTO files_fts(path,content) VALUES (?, ?)",
					path,
					content,
				);
			}
		});
		const response = await searchNative(stub, "needle");
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.body.results.map((hit) => hit.path)).toEqual([
			"notes/repeated.md",
			"notes/rare.md",
		]);
		expect(response.body.results[0]?.score).toBeLessThan(
			response.body.results[1]?.score ?? Infinity,
		);
	});

	it("observes one committed state across a mutation at the search RPC boundary", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
		});
		const path = "notes/interleaved-search.md";
		await putText(
			stub,
			path,
			"oldstate searchable text",
			undefined,
			"search-interleave-put-01",
		);
		const gate = barrier();
		const gateway: SearchVaultGateway = {
			authorize: (readContext, intent) => stub.authorize(readContext, intent),
			finishAdmission: (readContext, ticketId, completion) =>
				stub.finishAdmission(readContext, ticketId, completion),
			search: async (readContext, request, ticketId) => {
				gate.arrive();
				await gate.held;
				return stub.search(readContext, request, ticketId);
			},
		};
		const pendingSearch = readSearch(gateway, context, {
			query: "newstate",
			limit: 20,
		});
		await gate.reached;
		const newEtag = await putText(
			stub,
			path,
			"newstate searchable text",
			1,
			"search-interleave-update-01",
		);
		gate.release();
		const outcome = await pendingSearch;
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.body).toMatchObject({
			epoch,
			results: [
				{ path, etag: newEtag, snippet: expect.stringContaining("newstate") },
			],
			indexed_files: 1,
			unindexed_large_files: 0,
		});
		await outcome.finish("settled");
		expect(await searchNative(stub, "oldstate")).toMatchObject({
			ok: true,
			body: { results: [], indexed_files: 1 },
		});
		expect(await searchNative(stub, "newstate")).toMatchObject({
			ok: true,
			body: { results: [{ path, etag: newEtag }], indexed_files: 1 },
		});
	});

	it("rolls back FTS results, ETags, coverage, and head after post-index failure", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
		});
		const path = "notes/rollback-search.md";
		await putText(
			stub,
			path,
			"stableword original text",
			undefined,
			"search-rollback-put-01",
		);
		const beforeSearch = await searchNative(stub, "stableword");
		const beforeHead = await runInDurableObject(stub, (_instance, state) =>
			Number(
				state.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'head_seq'")
					.toArray()[0]?.value,
			),
		);
		expect(beforeSearch).toMatchObject({
			ok: true,
			body: {
				results: [{ path, etag: `"${epoch}.1"` }],
				indexed_files: 1,
				unindexed_large_files: 0,
			},
		});

		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"CREATE TRIGGER reject_search_head AFTER UPDATE ON meta WHEN NEW.key = 'head_seq' BEGIN SELECT RAISE(ABORT, 'post-FTS failure'); END",
			);
		});
		await expect(
			putText(
				stub,
				path,
				"changedword replacement text",
				1,
				"search-rollback-update-01",
			),
		).rejects.toThrow("post-FTS failure");
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("DROP TRIGGER reject_search_head");
		});

		const afterSearch = await searchNative(stub, "stableword");
		const afterChangedQuery = await searchNative(stub, "changedword");
		const afterHead = await runInDurableObject(stub, (_instance, state) =>
			Number(
				state.storage.sql
					.exec("SELECT value FROM meta WHERE key = 'head_seq'")
					.toArray()[0]?.value,
			),
		);
		expect(afterSearch).toEqual(beforeSearch);
		expect(afterChangedQuery).toMatchObject({
			ok: true,
			body: { results: [], indexed_files: 1, unindexed_large_files: 0 },
		});
		expect(afterHead).toBe(beforeHead);
	});

	it("counts only live indexed Markdown and oversized Markdown blobs", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			initializeVaultStorage(
				state.storage,
				() => epoch,
				() => 10_000,
			);
			const rows = [
				["live.md", "text", 20, 0, "literal live match"],
				["canvas.canvas", "text", 20, 0, "literal canvas match"],
				["large.md", "blob", 1_500_000, 0, null],
				["gone.md", "text", 0, 1, null],
				["file.txt", "blob", 1_500_000, 0, null],
			] as const;
			for (const [path, kind, size, deleted, content] of rows) {
				state.storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, 10, 'seed')",
					path,
					pathKey(path),
					deleted ? "" : "a".repeat(64),
					size,
					kind,
					content,
					deleted,
				);
				if (!deleted && kind === "text" && path.endsWith(".md"))
					state.storage.sql.exec(
						"INSERT INTO files_fts(path,content) VALUES (?, ?)",
						path,
						content,
					);
			}
		});
		const authorized = await stub.authorize(context, {
			op: "read",
			paths: [],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		expect(authorized.ok).toBe(true);
		if (!authorized.ok) return;
		const response = await stub.search(
			context,
			{ query: "literal", limit: 20 },
			authorized.ticket.id,
		);
		expect(response).toMatchObject({
			ok: true,
			body: {
				results: [{ path: "live.md" }],
				indexed_files: 1,
				unindexed_large_files: 1,
			},
		});
		await stub.finishAdmission(context, authorized.ticket.id, "settled");
	});
});
