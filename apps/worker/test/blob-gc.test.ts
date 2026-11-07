import { BlobGcService } from "@worker/application/blob-gc";
import { describe, expect, it, vi } from "vitest";

const hash = "a".repeat(64);

describe("blob garbage collection", () => {
	it("keeps all marks after partial R2 deletion and completes a safe retry", async () => {
		const marked = [
			{ hash, size: 13 },
			{ hash: "b".repeat(64), size: 17 },
		];
		const remainingObjects = new Set(marked.map(({ hash }) => hash));
		let failure: "blob_gc_unavailable" | null = null;
		let attempts = 0;
		const repository = {
			preview: vi.fn(async () => ({ count: 0, bytes: 0 })),
			start: vi.fn(),
			runState: vi.fn(async () => ({
				runId: "11111111-1111-4111-8111-111111111111",
				phase: "deleting" as const,
				cursor: null,
			})),
			markAndAdvance: vi.fn(async () => true),
			recordInventoryFailure: vi.fn(),
			claimDeleteBatch: vi.fn(async () => [...marked]),
			recordFailure: vi.fn(async () => {
				failure = "blob_gc_unavailable";
			}),
			clear: vi.fn(async (objects: typeof marked) => {
				const hashes = new Set(objects.map(({ hash }) => hash));
				for (let index = marked.length - 1; index >= 0; index -= 1)
					if (hashes.has(marked[index]?.hash ?? "")) marked.splice(index, 1);
				failure = null;
			}),
			status: vi.fn(async () => ({
				phase: "deleting" as const,
				marked_count: marked.length,
				marked_bytes: marked.reduce((sum, object) => sum + object.size, 0),
				delete_state: "idle" as const,
				failure,
			})),
			finish: vi.fn(),
		};
		const storage = {
			list: vi.fn(async () => ({ objects: [], cursor: null })),
			delete: vi.fn(async (hashes: readonly string[]) => {
				attempts += 1;
				if (attempts === 1) {
					remainingObjects.delete(hashes[0] ?? "");
					throw new Error("synthetic partial R2 failure");
				}
				for (const objectHash of hashes) remainingObjects.delete(objectHash);
			}),
		};
		const service = new BlobGcService(repository, storage);

		expect(await service.collectBatch()).toMatchObject({
			phase: "deleting",
			marked_count: 2,
			marked_bytes: 30,
			failure: "blob_gc_unavailable",
		});
		expect(remainingObjects).toEqual(new Set([marked[1]?.hash]));
		expect(marked).toHaveLength(2);
		expect(repository.clear).not.toHaveBeenCalled();
		expect(repository.recordFailure).toHaveBeenCalledOnce();

		expect(await service.collectBatch()).toMatchObject({
			phase: "deleting",
			marked_count: 0,
			marked_bytes: 0,
			delete_state: "idle",
			failure: null,
		});
		expect(remainingObjects).toEqual(new Set());
		expect(storage.delete).toHaveBeenCalledTimes(2);
		expect(repository.clear).toHaveBeenCalledOnce();
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
				runId: "11111111-1111-4111-8111-111111111111",
				phase: "deleting" as const,
				cursor: null,
			})),
			markAndAdvance: vi.fn(async () => true),
			recordInventoryFailure: vi.fn(),
			claimDeleteBatch: vi.fn(async (owner: string) => {
				if (deleteOwner !== "") return null;
				deleteOwner = owner;
				return [...marked];
			}),
			recordFailure: vi.fn(async (owner?: string) => {
				if (owner === deleteOwner) deleteOwner = "";
			}),
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
			runState: vi.fn(async () => ({
				runId: null,
				phase: "idle" as const,
				cursor: null,
			})),
			markAndAdvance: vi.fn(async () => true),
			recordInventoryFailure: vi.fn(),
			claimDeleteBatch: vi.fn(async () => null),
			recordFailure: vi.fn(),
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
			runState: vi.fn(async () => ({
				runId: null,
				phase: "idle" as const,
				cursor: null,
			})),
			markAndAdvance: vi.fn(async () => true),
			recordInventoryFailure: vi.fn(),
			claimDeleteBatch: vi.fn(async () => null),
			recordFailure: vi.fn(),
			finish: vi.fn(),
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
		expect(repository.markAndAdvance).not.toHaveBeenCalled();
		expect(repository.clear).not.toHaveBeenCalled();
		expect(storage.delete).not.toHaveBeenCalled();
	});
});
