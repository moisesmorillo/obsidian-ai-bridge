import { env, runInDurableObject, SELF } from "cloudflare:test";
import {
	isCallToolResult,
	isJSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import {
	ChangesPageSchema,
	McpListNotesResultSchema,
	McpMutationOutputSchema,
	McpReadNoteResultSchema,
	McpToolErrorSchema,
	parseETag,
} from "@obsidian-ai-bridge/protocol";
import productionWorker from "@worker/index";
import {
	activeAdmissionStates,
	issueToken,
	postMcp,
} from "@worker/test-fixtures/f2-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Wire argument forms that cannot supply an append key, including an omitted field. */
const MISSING_APPEND_ARGUMENTS = [
	{ label: "omitted", input: undefined },
	{ label: "null", input: null },
	{ label: "string", input: "not-an-object" },
	{ label: "number", input: 42 },
	{ label: "boolean", input: false },
	{ label: "empty array", input: [] },
	{
		label: "array with a nested key",
		input: [{ idempotency_key: "array-item-key" }],
	},
] as const;

/** Send a tool call through production OAuth, MCP dispatch, and the real DO. */
function call(token: string, name: string, args: object) {
	return postMcp(token, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name, arguments: args },
	});
}

/** Decode SDK output without a test-only protocol type or an unchecked cast. */
async function toolResult(response: Response) {
	const message: unknown = await response.json();
	if (!isJSONRPCResultResponse(message) || !isCallToolResult(message.result))
		throw new Error(`Expected tool result: ${JSON.stringify(message)}`);
	expect(message.result.content).toEqual([]);
	return message.result;
}

/** Validate a successful mutation receipt with the public canonical schema. */
async function receipt(response: Response) {
	expect(response.status).toBe(200);
	const result = await toolResult(response);
	expect(result.isError).not.toBe(true);
	return McpMutationOutputSchema.parse(result.structuredContent);
}

/** Read current epoch through an authenticated public note-list request. */
async function epochFor(token: string): Promise<string> {
	const result = await toolResult(await call(token, "list_notes", {}));
	return McpListNotesResultSchema.parse(result.structuredContent).epoch;
}

/** Assert canonical failure identity, current epoch, and no second content representation. */
async function failure(response: Response, epoch: string, code: string) {
	const result = await toolResult(response);
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toMatchObject({ epoch, code });
	return McpToolErrorSchema.parse(result.structuredContent);
}

/** Read exact current content through the production MCP path. */
async function note(token: string, path: string) {
	const result = await toolResult(await call(token, "read_note", { path }));
	return McpReadNoteResultSchema.parse(result.structuredContent);
}

/** Capture immutable publication evidence without changing authoritative storage. */
async function published(path: string) {
	const vault = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
	return runInDurableObject(vault, (_instance, state) => ({
		revisions: state.storage.sql
			.exec(
				"SELECT rev, content, deleted, origin FROM revisions WHERE path = ? ORDER BY rev",
				path,
			)
			.toArray(),
		changes: state.storage.sql
			.exec(
				"SELECT seq, op, rev, origin FROM changes WHERE path = ? ORDER BY seq",
				path,
			)
			.toArray(),
		files: state.storage.sql
			.exec(
				"SELECT path, rev, content, deleted, size FROM files WHERE path = ?",
				path,
			)
			.toArray(),
		receipts: state.storage.sql
			.exec(
				"SELECT client_id, key, fingerprint, status, body FROM receipts WHERE json_extract(body, '$.path') = ? ORDER BY client_id, key",
				path,
			)
			.toArray(),
	}));
}

/** Create a deterministic wait with no timing assumption about production requests. */
function gate() {
	/** Release the deterministic wait after the test completes its authority change. */
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** Send through the production provider in this isolate so existing native RPC seams can pause work. */
function localCall(token: string, name: string, args: object) {
	return productionWorker.fetch(
		new Request("https://service.test/mcp", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		}),
		env,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("production MCP mutation safety", () => {
	it("preserves live-path collisions and tombstones without hidden publications", async () => {
		const { token, clientId } = await issueToken(
			"vault:read vault:write vault:delete",
		);
		const epoch = await epochFor(token);
		const path = "Notes/café.md";
		const created = await receipt(
			await call(token, "create_note", { path, epoch, content: "original" }),
		);
		expect(created.epoch).toBe(epoch);
		const before = await published(path);
		const duplicate = await failure(
			await call(token, "create_note", { path, epoch, content: "replacement" }),
			epoch,
			"path_occupied",
		);
		expect(duplicate).toHaveProperty("etag", created.etag);
		expect(duplicate).not.toHaveProperty("content");
		const normalized = await failure(
			await call(token, "create_note", {
				path: "Notes/cafe\u0301.md",
				epoch,
				content: "NFC duplicate",
			}),
			epoch,
			"path_occupied",
		);
		expect(normalized).toHaveProperty("etag", created.etag);
		const collision = await failure(
			await call(token, "create_note", {
				path: "notes/CAFÉ.md",
				epoch,
				content: "collision",
			}),
			epoch,
			"path_collision",
		);
		expect(collision).toHaveProperty("existing_path", path);
		expect(await published(path)).toEqual(before);
		expect((await published("notes/CAFÉ.md")).files).toEqual([]);
		await failure(
			await call(token, "delete_note", { path, etag: `"${epoch}.999"` }),
			epoch,
			"precondition_failed",
		);
		expect(await published(path)).toEqual(before);
		const deleted = await receipt(
			await call(token, "delete_note", { path, etag: created.etag }),
		);
		expect(parseETag(deleted.etag)).toEqual({ epoch, rev: 2 });
		const tombstone = await published(path);
		await failure(
			await call(token, "append_to_note", {
				path,
				epoch,
				text: "no resurrection",
				idempotency_key: "tombstone-append",
			}),
			epoch,
			"tombstone",
		);
		await failure(
			await call(token, "update_note", {
				path,
				etag: created.etag,
				content: "obsolete",
			}),
			epoch,
			"precondition_failed",
		);
		expect(await published(path)).toEqual(tombstone);
		expect(tombstone.files).toEqual([
			expect.objectContaining({ path, rev: 2, deleted: 1, content: null }),
		]);
		expect(tombstone.changes).toEqual([
			expect.objectContaining({ op: "put", rev: 1, origin: clientId }),
			expect.objectContaining({ op: "delete", rev: 2, origin: clientId }),
		]);
		const recreated = await receipt(
			await call(token, "create_note", { path, epoch, content: "recreated" }),
		);
		expect(parseETag(recreated.etag)).toEqual({ epoch, rev: 3 });
		const after = await published(path);
		expect(after.revisions).toEqual([
			...tombstone.revisions,
			expect.objectContaining({
				rev: 3,
				content: "recreated",
				deleted: 0,
				origin: clientId,
			}),
		]);
		expect(after.changes).toEqual([
			...tombstone.changes,
			expect.objectContaining({ op: "put", rev: 3, origin: clientId }),
		]);
		expect(await note(token, path)).toMatchObject({
			epoch,
			etag: recreated.etag,
			content: "recreated",
		});
	});

	it("rejects stale mutation epochs and malformed restore ETags without a publication", async () => {
		const { token } = await issueToken("vault:read vault:write vault:delete");
		const epoch = await epochFor(token);
		const path = "Agents/exact-epochs.md";
		const created = await receipt(
			await call(token, "create_note", { path, epoch, content: "protected" }),
		);
		const before = await published(path);
		const staleEpoch = `a${"0".repeat(31)}`;
		const staleTag = `"${staleEpoch}.1"`;
		for (const [name, args] of [
			["create_note", { path, epoch: staleEpoch, content: "stale" }],
			[
				"append_to_note",
				{
					path,
					epoch: staleEpoch,
					text: "stale",
					idempotency_key: "stale-epoch-append",
				},
			],
			["update_note", { path, etag: staleTag, content: "stale" }],
			["delete_note", { path, etag: staleTag }],
		] as const) {
			const result = await failure(
				await call(token, name, args),
				epoch,
				"epoch_mismatch",
			);
			expect(result.current_epoch).toBe(epoch);
			expect(result).not.toHaveProperty("content");
		}
		for (const args of [
			{ path, source_etag: "unquoted-invalid-tag", current_etag: created.etag },
			{ path, source_etag: created.etag, current_etag: "unquoted-invalid-tag" },
		])
			await failure(
				await call(token, "restore_note", args),
				epoch,
				"invalid_request",
			);
		expect(await published(path)).toEqual(before);
	});

	it("counts multibyte UTF-8 bytes and rejects oversized updates and append results atomically", async () => {
		const { token } = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/utf8.md";
		const content = "💖".repeat(250_000);
		expect(new TextEncoder().encode(content).byteLength).toBe(1_000_000);
		const created = await receipt(
			await call(token, "create_note", { path, epoch, content }),
		);
		const before = await published(path);
		expect(before.files[0]).toHaveProperty("size", 1_000_000);
		await failure(
			await call(token, "update_note", {
				path,
				etag: created.etag,
				content: `${content}é`,
			}),
			epoch,
			"text_too_large",
		);
		await failure(
			await call(token, "create_note", {
				path: "Agents/oversized.md",
				epoch,
				content: `${content}é`,
			}),
			epoch,
			"text_too_large",
		);
		await failure(
			await call(token, "append_to_note", {
				path,
				epoch,
				text: "é",
				idempotency_key: "utf8-result-overflow",
			}),
			epoch,
			"text_too_large",
		);
		await failure(
			await call(token, "append_to_note", {
				path,
				epoch,
				text: `${content}é`,
				idempotency_key: "utf8-payload-overflow",
			}),
			epoch,
			"text_too_large",
		);
		expect(await published(path)).toEqual(before);
		expect((await published("Agents/oversized.md")).files).toEqual([]);
		expect(await note(token, path)).toMatchObject({
			epoch,
			etag: created.etag,
			content,
		});
	});

	it("returns the specified 428 condition for a missing append key without a mutation", async () => {
		const { token } = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/missing-key.md";
		await receipt(
			await call(token, "create_note", { path, epoch, content: "base" }),
		);
		const before = await published(path);
		const response = await call(token, "append_to_note", {
			path,
			epoch,
			text: "extra",
		});
		const result = await toolResult(response);
		expect(response.status).toBe(428);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			epoch,
			code: "idempotency_key_required",
		});
		expect(await published(path)).toEqual(before);
	});

	it.each(MISSING_APPEND_ARGUMENTS)(
		"returns 428 for $label append arguments without a key",
		async ({ label, input }) => {
			const reader = await issueToken();
			const writer = await issueToken("vault:write");
			const epoch = await epochFor(reader.token);
			const path = `Agents/absent-append-${label.replaceAll(" ", "-")}.md`;
			await receipt(
				await call(reader.token, "create_note", {
					path,
					epoch,
					content: "OAB75-1 protected content",
				}),
			);
			const before = await published(path);
			const response = await postMcp(writer.token, {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "append_to_note",
					...(input === undefined ? {} : { arguments: input }),
				},
			});
			const result = await failure(response, epoch, "idempotency_key_required");
			expect(response.status).toBe(428);
			expect(result).not.toHaveProperty("content");
			expect(await published(path)).toEqual(before);
			expect(await activeAdmissionStates(writer.clientId)).toEqual([]);
		},
	);

	it.each([null, "", "short", "k".repeat(129), 42, false, {}])(
		"keeps an invalid supplied append key distinct from an absent key: %j",
		async (key) => {
			const { token } = await issueToken();
			const epoch = await epochFor(token);
			const response = await call(token, "append_to_note", {
				path: "Agents/invalid-supplied-key.md",
				epoch,
				text: "no publication",
				idempotency_key: key,
			});
			await failure(response, epoch, "invalid_request");
			expect(response.status).toBe(200);
			expect((await published("Agents/invalid-supplied-key.md")).files).toEqual(
				[],
			);
		},
	);

	it("checks identity, scope, and DO revocation before absent append arguments", async () => {
		const reader = await issueToken("vault:read");
		const writer = await issueToken();
		const revoked = await issueToken("vault:write");
		const epoch = await epochFor(reader.token);
		const path = "Agents/absent-append-authority.md";
		const content = "OAB75-1 protected content";
		await receipt(
			await call(writer.token, "create_note", { path, epoch, content }),
		);
		const before = await published(path);
		await env.VAULTS.get(env.VAULTS.idFromName("service.test")).revokeClient(
			"synthetic-owner",
			revoked.clientId,
		);
		for (const { input } of MISSING_APPEND_ARGUMENTS) {
			for (const [token, status, code] of [
				["", 401, "unauthorized"],
				[reader.token, 403, "forbidden_scope"],
				[revoked.token, 401, "revoked"],
			] as const) {
				const response = await postMcp(token, {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "append_to_note",
						...(input === undefined ? {} : { arguments: input }),
					},
				});
				const body = await response.text();
				expect(response.status).toBe(status);
				expect(response.headers.get("www-authenticate")).toContain("Bearer");
				if (code === "unauthorized") expect(body).toBe("");
				else expect(body).toContain(code);
				expect(body).not.toContain('"epoch"');
				expect(body).not.toContain(epoch);
				expect(body).not.toContain(content);
			}
		}
		expect(await published(path)).toEqual(before);
	});

	it("denies a missing append key before validation when the client lacks write scope", async () => {
		const { token } = await issueToken("vault:read");
		const epoch = await epochFor(token);
		const response = await call(token, "append_to_note", {
			path: "Agents/denied-key.md",
			epoch,
			text: "denied",
		});
		const body = await response.text();
		expect(response.status).toBe(403);
		expect(body).not.toContain(epoch);
	});

	it("uses operation-specific DO authority for write-only and delete-only clients", async () => {
		const reader = await issueToken("vault:read");
		const writer = await issueToken("vault:write");
		const deleter = await issueToken("vault:delete");
		const epoch = await epochFor(reader.token);
		const path = "Agents/scope-specific-authority.md";
		const created = await receipt(
			await call(writer.token, "create_note", {
				path,
				epoch,
				content: "first",
			}),
		);
		const updated = await receipt(
			await call(writer.token, "update_note", {
				path,
				etag: created.etag,
				content: "second",
			}),
		);
		const appended = await receipt(
			await call(writer.token, "append_to_note", {
				path,
				epoch,
				text: " third",
				idempotency_key: "write-only-append",
			}),
		);
		const restored = await receipt(
			await call(writer.token, "restore_note", {
				path,
				source_etag: created.etag,
				current_etag: appended.etag,
				as_conflict_copy: true,
			}),
		);
		const deleted = await receipt(
			await call(deleter.token, "delete_note", { path, etag: restored.etag }),
		);
		expect(
			[created, updated, appended, restored, deleted].map((result) =>
				parseETag(result.etag),
			),
		).toEqual([1, 2, 3, 4, 5].map((rev) => ({ epoch, rev })));
		const response = await SELF.fetch(
			`https://service.test/v1/changes?epoch=${epoch}&since=0`,
			{ headers: { authorization: `Bearer ${reader.token}` } },
		);
		expect(response.status).toBe(200);
		const feed = ChangesPageSchema.parse(await response.json());
		expect(feed.epoch).toBe(epoch);
		expect(
			feed.entries
				.filter((entry) => entry.path === path)
				.map((entry) => [entry.op, entry.etag, entry.origin]),
		).toEqual([
			["put", created.etag, writer.clientId],
			["put", updated.etag, writer.clientId],
			["put", appended.etag, writer.clientId],
			["put", restored.etag, writer.clientId],
			["delete", deleted.etag, deleter.clientId],
		]);
		const state = await published(path);
		expect(state.revisions).toHaveLength(5);
		expect(state.changes).toHaveLength(5);
	});

	it("replays a lost create receipt without replacing a later exact-revision edit", async () => {
		const { token, clientId } = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/lost-create.md";
		const args = {
			path,
			epoch,
			content: "original bytes",
			idempotency_key: "lost-create-key",
		};
		const lost = await localCall(token, "create_note", args);
		expect(lost.status).toBe(200);
		await lost.body?.cancel();
		const first = await receipt(await call(token, "create_note", args));
		expect(parseETag(first.etag)).toEqual({ epoch, rev: 1 });
		const current = await receipt(
			await call(token, "update_note", {
				path,
				etag: first.etag,
				content: "later bytes",
				idempotency_key: "next-update-key",
			}),
		);
		const before = await published(path);
		expect(await receipt(await call(token, "create_note", args))).toEqual(
			first,
		);
		await failure(
			await call(token, "create_note", { ...args, content: "changed bytes" }),
			epoch,
			"idempotency_mismatch",
		);
		await failure(
			await call(token, "create_note", {
				...args,
				path: "Agents/other-key-path.md",
			}),
			epoch,
			"idempotency_mismatch",
		);
		await failure(
			await call(token, "update_note", {
				path,
				etag: first.etag,
				content: "later bytes",
				idempotency_key: args.idempotency_key,
			}),
			epoch,
			"idempotency_mismatch",
		);
		expect(await published(path)).toEqual(before);
		expect(await note(token, path)).toMatchObject({
			epoch,
			etag: current.etag,
			content: "later bytes",
		});
		expect(before.revisions).toEqual([
			expect.objectContaining({
				rev: 1,
				content: args.content,
				origin: clientId,
			}),
			expect.objectContaining({
				rev: 2,
				content: "later bytes",
				origin: clientId,
			}),
		]);
		expect(before.changes.map((row) => row.rev)).toEqual([1, 2]);
	});

	it("replays a lost append response from an immutable client-scoped receipt after a later edit", async () => {
		const { token, clientId } = await issueToken();
		const other = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/lost-response.md";
		await receipt(
			await call(token, "create_note", { path, epoch, content: "base" }),
		);
		const args = {
			path,
			epoch,
			text: " first",
			idempotency_key: "lost-response-key",
		};
		const lost = await localCall(token, "append_to_note", args);
		expect(lost.status).toBe(200);
		await lost.body?.cancel();
		const committed = await published(path);
		expect(committed.revisions).toHaveLength(2);
		expect(committed.changes).toHaveLength(2);
		expect(committed.receipts).toEqual([
			expect.objectContaining({
				client_id: clientId,
				key: args.idempotency_key,
			}),
		]);
		const replay = await receipt(await call(token, "append_to_note", args));
		expect(parseETag(replay.etag)).toEqual({ epoch, rev: 2 });
		expect(await published(path)).toEqual(committed);
		const edited = await receipt(
			await call(token, "update_note", {
				path,
				etag: replay.etag,
				content: "later edit",
				idempotency_key: "later-edit-key",
			}),
		);
		const later = await published(path);
		expect(await receipt(await call(token, "append_to_note", args))).toEqual(
			replay,
		);
		await failure(
			await call(token, "append_to_note", { ...args, text: "changed" }),
			epoch,
			"idempotency_mismatch",
		);
		await failure(
			await call(token, "append_to_note", {
				...args,
				epoch: `a${"0".repeat(31)}`,
			}),
			epoch,
			"epoch_mismatch",
		);
		expect(await published(path)).toEqual(later);
		expect(await note(token, path)).toMatchObject({
			etag: edited.etag,
			content: "later edit",
		});
		const independent = await receipt(
			await call(other.token, "append_to_note", args),
		);
		expect(parseETag(independent.etag)).toEqual({ epoch, rev: 4 });
		const final = await published(path);
		expect(final.revisions).toEqual([
			expect.objectContaining({ rev: 1, content: "base", origin: clientId }),
			expect.objectContaining({
				rev: 2,
				content: "base first",
				origin: clientId,
			}),
			expect.objectContaining({
				rev: 3,
				content: "later edit",
				origin: clientId,
			}),
			expect.objectContaining({
				rev: 4,
				content: "later edit first",
				origin: other.clientId,
			}),
		]);
		expect(final.changes.map((row) => [row.rev, row.origin])).toEqual([
			[1, clientId],
			[2, clientId],
			[3, clientId],
			[4, other.clientId],
		]);
		expect(final.receipts).toHaveLength(3);
		expect(
			final.receipts
				.filter((row) => row.key === args.idempotency_key)
				.map((row) => row.client_id)
				.sort(),
		).toEqual([clientId, other.clientId].sort());
	});

	it("keeps restore retries conditional after another delete and preserves displaced live history", async () => {
		const { token, clientId } = await issueToken(
			"vault:read vault:write vault:delete",
		);
		const epoch = await epochFor(token);
		const path = "Agents/restore-retry.md";
		const first = await receipt(
			await call(token, "create_note", { path, epoch, content: "source" }),
		);
		const second = await receipt(
			await call(token, "update_note", {
				path,
				etag: first.etag,
				content: "displaced",
			}),
		);
		const before = await published(path);
		await failure(
			await call(token, "restore_note", {
				path,
				source_etag: first.etag,
				current_etag: second.etag,
			}),
			epoch,
			"path_occupied",
		);
		await failure(
			await call(token, "restore_note", {
				path,
				source_etag: `"a${"0".repeat(31)}.1"`,
				current_etag: second.etag,
				as_conflict_copy: true,
			}),
			epoch,
			"epoch_mismatch",
		);
		await failure(
			await call(token, "restore_note", {
				path,
				source_etag: `"a${"0".repeat(31)}.1"`,
				current_etag: `"a${"0".repeat(31)}.2"`,
				as_conflict_copy: true,
			}),
			epoch,
			"epoch_mismatch",
		);
		expect(await published(path)).toEqual(before);
		const args = {
			path,
			source_etag: first.etag,
			current_etag: second.etag,
			as_conflict_copy: true,
		};
		const lost = await localCall(token, "restore_note", args);
		expect(lost.status).toBe(200);
		await lost.body?.cancel();
		const restored = await note(token, path);
		expect(restored).toMatchObject({ epoch, content: "source" });
		expect(parseETag(restored.etag)).toEqual({ epoch, rev: 3 });
		const deleted = await receipt(
			await call(token, "delete_note", { path, etag: restored.etag }),
		);
		const tombstone = await published(path);
		const retry = await failure(
			await call(token, "restore_note", args),
			epoch,
			"precondition_failed",
		);
		expect(retry).toMatchObject({ etag: deleted.etag, deleted: true });
		expect(await published(path)).toEqual(tombstone);
		expect(tombstone.revisions).toEqual([
			expect.objectContaining({ rev: 1, content: "source", origin: clientId }),
			expect.objectContaining({
				rev: 2,
				content: "displaced",
				origin: clientId,
			}),
			expect.objectContaining({ rev: 3, content: "source", origin: clientId }),
			expect.objectContaining({ rev: 4, deleted: 1, origin: clientId }),
		]);
		expect(
			tombstone.changes.map((row) => [row.op, row.rev, row.origin]),
		).toEqual([
			["put", 1, clientId],
			["put", 2, clientId],
			["put", 3, clientId],
			["delete", 4, clientId],
		]);
		expect(tombstone.files).toEqual([
			expect.objectContaining({ path, rev: 4, deleted: 1 }),
		]);
	});

	it("returns complete conflict content only to clients with read scope", async () => {
		const reader = await issueToken();
		const writer = await issueToken("vault:write");
		const epoch = await epochFor(reader.token);
		const path = "Agents/conflict-content.md";
		const first = await receipt(
			await call(writer.token, "create_note", { path, epoch, content: "old" }),
		);
		const content = '💖\n"\\'.repeat(10_000);
		const current = await receipt(
			await call(writer.token, "update_note", {
				path,
				etag: first.etag,
				content,
			}),
		);
		const before = await published(path);
		for (const [client, canRead] of [
			[reader, true],
			[writer, false],
		] as const) {
			const result = await failure(
				await call(client.token, "update_note", {
					path,
					etag: first.etag,
					content: "obsolete",
				}),
				epoch,
				"precondition_failed",
			);
			expect(result).toMatchObject({
				etag: current.etag,
				deleted: false,
				hash: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			if (canRead) expect(result).toHaveProperty("content", content);
			else expect(result).not.toHaveProperty("content");
		}
		expect(await published(path)).toEqual(before);
	});

	it.each([
		"create_note",
		"update_note",
		"append_to_note",
		"restore_note",
		"delete_note",
	] as const)(
		"denies %s without its scope and after durable revocation",
		async (name) => {
			const allowed = await issueToken("vault:read vault:write vault:delete");
			const denied = await issueToken(
				name === "delete_note" ? "vault:write" : "vault:read vault:delete",
			);
			const epoch = await epochFor(allowed.token);
			const path = `Agents/scope-${name}.md`;
			const created = await receipt(
				await call(allowed.token, "create_note", {
					path,
					epoch,
					content: "protected",
				}),
			);
			const inputs = {
				create_note: { path, epoch, content: "forbidden" },
				update_note: { path, etag: created.etag, content: "forbidden" },
				append_to_note: {
					path,
					epoch,
					text: "forbidden",
					idempotency_key: `scope-key-${name}`,
				},
				restore_note: {
					path,
					source_etag: created.etag,
					current_etag: created.etag,
					as_conflict_copy: true,
				},
				delete_note: { path, etag: created.etag },
			};
			const args = inputs[name];
			const before = await published(path);
			const response = await call(denied.token, name, args);
			expect(response.status).toBe(403);
			expect(response.headers.get("www-authenticate")).toContain("Bearer");
			expect(await response.text()).not.toContain("protected");
			const vault = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
			await vault.revokeClient("synthetic-owner", allowed.clientId);
			const revoked = await call(allowed.token, name, args);
			expect(revoked.status).toBe(401);
			expect(await revoked.text()).toContain("revoked");
			expect(await published(path)).toEqual(before);
		},
	);

	it.each(["beginMutation", "commitText", "commitFileCommand"])(
		"rechecks durable revocation after the %s preparation seam",
		async (seam) => {
			const { token, clientId } = await issueToken();
			const epoch = await epochFor(token);
			const path = `Agents/revoke-${seam}.md`;
			const created = await receipt(
				await call(token, "create_note", { path, epoch, content: "protected" }),
			);
			const before = await published(path);
			const reached = gate();
			const resume = gate();
			const get = env.VAULTS.get.bind(env.VAULTS);
			const rawVault = get(env.VAULTS.idFromName("service.test"));
			vi.spyOn(env.VAULTS, "get").mockImplementation(
				(...args) =>
					new Proxy(get(...args), {
						/** Delay only the selected real RPC. The DO still supplies every authority decision. */
						get(target, property) {
							const method = Reflect.get(target, property, target);
							if (typeof method !== "function") return method;
							return async (...rpcArgs: unknown[]) => {
								if (property !== seam)
									return Reflect.apply(method, target, rpcArgs);
								if (seam === "beginMutation") {
									const result = await Reflect.apply(method, target, rpcArgs);
									reached.release();
									await resume.promise;
									return result;
								}
								reached.release();
								await resume.promise;
								return Reflect.apply(method, target, rpcArgs);
							};
						},
					}),
			);
			let retained: Awaited<ReturnType<typeof activeAdmissionStates>> = [];
			const pending =
				seam === "commitFileCommand"
					? localCall(token, "append_to_note", {
							path,
							epoch,
							text: "blocked",
							idempotency_key: "revoke-precommit-key",
						})
					: localCall(token, "update_note", {
							path,
							etag: created.etag,
							content: "blocked",
						});
			try {
				await reached.promise;
				retained = await runInDurableObject(rawVault, (_instance, state) =>
					state.storage.sql
						.exec(
							"SELECT id, state, expires_at FROM operation_admissions WHERE client_id = ?",
							clientId,
						)
						.toArray()
						.map((row) => JSON.stringify(row)),
				);
				expect(retained).toHaveLength(1);
				expect(JSON.parse(retained[0] ?? "null")).toMatchObject({
					state: seam === "beginMutation" ? "reserved" : "active",
					expires_at: expect.any(Number),
				});
				await get(env.VAULTS.idFromName("service.test")).revokeClient(
					"synthetic-owner",
					clientId,
				);
			} finally {
				resume.release();
			}
			const response = await pending;
			expect(response.status).toBe(401);
			expect(await response.text()).toContain("revoked");
			vi.restoreAllMocks();
			expect(await published(path)).toEqual(before);
			const after = await runInDurableObject(rawVault, (_instance, state) =>
				state.storage.sql
					.exec(
						"SELECT id, state, expires_at FROM operation_admissions WHERE client_id = ?",
						clientId,
					)
					.toArray()
					.map((row) => JSON.stringify(row)),
			);
			expect(after).toEqual(retained);
		},
	);

	it.each(["eof", "cancel"])(
		"keeps durable mutation failure ownership through response %s",
		async (completion) => {
			const { token, clientId } = await issueToken();
			const epoch = await epochFor(token);
			const path = `Agents/owner-${completion}.md`;
			const first = await receipt(
				await call(token, "create_note", { path, epoch, content: "base" }),
			);
			await receipt(
				await call(token, "update_note", {
					path,
					etag: first.etag,
					content: "💖".repeat(40_000),
				}),
			);
			const response = await localCall(token, "update_note", {
				path,
				etag: first.etag,
				content: "obsolete",
			});
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Expected owned mutation response");
			try {
				expect(response.status).toBe(200);
				expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
				const firstChunk = await reader.read();
				expect(firstChunk.done).toBe(false);
				expect(firstChunk.value?.byteLength).toBeLessThanOrEqual(65_536);
				expect(await activeAdmissionStates(clientId)).toEqual(["active"]);
				if (completion === "cancel") await reader.cancel();
				else {
					for (;;) {
						const item = await reader.read();
						if (item.done) break;
						expect(item.value.byteLength).toBeLessThanOrEqual(65_536);
					}
				}
				expect(await activeAdmissionStates(clientId)).toEqual([]);
			} finally {
				await reader.cancel();
			}
		},
	);

	it("scrubs a lost authority response and replays its committed receipt without losing response ownership", async () => {
		const { token, clientId } = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/lost-authority-response.md";
		const args = {
			path,
			epoch,
			content: "original",
			idempotency_key: "lost-authority-key",
		};
		const get = env.VAULTS.get.bind(env.VAULTS);
		const spy = vi.spyOn(env.VAULTS, "get").mockImplementation(
			(...getArgs) =>
				new Proxy(get(...getArgs), {
					/** Lose only the response after the real DO commits. No fake authority result replaces that commit. */
					get(target, property) {
						const method = Reflect.get(target, property, target);
						if (typeof method !== "function") return method;
						return async (...rpcArgs: unknown[]) => {
							const result = await Reflect.apply(method, target, rpcArgs);
							if (property === "commitText")
								throw new Error(
									`lost authority response ${token} unrelated private body`,
								);
							return result;
						};
					},
				}),
		);
		let response: Response;
		try {
			response = await localCall(token, "create_note", args);
		} finally {
			spy.mockRestore();
		}
		const result = await failure(response, epoch, "internal_error");
		const body = JSON.stringify(result);
		expect(body).not.toContain(token);
		expect(body).not.toContain("unrelated private body");
		expect(body).not.toContain("lost authority response");
		const committed = await published(path);
		expect(committed.revisions).toEqual([
			expect.objectContaining({
				rev: 1,
				content: "original",
				origin: clientId,
			}),
		]);
		expect(committed.changes).toHaveLength(1);
		expect(committed.receipts).toHaveLength(1);
		for (let retry = 0; retry < 4; retry += 1) {
			const replay = await receipt(await localCall(token, "create_note", args));
			expect(parseETag(replay.etag)).toEqual({ epoch, rev: 1 });
		}
		expect(await published(path)).toEqual(committed);
	});

	it("denies successful receipt replay after durable revocation without undoing the commit", async () => {
		const { token, clientId } = await issueToken();
		const epoch = await epochFor(token);
		const path = "Agents/revoked-receipt.md";
		await receipt(
			await call(token, "create_note", { path, epoch, content: "base" }),
		);
		const args = {
			path,
			epoch,
			text: " committed",
			idempotency_key: "revoked-replay-key",
		};
		await receipt(await call(token, "append_to_note", args));
		const before = await published(path);
		await env.VAULTS.get(env.VAULTS.idFromName("service.test")).revokeClient(
			"synthetic-owner",
			clientId,
		);
		const retry = await call(token, "append_to_note", args);
		expect(retry.status).toBe(401);
		expect(await retry.text()).toContain("revoked");
		expect(await published(path)).toEqual(before);
		expect(before.revisions).toHaveLength(2);
		expect(before.changes).toHaveLength(2);
	});
});
