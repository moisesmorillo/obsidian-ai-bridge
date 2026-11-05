import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createMeasurementGateway } from "@worker/application/measurements";
import { SqliteMeasurementsStore } from "@worker/infrastructure/sqlite/measurements";
import { describe, expect, it } from "vitest";

/** Insert a current blob reference without storing or reading its content. */
function insertCurrentBlob(
	storage: DurableObjectStorage,
	path: string,
	hash: string,
	size: number,
	deleted = 0,
): void {
	storage.sql.exec(
		"INSERT INTO files (path, path_key, rev, seq, hash, size, kind, blob_hash, deleted, updated_at, origin) VALUES (?, ?, 1, 1, ?, ?, 'blob', ?, ?, 1, 'test')",
		path,
		path.toLowerCase(),
		hash,
		size,
		hash,
		deleted,
	);
}

/** Insert a retained blob revision that remains an authoritative reference. */
function insertRetainedBlob(
	storage: DurableObjectStorage,
	path: string,
	rev: number,
	hash: string,
	size: number,
	deleted = 0,
): void {
	storage.sql.exec(
		"INSERT INTO revisions (path, rev, hash, size, kind, blob_hash, deleted, origin, at) VALUES (?, ?, ?, ?, 'blob', ?, ?, 'test', 1)",
		path,
		rev,
		hash,
		size,
		hash,
		deleted,
	);
}

describe("native Vault measurement storage", () => {
	it("counts each referenced hash once and excludes deleted references", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const empty = new SqliteMeasurementsStore(state.storage).readStorage();
			expect(empty.referenced_blob_bytes).toEqual({
				status: "observed",
				value: 0,
			});
			insertCurrentBlob(state.storage, "live.md", "a".repeat(64), 20);
			insertRetainedBlob(state.storage, "live.md", 1, "a".repeat(64), 20);
			insertRetainedBlob(state.storage, "old.md", 1, "b".repeat(64), 30);
			insertCurrentBlob(state.storage, "deleted.md", "c".repeat(64), 40, 1);
			const result = new SqliteMeasurementsStore(state.storage).readStorage();
			expect(result.referenced_blob_bytes).toEqual({
				status: "observed",
				value: 50,
			});
			expect(result.database_bytes.status).toBe("observed");
		});
	});

	it("persists a request that arrives after its later-timestamp feed sample", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const store = new SqliteMeasurementsStore(state.storage);
			const gateway = createMeasurementGateway(store, () => 1_700_000_000_100);
			gateway.recordFeedPreparation({
				client_id: "device-1",
				observed_at: 1_700_000_000_020,
				duration_ms: 5,
			});
			gateway.recordRequest({
				client_id: "device-1",
				protocol: "rest",
				feed_request: true,
				observed_at: 1_700_000_000_000,
			});

			expect(
				new SqliteMeasurementsStore(state.storage).read()?.requests_rest,
			).toBe(1);
		});
	});

	it("keeps bounded daily state across adapter restart and preserves corrupt metadata", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const first = new SqliteMeasurementsStore(state.storage);
			createMeasurementGateway(first, () => 1_700_000_000_000).recordRequest({
				client_id: "device-1",
				protocol: "mcp",
				feed_request: false,
				observed_at: 1_700_000_000_000,
			});
			const restarted = new SqliteMeasurementsStore(state.storage);
			expect(restarted.read()?.requests_mcp).toBe(1);
			state.storage.sql.exec(
				"UPDATE meta SET value = ? WHERE key = ?",
				"{invalid-json",
				"service_measurements_v1",
			);
			expect(() => restarted.read()).toThrow();
			expect(() => restarted.update(() => null)).toThrow();
			expect(
				state.storage.sql
					.exec<{ value: string }>(
						"SELECT value FROM meta WHERE key = ?",
						"service_measurements_v1",
					)
					.toArray()[0]?.value,
			).toBe("{invalid-json");
		});
	});

	it("returns unknown when one blob hash has inconsistent observed sizes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			insertCurrentBlob(state.storage, "one.md", "d".repeat(64), 20);
			insertRetainedBlob(state.storage, "one.md", 1, "d".repeat(64), 21);
			const result = new SqliteMeasurementsStore(state.storage).readStorage();
			expect(result.database_bytes.status).toBe("observed");
			expect(result.referenced_blob_bytes).toEqual({
				status: "unknown",
				reason: "storage_error",
			});
		});
	});
});
