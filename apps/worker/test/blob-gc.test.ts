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
			claimDeleteBatch: vi.fn(async () => marked),
			recordFailure: vi.fn(async () => {
				failure = "blob_gc_unavailable";
			}),
			clearFailure: vi.fn(async () => {
				failure = null;
			}),
			mark: vi.fn(),
			clear: vi.fn(async () => {
				marked.length = 0;
			}),
			status: vi.fn(async () => ({
				phase: "deleting" as const,
				marked_count: marked.length,
				marked_bytes: 13,
				delete_state: "idle" as const,
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

	it("excludes overlapping owner and alarm deletes through full settlement", async () => {
		const marked = [{ hash, size: 13 }];
		let deleteOwner = "";
		let resolveFirstDelete: (() => void) | undefined;
		let resolveSecondDelete: (() => void) | undefined;
		let objectPresent = false;
		const repository = {
			preview: vi.fn(async () => ({ count: 0, bytes: 0 })),
			start: vi.fn(),
			runState: vi.fn(async () => ({
				phase: "deleting" as const,
				cursor: null,
			})),
			advance: vi.fn(),
			claimDeleteBatch: vi.fn(async (owner: string) => {
				if (deleteOwner !== "") return null;
				deleteOwner = owner;
				return [...marked];
			}),
			recordFailure: vi.fn(async (owner?: string) => {
				if (owner === deleteOwner) deleteOwner = "";
			}),
			clearFailure: vi.fn(async () => undefined),
			mark: vi.fn(),
			clear: vi.fn(async (_objects, owner: string) => {
				if (owner !== deleteOwner) throw new Error("delete claim changed");
				marked.length = 0;
				deleteOwner = "";
			}),
			status: vi.fn(async () => ({
				phase: "deleting" as const,
				marked_count: marked.length,
				marked_bytes: marked.length * 13,
				delete_state:
					deleteOwner === "" ? ("idle" as const) : ("active" as const),
				failure: null,
			})),
			finish: vi.fn(),
		};
		const storage = {
			list: vi.fn(async () => ({ objects: [], cursor: null })),
			delete: vi.fn(async () => {
				const call = storage.delete.mock.calls.length;
				await new Promise<void>((resolve) => {
					if (call === 1) resolveFirstDelete = resolve;
					else resolveSecondDelete = resolve;
				});
				objectPresent = false;
			}),
		};
		const service = new BlobGcService(repository, storage);
		const alarmRun = service.collectBatch();
		try {
			await vi.waitFor(() => expect(storage.delete).toHaveBeenCalledOnce());
			const ownerRun = service.collectBatch();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(storage.delete).toHaveBeenCalledOnce();

			resolveFirstDelete?.();
			await alarmRun;
			objectPresent = true;
			resolveSecondDelete?.();
			await ownerRun;

			expect(objectPresent).toBe(true);
			expect(repository.clear).toHaveBeenCalledOnce();
		} finally {
			resolveFirstDelete?.();
			resolveSecondDelete?.();
		}
	});

	it("does not start collection without an owner confirmation", async () => {
		const repository = {
			preview: vi.fn(async () => ({ count: 0, bytes: 0 })),
			start: vi.fn(),
			runState: vi.fn(async () => ({ phase: "idle" as const, cursor: null })),
			advance: vi.fn(),
			claimDeleteBatch: vi.fn(async () => null),
			recordFailure: vi.fn(),
			clearFailure: vi.fn(),
			mark: vi.fn(),
			clear: vi.fn(),
			finish: vi.fn(),
			status: vi.fn(async () => ({
				phase: "idle" as const,
				marked_count: 0,
				marked_bytes: 0,
				delete_state: "idle" as const,
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
			claimDeleteBatch: vi.fn(async () => null),
			recordFailure: vi.fn(),
			clearFailure: vi.fn(),
			finish: vi.fn(),
			mark: vi.fn(),
			clear: vi.fn(),
			status: vi.fn(async () => ({
				phase: "idle" as const,
				marked_count: 0,
				marked_bytes: 0,
				delete_state: "idle" as const,
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
