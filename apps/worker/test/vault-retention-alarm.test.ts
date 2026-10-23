import { env, runInDurableObject } from "cloudflare:test";
import { changeLogicalPayloadBytes } from "@worker/infrastructure/sqlite/capacity";
import { describe, expect, it } from "vitest";

/** Milliseconds in one retention day for the alarm continuation fixture. */
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Run actual Vault alarm delivery against native SQLite retention. */
describe("Vault retention alarm lifecycle", () => {
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

			await instance.alarm();

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
			expect(nightly).toBeGreaterThan(Date.now() + 60_000);
		});
	});

	it("keeps rows and durable progress intact after a native maintenance fault", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (instance, state) => {
			seedExpiredFeed(state.storage, 1, Date.now());
			state.storage.sql.exec(
				"UPDATE meta SET value = '0' WHERE key = 'history_changes_bytes'",
			);

			await expect(instance.alarm()).rejects.toThrow(
				"Invalid logical history metadata",
			);

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
