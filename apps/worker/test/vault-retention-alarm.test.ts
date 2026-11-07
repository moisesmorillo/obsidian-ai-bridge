import { env, runInDurableObject } from "cloudflare:test";
import { changeLogicalPayloadBytes } from "@worker/infrastructure/sqlite/capacity";
import { describe, expect, it } from "vitest";

/** Milliseconds in one retention day for the alarm continuation fixture. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** UTC hour used by the native retention scheduler after its final batch. */
const RETENTION_NIGHTLY_HOUR_UTC = 3;

/** Return the next 03:00 UTC deadline after a given epoch timestamp. */
function expectedNextNightlyDeadline(now: number): number {
	const current = new Date(now);
	const todayAtNightly = Date.UTC(
		current.getUTCFullYear(),
		current.getUTCMonth(),
		current.getUTCDate(),
		RETENTION_NIGHTLY_HOUR_UTC,
	);
	return now < todayAtNightly
		? todayAtNightly
		: Date.UTC(
				current.getUTCFullYear(),
				current.getUTCMonth(),
				current.getUTCDate() + 1,
				RETENTION_NIGHTLY_HOUR_UTC,
			);
}

/** Insert expired feed rows and set their complete logical byte counters. */
function seedExpiredFeed(
	storage: DurableObjectStorage,
	count: number,
	now: number,
): void {
	let bytes = 0;
	for (let seq = 1; seq <= count; seq += 1) {
		const at = now - 31 * DAY_MS;
		const row = {
			seq,
			op: "put",
			path: `feed/${seq}.md`,
			rev: 1,
			hash: `hash-${seq}`,
			origin: "alarm-test",
			at,
		};
		storage.sql.exec(
			"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			row.seq,
			row.op,
			row.path,
			row.rev,
			row.hash,
			row.origin,
			row.at,
		);
		bytes += changeLogicalPayloadBytes(row);
	}
	storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = 'head_seq'",
		String(count),
	);
	storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = 'history_changes_bytes'",
		String(bytes),
	);
	storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = 'history_pressure_bytes'",
		String(bytes),
	);
}

/** Install local service fakes that return selected alarm work states. */
function setAlarmWork(
	instance: object,
	work: { retentionMore?: boolean; exportsPending?: boolean; gcMore?: boolean },
): void {
	Reflect.set(instance, "retentionStore", {
		runBatch: () => ({ more: work.retentionMore ?? false }),
	});
	Reflect.set(instance, "packedExportService", {
		runBatch: async () => work.exportsPending ?? false,
	});
	Reflect.set(instance, "blobGcService", {
		collectBatch: async () => ({
			phase: work.gcMore ? "marking" : "idle",
			delete_state: "idle",
		}),
	});
}

/** Run actual Vault alarm delivery against native SQLite retention. */
describe("Vault retention alarm lifecycle", () => {
	it.each([
		["an export alone", { exportsPending: true }, 1_000],
		[
			"an export with retention and GC work",
			{ exportsPending: true, retentionMore: true, gcMore: true },
			1_000,
		],
		["retention work alone", { retentionMore: true }, 60_000],
		["GC work alone", { gcMore: true }, 60_000],
	])(
		"schedules %s at its continuation interval",
		async (_case, work, maxDelay) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (instance, state) => {
				setAlarmWork(instance, work);
				const before = Date.now();

				await instance.alarm();

				const nextAlarm = await state.storage.getAlarm();
				expect(nextAlarm).not.toBeNull();
				expect(nextAlarm).toBeGreaterThanOrEqual(before);
				expect(nextAlarm).toBeLessThanOrEqual(before + maxDelay);
			});
		},
	);

	it("keeps the nightly alarm when no export, retention, or GC work remains", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (instance, state) => {
			setAlarmWork(instance, {});
			const before = Date.now();

			await instance.alarm();

			const after = Date.now();
			const deadlinesDuringAlarm = new Set([
				expectedNextNightlyDeadline(before),
				expectedNextNightlyDeadline(after),
			]);
			expect([...deadlinesDuringAlarm]).toContain(
				await state.storage.getAlarm(),
			);
		});
	});
	it.each([
		[
			"the final minute before 03:00 UTC",
			"2026-10-28T02:59:30.000Z",
			"2026-10-28T03:00:00.000Z",
		],
		[
			"the exact 03:00 UTC boundary",
			"2026-10-28T03:00:00.000Z",
			"2026-10-29T03:00:00.000Z",
		],
		[
			"after the 03:00 UTC boundary",
			"2026-10-28T03:00:01.000Z",
			"2026-10-29T03:00:00.000Z",
		],
	])("expects the next nightly deadline at %s", (_case, now, expected) => {
		expect(expectedNextNightlyDeadline(Date.parse(now))).toBe(
			Date.parse(expected),
		);
	});

	it("schedules bounded continuation separately from the nightly cycle and resumes after each alarm", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (instance, state) => {
			const initialAlarm = await state.storage.getAlarm();
			expect(initialAlarm).toBeGreaterThan(Date.now());
			seedExpiredFeed(state.storage, 65, Date.now());

			await instance.alarm();

			expect(
				state.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toHaveLength(1);
			expect(
				state.storage.sql
					.exec(
						"SELECT value FROM meta WHERE key = 'retention_pruned_feed_seq'",
					)
					.toArray(),
			).toEqual([{ value: "65" }]);
			const continuation = await state.storage.getAlarm();
			expect(continuation).toBeGreaterThan(Date.now());
			expect(continuation).toBeLessThanOrEqual(Date.now() + 60_000);

			const beforeNightlyAlarm = Date.now();
			await instance.alarm();
			const afterNightlyAlarm = Date.now();

			expect(
				state.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toEqual([]);
			expect(
				state.storage.sql
					.exec(
						"SELECT value FROM meta WHERE key = 'retention_pruned_feed_seq'",
					)
					.toArray(),
			).toEqual([{ value: "66" }]);
			const nightly = await state.storage.getAlarm();
			const deadlinesDuringAlarm = new Set([
				expectedNextNightlyDeadline(beforeNightlyAlarm),
				expectedNextNightlyDeadline(afterNightlyAlarm),
			]);
			expect([...deadlinesDuringAlarm]).toContain(nightly);
		});
	});

	it("does not poll an unresolved durable blob delete claim", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (instance, state) => {
			const owner = "55555555-5555-4555-8555-555555555555";
			state.storage.sql.exec(
				"UPDATE meta SET value = 'deleting' WHERE key = 'blob_gc_phase'",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = '11111111-1111-4111-8111-111111111111' WHERE key = 'blob_gc_run_id'",
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = 'blob_gc_delete_owner'",
				owner,
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = 'unknown' WHERE key = 'blob_gc_delete_state'",
			);
			state.storage.sql.exec(
				"INSERT INTO blob_gc(hash,size,marked_at) VALUES (?,4,1)",
				"a".repeat(64),
			);
			const before = Date.now();

			await instance.alarm();

			const after = Date.now();
			const nextAlarm = await state.storage.getAlarm();
			expect(
				new Set([
					expectedNextNightlyDeadline(before),
					expectedNextNightlyDeadline(after),
				]),
			).toContain(nextAlarm);
			expect(
				state.storage.sql.exec("SELECT hash FROM blob_gc").toArray(),
			).toEqual([{ hash: "a".repeat(64) }]);
		});
	});

	it("keeps rows and durable progress intact after a native maintenance fault", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (instance, state) => {
			seedExpiredFeed(state.storage, 1, Date.now());
			state.storage.sql.exec(
				"UPDATE meta SET value = '0' WHERE key = 'history_changes_bytes'",
			);

			const before = Date.now();
			await expect(instance.alarm()).rejects.toThrow(
				"Invalid logical history metadata",
			);
			const after = Date.now();
			const retryAlarm = await state.storage.getAlarm();
			expect(retryAlarm).toBeGreaterThanOrEqual(before + 60_000);
			expect(retryAlarm).toBeLessThanOrEqual(after + 60_000);

			expect(
				state.storage.sql.exec("SELECT seq FROM changes").toArray(),
			).toEqual([{ seq: 1 }]);
			expect(
				state.storage.sql
					.exec(
						"SELECT value FROM meta WHERE key IN ('retention_category','retention_pruned_feed_seq') ORDER BY key",
					)
					.toArray(),
			).toEqual([{ value: "changes" }, { value: "0" }]);
		});
	});
});
