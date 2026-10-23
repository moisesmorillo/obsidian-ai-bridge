import { env, runInDurableObject } from "cloudflare:test";
import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	type FileCommand,
	FileCommandSchema,
	formatETag,
	IdempotencyKeySchema,
	pathKey,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	openChangesRead,
	openManifestRead,
	type ReadVaultGateway,
} from "@worker/application/reads";
import { prepareTextPayload } from "@worker/application/text-payload";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const context: AuthorizationContext = {
	client_id: "read-interleave-client",
	grant_id: "read-interleave-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};
const hash = "a".repeat(64);

/** Hash exact UTF-8 bytes for native command request identities. */
async function hashBytes(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Seed ordered live rows through a real Durable Object SQLite storage handle. */
async function seedRows(
	stub: ReturnType<typeof env.VAULTS.get>,
	paths: string[],
): Promise<void> {
	await runInDurableObject(stub, async (_instance, state) => {
		clearTestVault(state.storage);
		initializeVaultStorage(
			state.storage,
			() => epoch,
			() => 10_000,
		);
		for (const [index, path] of paths.entries()) {
			const seq = index + 1;
			state.storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, ?, ?, 4, 'text', 'seed', 0, 10000, 'fixture')",
				path,
				pathKey(path),
				seq,
				hash,
			);
			state.storage.sql.exec(
				"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, 1, ?, 4, 'text', 'seed', 0, 'fixture', 10000)",
				path,
				hash,
			);
			state.storage.sql.exec(
				"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, 'put', ?, 1, ?, 'fixture', 10000)",
				seq,
				path,
				hash,
			);
		}
		state.storage.sql.exec(
			"UPDATE meta SET value = ? WHERE key = 'head_seq'",
			String(paths.length),
		);
	});
}

/** Route application reads through real Durable Object RPC methods and record each method start. */
function readGateway(
	stub: ReturnType<typeof env.VAULTS.get>,
	recordCall: (method: string) => void = () => {},
): ReadVaultGateway {
	return {
		authorize: (readContext, intent) => {
			recordCall("authorize");
			return stub.authorize(readContext, intent);
		},
		finishAdmission: (readContext, ticketId, completion) => {
			recordCall("finishAdmission");
			return stub.finishAdmission(readContext, ticketId, completion);
		},
		readVault: (readContext, admissionId) => {
			recordCall("readVault");
			return stub.readVault(readContext, admissionId);
		},
		readHistoryUpper: (readContext, admissionId, path) => {
			recordCall("readHistoryUpper");
			return stub.readHistoryUpper(readContext, admissionId, path);
		},
		readBatch: (readContext, request, admissionId) => {
			recordCall("readBatch");
			return stub.readBatch(readContext, request, admissionId);
		},
	};
}

/** Reserve capacity, authorize an exact mutation, then publish through Vault RPC. */
async function commitText(
	stub: ReturnType<typeof env.VAULTS.get>,
	intent: ReturnType<typeof TextMutationIntentSchema.parse>,
	content: string | undefined,
	key: string,
): Promise<void> {
	const descriptor = {
		op: intent.op,
		epoch: intent.epoch,
		paths: intent.paths,
		precondition: intent.precondition,
	};
	const reservation = await stub.beginMutation(
		context,
		descriptor,
		IdempotencyKeySchema.parse(key),
	);
	if (!reservation.ok)
		throw new Error(`Mutation reservation failed: ${reservation.failure.kind}`);
	const authorized = await stub.authorize(
		context,
		intent,
		reservation.lease.admission_id,
	);
	if (!authorized.ok)
		throw new Error(
			`Mutation authorization failed: ${authorized.failure.kind}`,
		);
	const result = await stub.commitText(
		context,
		intent,
		authorized.ticket.id,
		content,
		key,
	);
	if (!result.ok)
		throw new Error(`Text mutation failed: ${result.failure.kind}`);
}

/** Authorize and publish one immutable file command through Vault RPC. */
async function commitCommand(
	stub: ReturnType<typeof env.VAULTS.get>,
	command: FileCommand,
): Promise<void> {
	const key =
		command.key === undefined
			? undefined
			: IdempotencyKeySchema.parse(command.key);
	let admissionId: string;
	if (command.op === "rename") {
		if (command.intent.precondition.kind !== "match")
			throw new Error("Rename command needs its observed source ETag");
		const reservation = await stub.beginRenameSource(
			context,
			{
				path: command.intent.paths[0],
				if_match: command.intent.precondition.etag,
			},
			key,
		);
		if (!reservation.ok)
			throw new Error(
				`Command reservation failed: ${reservation.failure.kind}`,
			);
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
	const result = await stub.commitFileCommand(
		context,
		command.intent,
		authorized.ticket.id,
		command,
		key,
	);
	if (!result.ok)
		throw new Error(`File command failed: ${result.failure.kind}`);
}

/** Build an exact-match delete intent with an empty body identity. */
function deleteIntent(path: string, revision: number) {
	return TextMutationIntentSchema.parse({
		op: "delete",
		epoch,
		paths: [path],
		precondition: { kind: "match", etag: formatETag(epoch, revision) },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	});
}

/** Build a PUT intent from the exact content bytes and observed precondition. */
async function putIntent(path: string, content: string, revision?: number) {
	const payload = await prepareTextPayload(new TextEncoder().encode(content));
	return TextMutationIntentSchema.parse({
		op: "put",
		epoch,
		paths: [path],
		precondition:
			revision === undefined
				? { kind: "absent" }
				: { kind: "match", etag: formatETag(epoch, revision) },
		payload_hash: payload.payload_hash,
		size: payload.size,
	});
}

/** Run real conditional mutations after the first manifest page and verify feed recovery. */
describe("real mutation interleavings during bounded reads", () => {
	it("keeps the captured manifest head and recovers every real mutation from the feed", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const paths = Array.from(
			{ length: 256 },
			(_, index) => `page/${String(index).padStart(3, "0")}.md`,
		);
		const deletedPath = "zz-delete-recreate.md";
		const appendPath = "zz-append.md";
		const restorePath = "zz-restore.md";
		const renameSource = "zz-rename-source.md";
		await seedRows(stub, [
			...paths,
			deletedPath,
			appendPath,
			restorePath,
			renameSource,
		]);
		const readRpcCalls: string[] = [];
		const gateway = readGateway(stub, (method) => readRpcCalls.push(method));
		const first = await openManifestRead(gateway, context);
		expect(readRpcCalls).toEqual(["authorize", "readVault"]);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const firstEntries = [];
		let firstBatch = await first.body.readBatch();
		firstEntries.push(...firstBatch.rows);
		while (!firstBatch.done) {
			firstBatch = await first.body.readBatch();
			firstEntries.push(...firstBatch.rows);
		}
		expect(firstEntries).toHaveLength(256);
		expect(readRpcCalls).toEqual([
			"authorize",
			"readVault",
			"readBatch",
			"readBatch",
			"readBatch",
			"readBatch",
		]);
		expect(first.body.body.head_seq).toBe(260);
		expect(firstBatch.next_page).not.toBeNull();
		await first.finish("settled");
		expect(readRpcCalls.at(-1)).toBe("finishAdmission");
		expect(readRpcCalls).toHaveLength(7);

		await commitText(
			stub,
			await putIntent("zzzz-put.md", "new put"),
			"new put",
			"read-interleave-put-01",
		);
		await commitText(
			stub,
			deleteIntent(deletedPath, 1),
			undefined,
			"read-interleave-delete-01",
		);
		await commitText(
			stub,
			await putIntent(deletedPath, "recreated", 2),
			"recreated",
			"read-interleave-recreate-01",
		);
		const appendContent = " appended";
		const appendIntent = {
			op: "append" as const,
			epoch,
			paths: [appendPath],
			precondition: { kind: "none" as const },
			payload_hash: await hashBytes(appendContent),
			size: new TextEncoder().encode(appendContent).byteLength,
		};
		const append = FileCommandSchema.parse({
			op: "append",
			intent: appendIntent,
			content: appendContent,
			key: "read-interleave-append-01",
		});
		await commitCommand(stub, append);
		await commitText(
			stub,
			deleteIntent(restorePath, 1),
			undefined,
			"read-interleave-restore-delete-01",
		);
		const restoreBody = { source_rev: 1, as_conflict_copy: false };
		const restoreBytes = JSON.stringify(restoreBody);
		const restore = FileCommandSchema.parse({
			op: "restore",
			intent: {
				op: "restore",
				epoch,
				paths: [restorePath],
				precondition: { kind: "match", etag: formatETag(epoch, 2) },
				payload_hash: await hashBytes(restoreBytes),
				size: new TextEncoder().encode(restoreBytes).byteLength,
			},
			body: restoreBody,
			key: "read-interleave-restore-01",
		});
		await commitCommand(stub, restore);
		const renameBody = { to: "00-renamed-destination.md" };
		const renameBytes = JSON.stringify(renameBody);
		const rename = FileCommandSchema.parse({
			op: "rename",
			intent: {
				op: "rename",
				epoch,
				paths: [renameSource, renameBody.to],
				precondition: { kind: "match", etag: formatETag(epoch, 1) },
				payload_hash: await hashBytes(renameBytes),
				size: new TextEncoder().encode(renameBytes).byteLength,
			},
			body: renameBody,
			key: "read-interleave-rename-01",
		});
		await commitCommand(stub, rename);

		const second = await openManifestRead(
			gateway,
			context,
			firstBatch.next_page ?? undefined,
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const secondEntries = [];
		let secondBatch = await second.body.readBatch();
		secondEntries.push(...secondBatch.rows);
		while (!secondBatch.done) {
			secondBatch = await second.body.readBatch();
			secondEntries.push(...secondBatch.rows);
		}
		expect(second.body.body.head_seq).toBe(first.body.body.head_seq);
		expect(secondEntries.map((entry) => entry.path)).not.toContain(
			renameBody.to,
		);
		expect(
			secondEntries.find((entry) => entry.path === "zzzz-put.md"),
		).toMatchObject({
			seq: 261,
			etag: formatETag(epoch, 1),
		});
		expect(
			secondEntries.find((entry) => entry.path === deletedPath),
		).toMatchObject({
			seq: 263,
			etag: formatETag(epoch, 3),
		});
		expect(
			secondEntries.find((entry) => entry.path === appendPath),
		).toMatchObject({
			seq: 264,
			etag: formatETag(epoch, 2),
		});
		expect(
			secondEntries.find((entry) => entry.path === restorePath),
		).toMatchObject({
			seq: 266,
			etag: formatETag(epoch, 3),
		});
		expect(
			secondEntries.find((entry) => entry.path === renameSource),
		).toMatchObject({
			seq: 267,
			etag: formatETag(epoch, 2),
			deleted: true,
		});
		const feed = await openChangesRead(
			gateway,
			context,
			epoch,
			first.body.body.head_seq,
		);
		expect(feed.ok).toBe(true);
		if (!feed.ok) return;
		const feedEntries = [];
		let feedBatch = await feed.body.readBatch();
		feedEntries.push(...feedBatch.rows);
		while (!feedBatch.done) {
			feedBatch = await feed.body.readBatch();
			feedEntries.push(...feedBatch.rows);
		}
		expect(feed.body.body.head_seq).toBe(267);
		expect(feedEntries.map((entry) => entry.seq)).toEqual([
			261, 262, 263, 264, 265, 266, 267,
		]);
		expect(feedEntries.map((entry) => entry.op)).toEqual([
			"put",
			"delete",
			"put",
			"put",
			"delete",
			"put",
			"rename",
		]);
		expect(feedEntries).toMatchObject([
			{ path: "zzzz-put.md", etag: formatETag(epoch, 1) },
			{ path: deletedPath, etag: formatETag(epoch, 2) },
			{ path: deletedPath, etag: formatETag(epoch, 3) },
			{ path: appendPath, etag: formatETag(epoch, 2) },
			{ path: restorePath, etag: formatETag(epoch, 2) },
			{ path: restorePath, etag: formatETag(epoch, 3) },
			{
				path: renameBody.to,
				etag: formatETag(epoch, 1),
				from_path: renameSource,
				from_etag: formatETag(epoch, 2),
			},
		]);
		await first.finish("settled");
		await second.finish("settled");
		await feed.finish("settled");
	});

	it("returns revision_pruned for the old identity and current bytes only on explicit current read", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const path = "notes/pruned-current.md";
		await seedRows(stub, [path]);
		await commitText(
			stub,
			await putIntent(path, "current bytes", 1),
			"current bytes",
			"read-pruned-update-01",
		);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"DELETE FROM revisions WHERE path = ? AND rev = 1",
				path,
			);
		});
		const old = await stub.readText(context, { path, epoch, rev: 1 });
		expect(old).toMatchObject({
			ok: false,
			failure: { kind: "revision_pruned" },
		});
		const current = await stub.readText(context, { path });
		expect(current).toMatchObject({
			ok: true,
			body: { content: "current bytes", etag: formatETag(epoch, 2) },
		});
	});
});
