import { beforeEach, describe, expect, it } from "vitest";
import { DeviceJournal } from "../src/sync/device-journal";

/** Isolates journal persistence and supports deterministic failure injection. */
class MemoryStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	failStateWrite = false;
	throwStateWrite = false;
	failPayloadWrite = false;

	/** Returns the current untrusted state document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Replaces state or simulates a dropped whole-document write. */
	async writeState(value: unknown): Promise<void> {
		if (this.throwStateWrite) throw new Error("state write failed");
		if (this.failStateWrite) return;
		this.state = structuredClone(value);
	}
	/** Returns a defensive copy of stored operation bytes. */
	async readPayload(path: string): Promise<Uint8Array> {
		const bytes = this.payloads.get(path);
		if (!bytes) throw new Error("missing payload");
		return bytes.slice();
	}
	/** Stores a defensive copy or injects a payload persistence failure. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		if (this.failPayloadWrite) throw new Error("payload write failed");
		this.payloads.set(path, bytes.slice());
	}
}

const bytes = new TextEncoder().encode("immutable content");
const precondition = { kind: "match" as const, epoch: "b".repeat(32), rev: 4 };

describe("DeviceJournal", () => {
	let storage: MemoryStorage;
	beforeEach(() => {
		storage = new MemoryStorage();
	});

	it("creates and reuses a stable device identity", async () => {
		const first = await DeviceJournal.open(storage);
		const id = first.snapshot().device_id;
		first.close();
		expect((await DeviceJournal.open(storage)).snapshot().device_id).toBe(id);
	});

	it("serializes client identity changes without losing queued operations", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		await Promise.all([
			journal.setClientId("registered-client"),
			journal.enqueue({ op: "put", path: "notes/b.md", precondition }, bytes),
		]);
		expect(journal.snapshot().client_id).toBe("registered-client");
		expect(journal.snapshot().pending_ops[0]?.key).toBe(operation.key);
		expect(journal.snapshot().pending_ops).toHaveLength(2);
	});

	it("rejects corrupt state without replacing it", async () => {
		storage.state = { version: 77, device_id: "bad", pending_ops: [] };
		await expect(DeviceJournal.open(storage)).rejects.toThrow();
		expect(storage.state).toEqual({
			version: 77,
			device_id: "bad",
			pending_ops: [],
		});
	});

	it("blocks send when a whole-document write does not read back", async () => {
		const journal = await DeviceJournal.open(storage);
		storage.failStateWrite = true;
		await expect(
			journal.enqueue({ op: "put", path: "notes/a.md", precondition }, bytes),
		).rejects.toThrow();
		await expect(
			journal.prepareSend("018f47b2-5c00-7000-8000-000000000001", precondition),
		).rejects.toThrow();
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(journal.attentionReason).toBe(
			"Device journal storage needs attention",
		);
		storage.failStateWrite = false;
		await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		expect(journal.attentionReason).toBeNull();
	});

	it("blocks queueing when document persistence throws", async () => {
		const journal = await DeviceJournal.open(storage);
		storage.throwStateWrite = true;
		await expect(
			journal.enqueue({ op: "put", path: "notes/a.md", precondition }, bytes),
		).rejects.toThrow("state write failed");
		expect(journal.snapshot().pending_ops).toEqual([]);
	});

	it("blocks queueing when payload persistence fails", async () => {
		const journal = await DeviceJournal.open(storage);
		storage.failPayloadWrite = true;
		await expect(
			journal.enqueue({ op: "put", path: "notes/a.md", precondition }, bytes),
		).rejects.toThrow("payload write failed");
		expect(journal.snapshot().pending_ops).toEqual([]);
	});

	it("rejects a payload that changes after enqueue", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		storage.payloads.set(operation.payload_ref, new Uint8Array([9]));
		await expect(
			journal.prepareSend(operation.key, precondition),
		).rejects.toThrow("Payload verification failed");
	});

	it("preserves a create-only precondition exactly across a sent retry", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/new.md", precondition: { kind: "absent" } },
			bytes,
		);
		const sent = await journal.prepareSend(operation.key, { kind: "absent" });
		const retry = await journal.prepareSend(operation.key, { kind: "absent" });
		expect(retry.operation.precondition).toEqual({ kind: "absent" });
		expect(retry.operation).toEqual(sent.operation);
		await expect(
			journal.prepareSend(operation.key, precondition),
		).rejects.toThrow("immutable");
	});

	it("persists payload bytes before state and retries the same sent operation after restart", async () => {
		const journal = await DeviceJournal.open(storage);
		const sourceBytes = bytes.slice();
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			sourceBytes,
		);
		sourceBytes.fill(0);
		const sent = await journal.prepareSend(first.key, precondition);
		sent.bytes.fill(0);
		const restarted = await DeviceJournal.open(storage);
		const retry = await restarted.prepareSend(first.key, precondition);
		expect(retry.operation).toEqual(sent.operation);
		expect(retry.bytes).toEqual(bytes);
		await expect(
			restarted.prepareSend(first.key, {
				kind: "match",
				epoch: "c".repeat(32),
				rev: 5,
			}),
		).rejects.toThrow("immutable");
	});

	it("replaces only queued edits with a new UUIDv7 key", async () => {
		const journal = await DeviceJournal.open(storage);
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		const next = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		expect(next.key).not.toBe(first.key);
		expect(next.key).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(journal.snapshot().pending_ops).toHaveLength(1);
		expect(journal.snapshot().pending_ops[0]?.key).toBe(next.key);
	});

	it("keeps a queued successor behind a sent predecessor", async () => {
		const journal = await DeviceJournal.open(storage);
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		await journal.prepareSend(first.key, precondition);
		const second = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		expect(second.key).not.toBe(first.key);
		await expect(
			journal.prepareSend(second.key, precondition),
		).rejects.toThrow();
	});

	it("serializes concurrent send preparations behind a sent predecessor", async () => {
		const journal = await DeviceJournal.open(storage);
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		await journal.prepareSend(first.key, precondition);
		const second = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		const results = await Promise.allSettled([
			journal.prepareSend(first.key, precondition),
			journal.prepareSend(second.key, precondition),
		]);
		expect(results[0]?.status).toBe("fulfilled");
		expect(results[1]?.status).toBe("rejected");
	});

	it("does not guess a queued successor precondition after resolution", async () => {
		const journal = await DeviceJournal.open(storage);
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		await journal.prepareSend(first.key, precondition);
		const successor = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition: { kind: "absent" } },
			bytes,
		);
		await journal.resolve(first.key, { kind: "receipt" });
		expect(journal.snapshot().pending_ops[0]?.precondition).toEqual({
			kind: "absent",
		});
		const sent = await journal.prepareSend(successor.key, precondition);
		expect(sent.operation.precondition).toEqual(precondition);
	});

	it("retains concurrent unrelated enqueues and defensive copies", async () => {
		const journal = await DeviceJournal.open(storage);
		const [one, two] = await Promise.all([
			journal.enqueue({ op: "put", path: "notes/a.md", precondition }, bytes),
			journal.enqueue({ op: "put", path: "notes/b.md", precondition }, bytes),
		]);
		one.key = "changed";
		const snapshot = journal.snapshot();
		snapshot.pending_ops.splice(0);
		expect(journal.snapshot().pending_ops).toHaveLength(2);
		await journal.prepareSend(two.key, precondition);
	});

	it("does not release a send after close during payload verification", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		let releaseRead: ((value: Uint8Array) => void) | undefined;
		let markReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		storage.readPayload = async () =>
			new Promise((resolve) => {
				releaseRead = resolve;
				markReadStarted?.();
			});
		const pending = journal.prepareSend(operation.key, precondition);
		await readStarted;
		journal.close();
		releaseRead?.(bytes.slice());
		await expect(pending).rejects.toThrow("closed");
	});

	it("snapshots enqueue inputs and bytes before waiting on serialized work", async () => {
		const journal = await DeviceJournal.open(storage);
		let releaseWrite: (() => void) | undefined;
		let markWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		const originalWritePayload = storage.writePayload.bind(storage);
		storage.writePayload = async (path, value) => {
			markWriteStarted?.();
			await new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
			await originalWritePayload(path, value);
		};
		const input: {
			op: "put";
			path: string;
			precondition: typeof precondition | { kind: "absent" };
		} = { op: "put", path: "notes/a.md", precondition };
		const sourceBytes = bytes.slice();
		const pending = journal.enqueue(input, sourceBytes);
		await writeStarted;
		input.path = "notes/changed.md";
		input.precondition = { kind: "absent" };
		sourceBytes.fill(0);
		releaseWrite?.();
		const operation = await pending;
		expect(operation.path).toBe("notes/a.md");
		expect(operation.precondition).toEqual(precondition);
		expect(await storage.readPayload(operation.payload_ref)).toEqual(bytes);
	});

	it("never sends an operation persisted as resolved", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		const state = journal.snapshot();
		state.pending_ops = state.pending_ops.map((pending: typeof operation) => ({
			...pending,
			state: "resolved" as const,
		}));
		storage.state = state;
		const reopened = await DeviceJournal.open(storage);
		await expect(
			reopened.prepareSend(operation.key, precondition),
		).rejects.toThrow();
	});

	it("blocks a sent retry until attention clears with a verified write", async () => {
		const journal = await DeviceJournal.open(storage);
		const first = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		await journal.prepareSend(first.key, precondition);
		storage.failStateWrite = true;
		await expect(
			journal.enqueue({ op: "put", path: "notes/b.md", precondition }, bytes),
		).rejects.toThrow();
		await expect(
			journal.prepareSend(first.key, precondition),
		).rejects.toThrow();
		expect(journal.attentionReason).not.toBeNull();
	});

	it("blocks a queued edit behind a queued rename destination until its receipt", async () => {
		const journal = await DeviceJournal.open(storage);
		const rename = await journal.enqueue(
			{
				op: "rename",
				path: "notes/a.md",
				to: "notes/b.md",
				precondition,
			},
			bytes,
		);
		const destinationEdit = await journal.enqueue(
			{ op: "put", path: "notes/b.md", precondition },
			bytes,
		);

		await expect(
			journal.prepareSend(destinationEdit.key, precondition),
		).rejects.toThrow("predecessor");
		await journal.prepareSend(rename.key, precondition);
		await journal.resolve(rename.key, { kind: "receipt" });
		const ready = await journal.prepareSend(destinationEdit.key, precondition);
		expect(ready.operation.key).toBe(destinationEdit.key);
	});

	it("blocks case-variant paths that identify the same queued file", async () => {
		const journal = await DeviceJournal.open(storage);
		await journal.enqueue(
			{
				op: "rename",
				path: "notes/A.md",
				to: "notes/B.md",
				precondition,
			},
			bytes,
		);
		const later = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);

		await expect(journal.prepareSend(later.key, precondition)).rejects.toThrow(
			"predecessor",
		);
	});

	it.each(["notes/a.md", "notes/b.md"])(
		"blocks a queued rename after an overlapping source or destination operation at %s",
		async (earlierPath) => {
			const journal = await DeviceJournal.open(storage);
			await journal.enqueue(
				{ op: "put", path: earlierPath, precondition },
				bytes,
			);
			const rename = await journal.enqueue(
				{
					op: "rename",
					path: "notes/a.md",
					to: "notes/b.md",
					precondition,
				},
				bytes,
			);

			await expect(
				journal.prepareSend(rename.key, precondition),
			).rejects.toThrow("predecessor");
		},
	);

	it("keeps an earlier queued operation when a later dependent operation follows it", async () => {
		const journal = await DeviceJournal.open(storage);
		const initialEdit = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		const rename = await journal.enqueue(
			{
				op: "rename",
				path: "notes/a.md",
				to: "notes/b.md",
				precondition,
			},
			bytes,
		);
		const newerEdit = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);

		expect(
			journal
				.snapshot()
				.pending_ops.map((operation: typeof initialEdit) => operation.key),
		).toEqual([initialEdit.key, rename.key, newerEdit.key]);
	});

	it("prepares unrelated queued paths concurrently", async () => {
		const journal = await DeviceJournal.open(storage);
		const [first, second] = await Promise.all([
			journal.enqueue({ op: "put", path: "notes/a.md", precondition }, bytes),
			journal.enqueue({ op: "put", path: "notes/b.md", precondition }, bytes),
		]);
		const results = await Promise.all([
			journal.prepareSend(first.key, precondition),
			journal.prepareSend(second.key, precondition),
		]);

		expect(results.map((result) => result.operation.key)).toEqual([
			first.key,
			second.key,
		]);
	});

	it("orders an operation behind a sent rename that targets its path", async () => {
		const journal = await DeviceJournal.open(storage);
		const rename = await journal.enqueue(
			{
				op: "rename",
				path: "notes/a.md",
				to: "notes/b.md",
				precondition,
			},
			bytes,
		);
		await journal.prepareSend(rename.key, precondition);
		const destinationEdit = await journal.enqueue(
			{ op: "put", path: "notes/b.md", precondition },
			bytes,
		);
		await expect(
			journal.prepareSend(destinationEdit.key, precondition),
		).rejects.toThrow();
	});

	it("close rejects new operations and preserves existing payloads", async () => {
		const journal = await DeviceJournal.open(storage);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/a.md", precondition },
			bytes,
		);
		journal.close();
		await expect(
			journal.enqueue({ op: "put", path: "notes/b.md", precondition }, bytes),
		).rejects.toThrow();
		expect(await storage.readPayload(operation.payload_ref)).toEqual(bytes);
	});
});
