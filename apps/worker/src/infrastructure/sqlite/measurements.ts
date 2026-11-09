import {
	type MeasurementAggregate,
	MeasurementAggregateSchema,
} from "@vaultwire/protocol";
import type {
	MeasurementStorage,
	MeasurementStore,
} from "@worker/application/measurements";
import { vaultSchema } from "@worker/infrastructure/sqlite/schema-model";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Single durable value key for bounded, versioned UTC daily service observations. */
const MEASUREMENT_META_KEY = "service_measurements_v1";

/** SQLite-backed measurement state and owner-time storage observations for one Vault. */
export class SqliteMeasurementsStore implements MeasurementStore {
	private readonly db;

	/** Create a synchronous SQLite adapter over the selected Durable Object storage. */
	constructor(private readonly storage: DurableObjectStorage) {
		this.db = drizzle(storage, { schema: vaultSchema });
	}

	/** Apply one aggregate transition and its metadata write in a single native transaction. */
	update(
		change: (
			current: MeasurementAggregate | null,
		) => MeasurementAggregate | null,
	): void {
		this.db.transaction((tx) => {
			const value = tx.all<{ value: string }>(
				sql`SELECT value FROM meta WHERE key = ${MEASUREMENT_META_KEY}`,
			)[0]?.value;
			const parsed =
				value === undefined
					? null
					: MeasurementAggregateSchema.safeParse(JSON.parse(value));
			if (parsed && !parsed.success)
				throw new Error("Stored measurement aggregate is invalid");
			const next = change(parsed?.data ?? null);
			if (next === null) return;
			const encoded = JSON.stringify(MeasurementAggregateSchema.parse(next));
			tx.run(
				sql`INSERT INTO meta (key, value) VALUES (${MEASUREMENT_META_KEY}, ${encoded}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			);
		});
	}

	/** Return the validated aggregate or null when no daily observation exists. */
	read(): MeasurementAggregate | null {
		const value = this.db.all<{ value: string }>(
			sql`SELECT value FROM meta WHERE key = ${MEASUREMENT_META_KEY}`,
		)[0]?.value;
		if (value === undefined) return null;
		const parsed = MeasurementAggregateSchema.safeParse(JSON.parse(value));
		if (!parsed.success)
			throw new Error("Stored measurement aggregate is invalid");
		return parsed.data;
	}

	/** Read physical allocation and deduplicated current or retained blob references. */
	readStorage(): MeasurementStorage {
		try {
			const databaseBytes = this.storage.sql.databaseSize;
			const blobSummary = this.db.all<{
				bytes: number;
				inconsistent: number;
			}>(
				sql.raw(
					"SELECT COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(CASE WHEN min_size <> max_size THEN 1 ELSE 0 END), 0) AS inconsistent FROM (SELECT blob_hash, MIN(size) AS min_size, MAX(size) AS max_size, MIN(size) AS size FROM (SELECT blob_hash, size FROM files WHERE deleted = 0 AND blob_hash IS NOT NULL UNION ALL SELECT blob_hash, size FROM revisions WHERE deleted = 0 AND blob_hash IS NOT NULL) GROUP BY blob_hash)",
				),
			)[0];
			if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 0)
				return unknownStorage();
			if (!blobSummary || !Number.isSafeInteger(blobSummary.inconsistent))
				return unknownStorage();
			if (blobSummary.inconsistent > 0)
				return {
					database_bytes: { status: "observed", value: databaseBytes },
					referenced_blob_bytes: {
						status: "unknown",
						reason: "storage_error",
					},
				};
			const referenced = blobSummary.bytes;
			if (
				referenced === undefined ||
				!Number.isSafeInteger(referenced) ||
				referenced < 0
			)
				return unknownStorage();
			return {
				database_bytes: { status: "observed", value: databaseBytes },
				referenced_blob_bytes: { status: "observed", value: referenced },
			};
		} catch {
			return unknownStorage();
		}
	}
}

/** Build unknown storage fields when a read fails or references disagree on byte size. */
function unknownStorage(): MeasurementStorage {
	return {
		database_bytes: { status: "unknown", reason: "storage_error" },
		referenced_blob_bytes: { status: "unknown", reason: "storage_error" },
	};
}
