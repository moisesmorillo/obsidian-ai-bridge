import {
	ChangesPageSchema,
	decodeReadCursor,
	encodeFileFailure,
	encodeReadCursor,
	FileFailureSchema,
	formatETag,
	HistoryPageSchema,
	ManifestPageSchema,
	MetadataBatchRequestSchema,
	MetadataBatchResultSchema,
	ReadCursorSchema,
	ReadQuerySchema,
	VaultReadResultSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const epoch = "a".repeat(32);
const hash = "b".repeat(64);

describe("canonical bounded read contracts", () => {
	it("accepts strict metadata shapes and rejects bare revisions", () => {
		const etag = formatETag(epoch, 1);
		expect(
			VaultReadResultSchema.safeParse({
				epoch,
				head_seq: 3,
				counts: { live: 1, deleted: 1 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
			}).success,
		).toBe(true);
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 3,
				entries: [
					{
						path: "note.md",
						etag,
						seq: 2,
						hash,
						size: 4,
						kind: "text",
						deleted: false,
						large: false,
					},
				],
				next_page: null,
			}).success,
		).toBe(true);
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 3,
				entries: [
					{
						path: "note.md",
						rev: 1,
						seq: 2,
						hash,
						size: 4,
						kind: "text",
						deleted: false,
						large: false,
					},
				],
				next_page: null,
			}).success,
		).toBe(false);
	});

	it("accepts large Markdown and Canvas manifest blobs", () => {
		for (const path of ["large.md", "large.canvas"]) {
			const entry = {
				path,
				etag: formatETag(epoch, 4),
				seq: 4,
				hash,
				size: 1_000_001,
				kind: "blob",
				deleted: false,
				large: true,
			};
			expect(
				ManifestPageSchema.safeParse({
					epoch,
					head_seq: 4,
					entries: [entry],
					next_page: null,
				}).success,
			).toBe(true);
		}
	});

	it("orders manifest paths by SQLite binary UTF-8 order", () => {
		const paths = ["a/\uE000.md", "a/\u{10000}.md"];
		const entries = paths.map((path, index) => ({
			path,
			etag: formatETag(epoch, index + 1),
			seq: index + 1,
			hash,
			size: 1,
			kind: "text",
			deleted: false,
			large: false,
		}));
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 2,
				entries,
				next_page: null,
			}).success,
		).toBe(true);
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 2,
				entries: [...entries].reverse(),
				next_page: null,
			}).success,
		).toBe(false);
	});

	it("enforces tombstone metadata and page size caps", () => {
		const base = {
			path: "note.md",
			etag: formatETag(epoch, 2),
			seq: 2,
			hash: "",
			size: 0,
			kind: "text",
			deleted: true,
			large: false,
		};
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 2,
				entries: [base],
				next_page: null,
			}).success,
		).toBe(true);
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 2,
				entries: [{ ...base, hash, size: 1 }],
				next_page: null,
			}).success,
		).toBe(false);
		expect(
			ManifestPageSchema.safeParse({
				epoch,
				head_seq: 2,
				entries: Array.from({ length: 257 }, (_, index) => ({
					...base,
					path: `n${index}.md`,
				})),
				next_page: null,
			}).success,
		).toBe(false);
	});

	it("requires changes to be ascending and binds rename source ETags", () => {
		const entry = {
			seq: 2,
			op: "rename",
			path: "to.md",
			etag: formatETag(epoch, 2),
			hash,
			origin: "device",
			at: 1,
			from_path: "from.md",
			from_etag: formatETag(epoch, 3),
		};
		expect(
			ChangesPageSchema.safeParse({ epoch, head_seq: 3, entries: [entry] })
				.success,
		).toBe(true);
		expect(
			ChangesPageSchema.safeParse({
				epoch,
				head_seq: 3,
				entries: [{ ...entry, from_etag: formatETag("c".repeat(32), 3) }],
			}).success,
		).toBe(false);
		expect(
			ChangesPageSchema.safeParse({
				epoch,
				head_seq: 3,
				entries: [{ ...entry, rev: 2 }],
			}).success,
		).toBe(false);
		expect(
			ChangesPageSchema.safeParse({
				epoch,
				head_seq: 3,
				entries: [
					{
						seq: 3,
						op: "restore",
						path: "restored.md",
						etag: formatETag(epoch, 3),
						hash,
						origin: "device",
						at: 1,
					},
				],
			}).success,
		).toBe(false);
	});

	it("validates token size, kind, path, versions, and safe numeric positions", () => {
		const payload = {
			version: 1,
			kind: "manifest",
			epoch,
			head_seq: 9,
			last_path: "note.md",
		} as const;
		const token = encodeReadCursor(payload);
		expect(decodeReadCursor(token, { kind: "manifest", epoch })).toEqual(
			payload,
		);
		expect(() =>
			decodeReadCursor(token, { kind: "history", epoch, path: "note.md" }),
		).toThrow();
		expect(() =>
			decodeReadCursor(token, { kind: "manifest", epoch: "c".repeat(32) }),
		).toThrow();
		expect(
			ReadCursorSchema.safeParse({
				...payload,
				head_seq: Number.MAX_SAFE_INTEGER + 1,
			}).success,
		).toBe(false);
		expect(() =>
			decodeReadCursor("!".repeat(4097), { kind: "manifest", epoch }),
		).toThrow();
		expect(() =>
			decodeReadCursor("%%%", { kind: "manifest", epoch }),
		).toThrow();
	});

	it("exposes history ETags without bare revisions and encodes cursor expiry", () => {
		const page = {
			epoch,
			entries: [
				{
					etag: formatETag(epoch, 1),
					hash,
					size: 3,
					deleted: false,
					origin: "device",
					at: 1,
				},
			],
			next_page: null,
		};
		expect(HistoryPageSchema.safeParse(page).success).toBe(true);
		expect(
			HistoryPageSchema.safeParse({
				...page,
				entries: [{ ...page.entries[0], rev: 1 }],
			}).success,
		).toBe(false);
		expect(
			FileFailureSchema.safeParse({ kind: "cursor_expired" }).success,
		).toBe(true);
		expect(encodeFileFailure({ kind: "cursor_expired" })).toEqual({
			status: 410,
			body: {
				error: "cursor_expired",
				message: "This read cursor is no longer valid.",
			},
		});
	});

	it("bounds internal metadata traversal and rejects unsafe query positions", () => {
		const request = {
			collection: "manifest",
			epoch,
			head_seq: 2,
			after_path: null,
			limit: 64,
		};
		expect(MetadataBatchRequestSchema.safeParse(request).success).toBe(true);
		expect(
			MetadataBatchRequestSchema.safeParse({ ...request, limit: 65 }).success,
		).toBe(false);
		const historyRequest = {
			collection: "history",
			epoch,
			path: "notes/item.md",
			upper_etag: formatETag(epoch, 2),
			after_rev: 3,
			limit: 64,
		};
		expect(MetadataBatchRequestSchema.safeParse(historyRequest).success).toBe(
			false,
		);
		expect(
			MetadataBatchResultSchema.safeParse({
				collection: "manifest",
				rows: [],
			}).success,
		).toBe(true);
		expect(
			MetadataBatchResultSchema.safeParse({
				collection: "manifest",
				rows: Array.from({ length: 66 }, () => ({ path: "note.md" })),
			}).success,
		).toBe(false);
		expect(
			MetadataBatchResultSchema.safeParse({
				collection: "manifest",
				rows: [{ rev: 1 }],
			}).success,
		).toBe(false);
		expect(
			ReadQuerySchema.safeParse({ since: String(Number.MAX_SAFE_INTEGER + 1) })
				.success,
		).toBe(false);
		expect(ReadQuerySchema.safeParse({ since: "1", extra: "x" }).success).toBe(
			false,
		);
	});

	it("validates feed limits only on request queries", () => {
		for (const limit of [0, -1, 1001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(ReadQuerySchema.safeParse({ limit: String(limit) }).success).toBe(
				false,
			);
		}
		expect(ReadQuerySchema.safeParse({ limit: "1" }).success).toBe(true);
		expect(ReadQuerySchema.safeParse({ limit: "1000" }).success).toBe(true);
		expect(
			ChangesPageSchema.safeParse({
				epoch,
				head_seq: 0,
				entries: [],
				limit: 1000,
			}).success,
		).toBe(false);
	});
});
