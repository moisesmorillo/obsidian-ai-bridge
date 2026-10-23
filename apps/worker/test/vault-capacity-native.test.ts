import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Lists native SQLite object names that own allocated pages. */
const allocatedObjectNames = (storage: DurableObjectStorage): string[] =>
	storage.sql
		.exec<{ name: string }>("SELECT DISTINCT name FROM dbstat")
		.toArray()
		.map(({ name }) => name);

describe("native SQLite capacity prerequisites", () => {
	it("measures allocation during a transaction and restores its size after rollback", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const { storage } = state;
			const baselineBytes = storage.sql.databaseSize;
			let transactionBytes = baselineBytes;
			expect(() =>
				storage.transactionSync(() => {
					storage.sql.exec(
						"CREATE TABLE native_capacity_probe (value TEXT NOT NULL)",
					);
					storage.sql.exec(
						"INSERT INTO native_capacity_probe(value) VALUES (?)",
						"x".repeat(32_000),
					);
					transactionBytes = storage.sql.databaseSize;
					throw new Error("rollback native capacity probe");
				}),
			).toThrow("rollback native capacity probe");
			expect(transactionBytes).toBeGreaterThan(baselineBytes);
			expect(storage.sql.databaseSize).toBe(baselineBytes);
			expect(
				storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name = 'native_capacity_probe'",
					)
					.toArray(),
			).toEqual([]);

			storage.sql.exec(
				"CREATE TABLE native_capacity_probe (value TEXT NOT NULL)",
			);
			storage.sql.exec(
				"INSERT INTO native_capacity_probe(value) VALUES (?)",
				"x".repeat(32_000),
			);
			const allocatedBytes = storage.sql.databaseSize;
			storage.sql.exec("DELETE FROM native_capacity_probe");
			storage.sql.exec(
				"INSERT INTO native_capacity_probe(value) VALUES (?)",
				"y".repeat(32_000),
			);
			expect(storage.sql.databaseSize).toBe(allocatedBytes);
		});
	});

	it("reports that exact object attribution is unavailable when dbstat is absent", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			expect(() => allocatedObjectNames(state.storage)).toThrow(
				/no such table: dbstat/,
			);
		});
	});
});
