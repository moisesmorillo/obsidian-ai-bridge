import {
	EMPTY_PAYLOAD_HASH,
	formatETag,
	IdempotencyKeySchema,
	TextMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import { prepareTextPayload } from "@worker/application/text-payload";
import {
	PublicationQueryObserver,
	sqliteRecordBytes,
} from "@worker/test-fixtures/publication-budgets";
import {
	captureTextStoreState,
	TEXT_FIXTURE_CONTEXT,
	TEXT_FIXTURE_EPOCH,
	withTextStore,
} from "@worker/test-fixtures/text-files";
import { describe, expect, it } from "vitest";

/** Build a create intent from native test content. */
async function createIntent(path: string, content: string) {
	const payload = await prepareTextPayload(new TextEncoder().encode(content));
	return TextMutationIntentSchema.parse({
		op: "put",
		epoch: TEXT_FIXTURE_EPOCH,
		paths: [path],
		precondition: { kind: "absent" },
		payload_hash: payload.payload_hash,
		size: payload.size,
	});
}

describe("native publication query budgets", () => {
	it.each([
		{ values: [], bytes: 1 },
		{ values: [null], bytes: 2 },
		{ values: [0], bytes: 2 },
		{ values: [1], bytes: 2 },
		{ values: [null, "é", 1], bytes: 6 },
		{ values: ["a\u0000b"], bytes: 5 },
		{ values: [new Uint8Array([0, 255])], bytes: 4 },
		{ values: [-129], bytes: 4 },
		{ values: [-128], bytes: 3 },
		{ values: [127], bytes: 3 },
		{ values: [128], bytes: 4 },
		{ values: [-32769], bytes: 5 },
		{ values: [-32768], bytes: 4 },
		{ values: [32767], bytes: 4 },
		{ values: [32768], bytes: 5 },
		{ values: [-8388609], bytes: 6 },
		{ values: [-8388608], bytes: 5 },
		{ values: [8388607], bytes: 5 },
		{ values: [8388608], bytes: 6 },
		{ values: [-2147483649], bytes: 8 },
		{ values: [-2147483648], bytes: 6 },
		{ values: [2147483647], bytes: 6 },
		{ values: [2147483648], bytes: 8 },
		{ values: [-140737488355329], bytes: 10 },
		{ values: [-140737488355328], bytes: 8 },
		{ values: [140737488355327], bytes: 8 },
		{ values: [140737488355328], bytes: 10 },
		{ values: [Number.MIN_SAFE_INTEGER], bytes: 10 },
		{ values: [Number.MAX_SAFE_INTEGER], bytes: 10 },
		{ values: ["x".repeat(57)], bytes: 59 },
		{ values: ["x".repeat(58)], bytes: 61 },
		{ values: ["x".repeat(8185)], bytes: 8188 },
		{ values: ["x".repeat(8186)], bytes: 8190 },
		{ values: [new Uint8Array(57)], bytes: 59 },
		{ values: [new Uint8Array(58)], bytes: 61 },
		{ values: Array(126).fill(null), bytes: 127 },
		{ values: Array(127).fill(null), bytes: 129 },
	])("encodes record case %# in $bytes bytes", ({ values, bytes }) => {
		expect(sqliteRecordBytes(values)).toBe(bytes);
	});
	it.each([undefined, true, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, {}])(
		"rejects unsupported record case %#",
		(value) => {
			expect(() => sqliteRecordBytes([value])).toThrow(TypeError);
		},
	);
	it("observes application SQL dispatches and corroborates native create state", async () => {
		const observer = new PublicationQueryObserver();
		await withTextStore(async ({ store, admissions, storage }) => {
			const path = "notes/budget.md";
			const content = "measured native publication";
			const intent = await createIntent(path, content);
			const begin = await store.beginMutation(TEXT_FIXTURE_CONTEXT, {
				op: intent.op,
				epoch: intent.epoch,
				paths: intent.paths,
				precondition: intent.precondition,
			});
			expect(begin.ok).toBe(true);
			if (!begin.ok) return;
			const authorized = await admissions.authorize(
				TEXT_FIXTURE_CONTEXT,
				intent,
				begin.lease.admission_id,
			);
			expect(authorized.ok).toBe(true);
			if (!authorized.ok) return;
			const result = await store.commitText(
				TEXT_FIXTURE_CONTEXT,
				intent,
				authorized.ticket.id,
				content,
			);
			expect(result).toMatchObject({ ok: true, response: { status: 201 } });
			expect(
				storage.sql
					.exec("SELECT content FROM files WHERE path = ?", path)
					.toArray(),
			).toEqual([{ content }]);
		}, observer);
		expect(observer.queries.length).toBeGreaterThan(0);
		expect(observer.queries.every(({ bindCount }) => bindCount <= 100)).toBe(
			true,
		);
	});
});

/** Count dispatches only inside one awaited application call. No values enter the report. */
async function measureSpan<T>(
	observer: PublicationQueryObserver,
	name: string,
	run: () => T | Promise<T>,
): Promise<T> {
	const start = observer.queries.length;
	const result = await run();
	const queries = observer.queries.slice(start);
	expect(queries.length).toBeGreaterThan(0);
	const maxBindings = Math.max(...queries.map((query) => query.bindCount));
	expect(maxBindings).toBeLessThanOrEqual(100);
	console.info(
		JSON.stringify({ span: name, dispatches: queries.length, maxBindings }),
	);
	return result;
}

/** Measure every stored column in native schema order, not a JSON representation of the row. */
function reportRecords(storage: DurableObjectStorage, workload: string): void {
	for (const [table, columns] of [
		["files", 12],
		["revisions", 10],
		["receipts", 6],
	] as const) {
		const rows = storage.sql.exec(`SELECT * FROM ${table}`).toArray();
		expect(rows.length).toBeGreaterThan(0);
		const sizes = rows.map((row) => {
			const values = Object.values(row);
			expect(values).toHaveLength(columns);
			for (const value of values) {
				if (typeof value === "string") {
					expect(new TextEncoder().encode(value).byteLength).toBeLessThan(
						2_000_000,
					);
				} else if (value instanceof ArrayBuffer) {
					expect(value.byteLength).toBeLessThan(2_000_000);
				}
			}
			const bytes = sqliteRecordBytes(values);
			expect(bytes).toBeLessThan(2_000_000);
			return bytes;
		});
		console.info(
			JSON.stringify({ workload, table, encodedRecordBytes: sizes }),
		);
	}
	const receipts = storage.sql
		.exec<{ body: string }>("SELECT body FROM receipts")
		.toArray();
	console.info(
		JSON.stringify({
			workload,
			receiptJsonBytes: receipts.map(
				(row) => new TextEncoder().encode(row.body).byteLength,
			),
		}),
	);
}

describe("maximum native publication workloads", () => {
	it.each([
		{ extension: "md", metadata: "case-expansion" },
		{ extension: "canvas", metadata: "case-expansion" },
		{ extension: "md", metadata: "json-escaping" },
		{ extension: "canvas", metadata: "json-escaping" },
	])(
		"measures $extension $metadata create, update, replay, rejection, and DELETE",
		async ({ extension: fileExtension, metadata }) => {
			const extension = `${fileExtension}/${metadata}`;
			const observer = new PublicationQueryObserver();
			await withTextStore(async (fixture) => {
				const { storage, store, admissions, setNow } = fixture;
				const suffix = `.${fileExtension}`;
				// U+0130 expands from two UTF-8 bytes to three bytes in path_key.
				const path =
					metadata === "case-expansion"
						? `${"İ".repeat(Math.floor((512 - suffix.length) / 2))}x${suffix}`
						: '"'.repeat(512 - suffix.length) + suffix;
				const context = {
					...TEXT_FIXTURE_CONTEXT,
					client_id: "😀".repeat(512),
					grant_id: "g".repeat(2048),
				};
				const max = Number.MAX_SAFE_INTEGER;
				setNow(max - 60_000);
				storage.sql.exec(
					"INSERT INTO sqlite_sequence(name,seq) VALUES ('changes', ?)",
					max - 3,
				);
				storage.sql.exec(
					"UPDATE meta SET value = ? WHERE key = 'head_seq'",
					String(max - 3),
				);
				const beforeBytes = storage.sql.databaseSize;
				const content =
					fileExtension === "md"
						? `${"é ".repeat(333_333)}\u0000`
						: JSON.stringify({ text: `${"é ".repeat(333_329)}xx` });
				expect(new TextEncoder().encode(content).byteLength).toBe(1_000_000);
				expect(new TextEncoder().encode(path).byteLength).toBe(512);
				expect(new TextEncoder().encode(context.client_id).byteLength).toBe(
					2048,
				);
				const createdIntent = await createIntent(path, content);
				/** Reserve and authorize outside the separately measured atomic commit span. */
				async function authorize(
					intent: typeof createdIntent,
					label: string,
					keyLabel = label,
				) {
					const key = IdempotencyKeySchema.parse(
						String.fromCodePoint(0x1f600 + keyLabel.charCodeAt(0)) +
							"😀".repeat(127),
					);
					expect([...key]).toHaveLength(128);
					expect(new TextEncoder().encode(key).byteLength).toBe(512);
					const begin = await measureSpan(
						observer,
						`${extension}/${label}/reservation`,
						() =>
							store.beginMutation(
								context,
								{
									op: intent.op,
									epoch: intent.epoch,
									paths: intent.paths,
									precondition: intent.precondition,
								},
								key,
							),
					);
					expect(begin.ok).toBe(true);
					if (!begin.ok) throw new Error("Native reservation failed");
					const authorized = await measureSpan(
						observer,
						`${extension}/${label}/authorization`,
						() =>
							admissions.authorize(context, intent, begin.lease.admission_id),
					);
					expect(authorized.ok).toBe(true);
					if (!authorized.ok) throw new Error("Native authorization failed");
					return { key, ticket: authorized.ticket.id };
				}
				/** Measure external settlement separately, then verify durable claim removal. */
				async function settle(ticket: string, label: string) {
					expect(
						await measureSpan(
							observer,
							`${extension}/${label}/settlement`,
							() => admissions.finish(context, ticket, "settled"),
						),
					).toEqual({ ok: true });
					expect(
						storage.sql.exec("SELECT id FROM operation_admissions").toArray(),
					).toEqual([]);
					expect(
						storage.sql.exec("SELECT * FROM mutation_claims").toArray(),
					).toEqual([]);
				}
				const create = await authorize(createdIntent, "create");
				const created = await measureSpan(
					observer,
					`${extension}/create/commit`,
					() =>
						store.commitText(
							context,
							createdIntent,
							create.ticket,
							content,
							create.key,
						),
				);
				expect(created).toMatchObject({
					ok: true,
					response: { status: 201, body: { seq: max - 2, size: 1_000_000 } },
				});
				expect(
					storage.sql.exec("SELECT content, size FROM files").toArray(),
				).toEqual([{ content, size: 1_000_000 }]);
				expect(
					storage.sql.exec("SELECT content FROM revisions").toArray(),
				).toEqual([{ content }]);
				expect(
					storage.sql.exec("SELECT path FROM files_fts").toArray(),
				).toEqual(fileExtension === "md" ? [{ path }] : []);
				await settle(create.ticket, "create");
				reportRecords(storage, `${extension}/create`);
				const afterCreateBytes = storage.sql.databaseSize;
				// Seed the largest legal predecessor revision without changing publication SQL.
				storage.sql.exec(
					"UPDATE files SET rev = ? WHERE path = ?",
					max - 2,
					path,
				);
				const beforeUpdateBytes = storage.sql.databaseSize;
				const updateContent = content.replace("é", "ö");
				const updateIntent = TextMutationIntentSchema.parse({
					...(await createIntent(path, updateContent)),
					precondition: {
						kind: "match",
						etag: formatETag(TEXT_FIXTURE_EPOCH, max - 2),
					},
				});
				const update = await authorize(updateIntent, "update");
				const updated = await measureSpan(
					observer,
					`${extension}/update/commit`,
					() =>
						store.commitText(
							context,
							updateIntent,
							update.ticket,
							updateContent,
							update.key,
						),
				);
				expect(updated).toMatchObject({
					ok: true,
					response: {
						status: 200,
						body: {
							seq: max - 1,
							etag: formatETag(TEXT_FIXTURE_EPOCH, max - 1),
						},
					},
				});
				expect(
					storage.sql
						.exec("SELECT content, rev, seq, origin FROM files")
						.toArray(),
				).toEqual([
					{
						content: updateContent,
						rev: max - 1,
						seq: max - 1,
						origin: context.client_id,
					},
				]);
				await settle(update.ticket, "update");
				reportRecords(storage, `${extension}/update`);
				const successfulState = captureTextStoreState(storage);
				const replay = await authorize(updateIntent, "replay", "update");
				const replayed = await measureSpan(
					observer,
					`${extension}/replay/commit`,
					() =>
						store.commitText(
							context,
							updateIntent,
							replay.ticket,
							updateContent,
							replay.key,
						),
				);
				expect(replayed).toEqual(updated);
				await settle(replay.ticket, "replay");
				expect(captureTextStoreState(storage)).toEqual(successfulState);
				const rejection = await authorize(updateIntent, "rejection");
				const beforeRejection = captureTextStoreState(storage);
				const rejected = await measureSpan(
					observer,
					`${extension}/rejection/commit`,
					() =>
						store.commitText(
							context,
							updateIntent,
							rejection.ticket,
							updateContent,
							rejection.key,
						),
				);
				expect(rejected).toMatchObject({
					ok: false,
					failure: { kind: "precondition_failed" },
				});
				expect(captureTextStoreState(storage)).toEqual(beforeRejection);
				await settle(rejection.ticket, "rejection");
				expect(captureTextStoreState(storage)).toEqual(successfulState);
				const deleteIntent = TextMutationIntentSchema.parse({
					...updateIntent,
					op: "delete",
					payload_hash: EMPTY_PAYLOAD_HASH,
					size: 0,
					precondition: {
						kind: "match",
						etag: formatETag(TEXT_FIXTURE_EPOCH, max - 1),
					},
				});
				const deletion = await authorize(deleteIntent, "delete");
				const deleted = await measureSpan(
					observer,
					`${extension}/delete/commit`,
					() =>
						store.commitText(
							context,
							deleteIntent,
							deletion.ticket,
							undefined,
							deletion.key,
						),
				);
				expect(deleted).toMatchObject({
					ok: true,
					response: {
						body: {
							seq: max,
							deleted: true,
							size: 0,
							etag: formatETag(TEXT_FIXTURE_EPOCH, max),
						},
					},
				});
				await settle(deletion.ticket, "delete");
				expect(
					storage.sql
						.exec("SELECT rev, seq, content, deleted FROM files")
						.toArray(),
				).toEqual([{ rev: max, seq: max, content: null, deleted: 1 }]);
				expect(
					storage.sql.exec("SELECT path FROM files_fts").toArray(),
				).toEqual([]);
				expect(
					storage.sql.exec("SELECT rev FROM revisions ORDER BY rev").toArray(),
				).toEqual([{ rev: 1 }, { rev: max - 1 }, { rev: max }]);
				reportRecords(storage, `${extension}/delete`);
				for (const query of observer.queries) {
					expect(Object.keys(query).sort()).toEqual(["bindCount", "sql"]);
					expect(query.sql).not.toContain(context.client_id);
					expect(query.sql).not.toContain(path);
					expect(query.sql).not.toContain(content);
				}
				console.info(
					JSON.stringify({
						workload: extension,
						contentBytes: 1_000_000,
						databaseGrowthBytes:
							afterCreateBytes -
							beforeBytes +
							storage.sql.databaseSize -
							beforeUpdateBytes,
						runtimeMemory: "unmeasured",
						boundary:
							"application dispatch only, excludes internal FTS SQL and implicit transaction control. Setup and measurement queries excluded. No aggregate headroom claim.",
					}),
				);
			}, observer);
		},
	);
});
