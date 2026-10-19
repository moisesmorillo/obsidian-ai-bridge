import type { Logger } from "drizzle-orm";

/**
 * Records application SQL dispatches, not successful executions or SQLite internal work.
 * Parameter values and identities never enter the retained observations.
 */
export class PublicationQueryObserver implements Logger {
	readonly queries: Array<{ sql: string; bindCount: number }> = [];

	/** Record a query without retaining its bound values. */
	logQuery(sql: string, params: unknown[]): void {
		this.queries.push({ sql, bindCount: params.length });
	}
}

/** Return SQLite's variable-integer byte width for non-negative record values. */
function varintSize(value: number): number {
	if (value < 0x80) return 1;
	if (value < 0x4000) return 2;
	if (value < 0x20_0000) return 3;
	if (value < 0x1000_0000) return 4;
	if (value < 0x8_0000_0000) return 5;
	if (value < 0x400_0000_0000) return 6;
	if (value < 0x2_0000_0000_0000) return 7;
	if (value < 0x1_0000_0000_0000_00) return 8;
	return 9;
}

/**
 * Encode one safe integer as its SQLite serial type and payload width in bytes.
 * Zero and one use serial types 8 and 9 with no payload bytes.
 */
function integerRecordEncoding(value: number): {
	serial: number;
	payload: number;
} {
	if (value === 0) return { serial: 8, payload: 0 };
	if (value === 1) return { serial: 9, payload: 0 };
	if (value >= -128 && value <= 127) return { serial: 1, payload: 1 };
	if (value >= -32_768 && value <= 32_767) return { serial: 2, payload: 2 };
	if (value >= -8_388_608 && value <= 8_388_607)
		return { serial: 3, payload: 3 };
	if (value >= -2_147_483_648 && value <= 2_147_483_647)
		return { serial: 4, payload: 4 };
	if (value >= -140_737_488_355_328 && value <= 140_737_488_355_327)
		return { serial: 5, payload: 6 };
	return { serial: 6, payload: 8 };
}

/**
 * Measure a SQLite record in bytes, with UTF-8 text, serial types, and the complete header.
 * Nulls, blobs, and safe integers use SQLite storage widths, including payload-free zero and one.
 * Reject other values. B-tree cells, rowids, indexes, and page overhead are separate database costs.
 */
export function sqliteRecordBytes(values: readonly unknown[]): number {
	const payloadSizes = values.map((value) => {
		if (value === null) return { serial: 0, payload: 0 };
		if (typeof value === "string") {
			const bytes = new TextEncoder().encode(value).byteLength;
			return { serial: bytes * 2 + 13, payload: bytes };
		}
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			const bytes = value.byteLength;
			return { serial: bytes * 2 + 12, payload: bytes };
		}
		if (typeof value !== "number" || !Number.isSafeInteger(value))
			throw new TypeError("SQLite record value is not supported");
		return integerRecordEncoding(value);
	});
	const payloadBytes = payloadSizes.reduce(
		(sum, item) => sum + item.payload,
		0,
	);
	let headerBytes =
		1 + payloadSizes.reduce((sum, item) => sum + varintSize(item.serial), 0);
	while (
		varintSize(headerBytes) +
			payloadSizes.reduce((sum, item) => sum + varintSize(item.serial), 0) !==
		headerBytes
	)
		headerBytes =
			varintSize(headerBytes) +
			payloadSizes.reduce((sum, item) => sum + varintSize(item.serial), 0);
	return headerBytes + payloadBytes;
}
