import {
	ExportManifestSchema,
	ExportOperationResultSchema,
	ExportSnapshotSchema,
	OwnerExportRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const epoch = "a".repeat(32);
const hash = "b".repeat(64);

describe("packed export protocol contracts", () => {
	it("requires a canonical UTC timestamp for owner idempotency", () => {
		expect(
			OwnerExportRequestSchema.safeParse({
				created_at: "2026-11-07T03:00:00.000Z",
			}).success,
		).toBe(true);
		expect(
			OwnerExportRequestSchema.safeParse({ created_at: "2026-11-07T03:00:00Z" })
				.success,
		).toBe(false);
		expect(
			OwnerExportRequestSchema.safeParse({
				created_at: "2026-11-07T03:00:00.000+00:00",
			}).success,
		).toBe(false);
	});

	it("accepts the canonical live-file manifest and rejects duplicate or unsorted paths", () => {
		const manifest = {
			epoch,
			head_seq: 4,
			created_at: "2026-11-07T03:00:00.000Z",
			files: [
				{ path: "a.md", rev: 2, hash, size: 4 },
				{ path: "b.md", rev: 1, hash, size: 0 },
			],
		};
		expect(ExportManifestSchema.safeParse(manifest).success).toBe(true);
		expect(
			ExportManifestSchema.safeParse({
				...manifest,
				files: [...manifest.files].reverse(),
			}).success,
		).toBe(false);
		const sqlitePathOrder = {
			...manifest,
			files: [
				{ path: "\uE000.md", rev: 1, hash, size: 0 },
				{ path: "\u{10000}.md", rev: 1, hash, size: 0 },
			],
		};
		expect(ExportManifestSchema.safeParse(sqlitePathOrder).success).toBe(true);
		expect(
			ExportManifestSchema.safeParse({
				...sqlitePathOrder,
				files: [...sqlitePathOrder.files].reverse(),
			}).success,
		).toBe(false);
		const maximumFileList = Array.from({ length: 10_000 }, (_, index) => ({
			path: `note-${String(index).padStart(5, "0")}.md`,
			rev: 1,
			hash,
			size: 0,
		}));
		expect(
			ExportManifestSchema.safeParse({ ...manifest, files: maximumFileList })
				.success,
		).toBe(true);
		expect(
			ExportManifestSchema.safeParse({
				...manifest,
				files: [
					...maximumFileList,
					{ path: "zz-extra.md", rev: 1, hash, size: 0 },
				],
			}).success,
		).toBe(false);
		expect(
			ExportManifestSchema.safeParse({ ...manifest, unknown: true }).success,
		).toBe(false);
	});

	it("keeps pending exports unavailable and lists complete snapshots with positive sizes", () => {
		const pending = {
			epoch,
			created_at: "2026-11-07T03:00:00.000Z",
			status: "queued",
			size: null,
			failure: null,
		};
		expect(ExportOperationResultSchema.safeParse(pending).success).toBe(true);
		const snapshot = {
			epoch,
			created_at: "2026-11-07T03:00:00.000Z",
			size: 4,
			download_url: "/owner/exports/download",
		};
		expect(ExportSnapshotSchema.safeParse(snapshot).success).toBe(true);
		expect(
			ExportSnapshotSchema.safeParse({ ...snapshot, size: 0 }).success,
		).toBe(false);
	});
});
