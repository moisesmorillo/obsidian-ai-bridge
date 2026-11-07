import { R2BlobGcStore } from "@worker/infrastructure/r2/blob-gc";
import { describe, expect, it, vi } from "vitest";

describe("R2 blob-GC namespace", () => {
	it("lists only canonical blobs keys and never returns backup keys", async () => {
		const list = vi.fn(async () => ({
			objects: [
				{ key: `blobs/${"a".repeat(64)}`, size: 5 },
				{ key: "backups/archive.zip", size: 99 },
				{ key: "blobs/not-a-hash", size: 1 },
			],
			truncated: false,
			cursor: undefined,
		}));
		const bucket = { list, delete: vi.fn() } as unknown as R2Bucket;
		const store = new R2BlobGcStore(bucket);

		expect(await store.list(null)).toEqual({
			objects: [{ hash: "a".repeat(64), size: 5 }],
			cursor: null,
		});
		expect(list).toHaveBeenCalledWith({ prefix: "blobs/", limit: 1_000 });
	});

	it("maps validated hashes to blob keys only for deletion", async () => {
		const remove = vi.fn(async () => undefined);
		const bucket = { delete: remove } as unknown as R2Bucket;
		const store = new R2BlobGcStore(bucket);
		const hashes = ["b".repeat(64), "c".repeat(64)];

		await store.delete(hashes);

		expect(remove).toHaveBeenCalledWith(hashes.map((hash) => `blobs/${hash}`));
	});
});
