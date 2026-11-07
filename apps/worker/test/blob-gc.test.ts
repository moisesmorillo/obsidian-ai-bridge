import { BlobGcService } from "@worker/application/blob-gc";
import { describe, expect, it, vi } from "vitest";

const hash = "a".repeat(64);

describe("blob garbage collection", () => {
	it("keeps durable marks when R2 deletion fails", async () => {
		const marked = [{ hash, size: 13 }];
		let failure: "blob_gc_unavailable" | null = null;
		const repository = {
			preview: vi.fn(async () => ({ count: 0, bytes: 0 })),
			start: vi.fn(),
			runState: vi.fn(async () => ({
				phase: "deleting" as const,
				cursor: null,
			})),
			advance: vi.fn(),
			recordFailure: vi.fn(async () => {
				failure = "blob_gc_unavailable";
			}),
			clearFailure: vi.fn(async () => {
				failure = null;
			}),
			mark: vi.fn(),
			marked: vi.fn(async () => marked),
			clear: vi.fn(async () => {
				marked.length = 0;
			}),
			status: vi.fn(async () => ({
				phase: "deleting" as const,
				marked_count: marked.length,
				marked_bytes: 13,
				failure,
			})),
			finish: vi.fn(),
		};
		const storage = {
			list: vi.fn(async () => ({ objects: [], cursor: null })),
			delete: vi.fn(async () => {
				throw new Error("synthetic R2 failure");
			}),
		};
		const service = new BlobGcService(repository, storage);

		expect(await service.collectBatch()).toMatchObject({
			phase: "deleting",
			marked_count: 1,
			failure: "blob_gc_unavailable",
		});
		expect(marked).toHaveLength(1);
		expect(repository.clear).not.toHaveBeenCalled();
		expect(repository.recordFailure).toHaveBeenCalledOnce();
	});

	it("does not start collection without an owner confirmation", async () => {
		const repository = {
			preview: vi.fn(async () => ({ count: 0, bytes: 0 })),
			start: vi.fn(),
			runState: vi.fn(async () => ({ phase: "idle" as const, cursor: null })),
			advance: vi.fn(),
			recordFailure: vi.fn(),
			clearFailure: vi.fn(),
			mark: vi.fn(),
			marked: vi.fn(async () => []),
			clear: vi.fn(),
			finish: vi.fn(),
			status: vi.fn(async () => ({
				phase: "idle" as const,
				marked_count: 0,
				marked_bytes: 0,
				failure: null,
			})),
		};
		const storage = {
			list: vi.fn(async () => ({ objects: [], cursor: null })),
			delete: vi.fn(),
		};

		await new BlobGcService(repository, storage).collectBatch();

		expect(repository.start).not.toHaveBeenCalled();
		expect(storage.list).not.toHaveBeenCalled();
	});

	it("previews listed blobs without changing durable marks", async () => {
		const repository = {
			preview: vi.fn(
				async (blobs: readonly { hash: string; size: number }[]) => ({
					count: blobs.length,
					bytes: blobs.reduce((sum, blob) => sum + blob.size, 0),
				}),
			),
			start: vi.fn(),
			runState: vi.fn(async () => ({ phase: "idle" as const, cursor: null })),
			advance: vi.fn(),
			recordFailure: vi.fn(),
			clearFailure: vi.fn(),
			finish: vi.fn(),
			mark: vi.fn(),
			marked: vi.fn(async () => []),
			clear: vi.fn(),
			status: vi.fn(async () => ({
				phase: "idle" as const,
				marked_count: 0,
				marked_bytes: 0,
				failure: null,
			})),
		};
		const storage = {
			list: vi.fn(async () => ({
				objects: [{ hash, size: 13 }],
				cursor: null,
			})),
			delete: vi.fn(),
		};
		const service = new BlobGcService(repository, storage);

		expect(await service.preview()).toEqual({ count: 1, bytes: 13 });
		expect(repository.preview).toHaveBeenCalledWith([{ hash, size: 13 }]);
		expect(repository.mark).not.toHaveBeenCalled();
		expect(repository.clear).not.toHaveBeenCalled();
		expect(storage.delete).not.toHaveBeenCalled();
	});
});
