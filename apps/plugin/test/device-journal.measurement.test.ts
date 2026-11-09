import { createHash } from "node:crypto";
import type { DeviceState } from "@vaultwire/protocol";
import { describe, expect, it } from "vitest";
import type { DeviceJournalStorage } from "../src/sync/device-journal";
import { DeviceJournal } from "../src/sync/device-journal";

/** Exact number of synthetic payload bytes used for each measured operation. */
const PAYLOAD_BYTES = 1_000_001;
/** Number of independent samples used for median and nearest-rank p95. */
const MEASURED_REPETITIONS = 20;
const warmupRepetitions = 1;
const payload = new Uint8Array(PAYLOAD_BYTES).fill(0x61);
const hash = createHash("sha256").update(payload).digest("hex");
const precondition = { kind: "absent" as const };

/** Stores journal state as UTF-8 JSON and payloads as exact immutable byte copies. */
class SerializedJournalStorage implements DeviceJournalStorage {
	state: unknown = null;
	readonly payloads = new Map<string, Uint8Array>();
	stateWriteCount = 0;
	stateReadCount = 0;
	payloadWriteCount = 0;
	payloadReadCount = 0;
	persistedStateBytes = 0;
	persistedPayloadBytes = 0;

	/** Reads one JSON-cloned state document and counts the read operation. */
	async readState(): Promise<unknown> {
		this.stateReadCount += 1;
		return this.state === null ? null : JSON.parse(JSON.stringify(this.state));
	}

	/** Stores JSON state and adds its UTF-8 byte count to persisted volume. */
	async writeState(state: DeviceState): Promise<void> {
		this.stateWriteCount += 1;
		const serialized = JSON.stringify(state);
		this.persistedStateBytes += new TextEncoder().encode(serialized).byteLength;
		this.state = JSON.parse(serialized) as unknown;
	}

	/** Returns a defensive payload copy and counts one storage read. */
	async readPayload(path: string): Promise<Uint8Array> {
		this.payloadReadCount += 1;
		const value = this.payloads.get(path);
		if (!value) throw new Error(`Missing payload: ${path}`);
		return value.slice();
	}

	/** Stores a defensive payload copy and counts exact persisted payload bytes. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloadWriteCount += 1;
		this.persistedPayloadBytes += bytes.byteLength;
		this.payloads.set(path, bytes.slice());
	}
}

/** Measures one operation with the elapsed boundary outside its awaited journal work. */
async function elapsed(operation: () => Promise<void>): Promise<number> {
	const start = performance.now();
	await operation();
	return performance.now() - start;
}

/** Returns median and nearest-rank p95 values for measured elapsed milliseconds. */
function summarize(samples: number[]): { medianMs: number; p95Ms: number } {
	const sorted = [...samples].sort((left, right) => left - right);
	const medianLower = sorted[9];
	const medianUpper = sorted[10];
	const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
	if (
		medianLower === undefined ||
		medianUpper === undefined ||
		p95 === undefined
	)
		throw new Error("Expected at least 20 timing samples");
	return {
		medianMs: (medianLower + medianUpper) / 2,
		p95Ms: p95,
	};
}

const runMeasurement = process.env.OAB_JOURNAL_MEASURE === "1";

describe("DeviceJournal measurement contract", () => {
	it("counts serialized state and payload bytes at their persistence boundaries", async () => {
		const storage = new SerializedJournalStorage();
		const journal = await DeviceJournal.open(storage);
		const pending = await journal.enqueue(
			{ op: "put", path: "notes/large.md", precondition },
			payload,
		);
		const result = await journal.readPayload(
			pending.payload_ref,
			pending.payload_hash,
		);

		expect(result).toEqual(payload);
		expect(storage.payloadWriteCount).toBe(1);
		expect(storage.payloadReadCount).toBe(2);
		expect(storage.stateWriteCount).toBe(2);
		expect(storage.persistedPayloadBytes).toBe(PAYLOAD_BYTES);
		expect(storage.persistedStateBytes).toBeGreaterThan(0);
		journal.close();
	});

	(runMeasurement ? it : it.skip)(
		"reports isolated journal operation timing boundaries and persisted byte counts",
		async () => {
			const enqueueSamples: number[] = [];
			const reopenSamples: number[] = [];
			const payloadReadSamples: number[] = [];
			const totals = {
				stateBytes: 0,
				payloadBytes: 0,
				stateWrites: 0,
				payloadWrites: 0,
			};

			for (
				let repetition = 0;
				repetition < warmupRepetitions + MEASURED_REPETITIONS;
				repetition += 1
			) {
				const storage = new SerializedJournalStorage();
				let journal = await DeviceJournal.open(storage);
				const writeMs = await elapsed(async () => {
					const operation = await journal.enqueue(
						{ op: "put", path: "notes/large.md", precondition },
						payload,
					);
					const persisted = await storage.readPayload(operation.payload_ref);
					if (createHash("sha256").update(persisted).digest("hex") !== hash)
						throw new Error("Enqueue readback hash mismatch");
				});
				journal.close();
				const reopenMs = await elapsed(async () => {
					journal = await DeviceJournal.open(storage);
					if (journal.snapshot().pending_ops.length !== 1)
						throw new Error("Reopen did not recover the queued operation");
				});
				const operation = journal.snapshot().pending_ops[0];
				if (!operation) throw new Error("Missing recovered operation");
				const readMs = await elapsed(async () => {
					const persisted = await journal.readPayload(
						operation.payload_ref,
						operation.payload_hash,
					);
					if (createHash("sha256").update(persisted).digest("hex") !== hash)
						throw new Error("Payload read hash mismatch");
				});
				journal.close();
				if (repetition >= warmupRepetitions) {
					enqueueSamples.push(writeMs);
					reopenSamples.push(reopenMs);
					payloadReadSamples.push(readMs);
					totals.stateBytes += storage.persistedStateBytes;
					totals.payloadBytes += storage.persistedPayloadBytes;
					totals.stateWrites += storage.stateWriteCount;
					totals.payloadWrites += storage.payloadWriteCount;
				}
			}

			console.info(
				JSON.stringify({
					runtime: process.version,
					platform: `${process.platform}-${process.arch}`,
					payloadBytes: PAYLOAD_BYTES,
					warmupRepetitions,
					measuredRepetitions: MEASURED_REPETITIONS,
					operations: {
						enqueueWriteAndReadback: summarize(enqueueSamples),
						reopenRecovery: summarize(reopenSamples),
						hashVerifiedPayloadRead: summarize(payloadReadSamples),
					},
					persistedBytes: totals,
				}),
			);
		},
	);
});
