/** ZIP32 upper bound shared by member sizes, offsets, and encoded archive size. */
export const ZIP32_MAX_VALUE = 0xffff_ffff;
/** Maximum immutable source range consumed by one ZIP cursor step. */
export const ZIP32_SOURCE_RANGE_BYTES = 65_536;

/** Exact encoded member or archive bounds cannot fit the selected ZIP32 envelope. */
export class Zip32LimitFailure extends Error {
	/** Preserve one diagnostic for archive, member-size, and unsafe-path limits. */
	constructor(message = "ZIP32 archive limit exceeded") {
		super(message);
	}
}

/** One immutable member range did not match its declared size. */
export class Zip32SourceFailure extends Error {
	/** Mark a zero-length or oversized source range before cursor progress commits. */
	constructor() {
		super("Invalid ZIP32 source range");
	}
}

/** Persisted or runtime cursor fields do not match the ZIP32 state representation. */
export class Zip32CursorFailure extends Error {
	/** Mark missing or malformed ZIP continuation evidence as terminal corruption. */
	constructor() {
		super("Invalid persisted ZIP32 cursor");
	}
}

/** One current-file entry represented without retaining any payload bytes. */
export interface Zip32Member {
	/** Safe relative archive path encoded as UTF-8. */
	name: string;
	/** Exact stored payload byte count used by ZIP headers and limit checks. */
	size: number;
}

/** Serialized central-directory evidence carried across alarm invocations. */
interface Zip32DirectoryEntry {
	crc: number;
	offset: number;
}

/** Persisted ZIP writer cursor. Pending record bytes never exceed one ZIP header. */
export interface Zip32Cursor {
	/** Current ZIP record phase, including whether the final record is emitted. */
	phase: "local" | "data" | "descriptor" | "central" | "end" | "done";
	/** Zero-based member being written or indexed in the central directory. */
	memberIndex: number;
	/** Bytes read from the current member payload. */
	memberOffset: number;
	/** Unfinalized CRC-32 state for the current member payload. */
	memberCrc: number;
	/** Archive byte offset where the current local record started. */
	memberStart: number;
	/** Total ZIP bytes emitted before the next output chunk. */
	archiveOffset: number;
	/** Archive byte offset where the central directory starts. */
	centralOffset: number;
	/** Zero-based member whose central-directory record comes next. */
	centralIndex: number;
	/** CRC and local-record offset evidence for completed members. */
	directory: Zip32DirectoryEntry[];
	/** Unemitted bytes for one ZIP record, kept small across invocations. */
	pendingRecord: number[];
	/** Next byte index in `pendingRecord` for bounded output continuation. */
	pendingOffset: number;
}

/** Limits one ZIP step by produced archive bytes, source calls, and source bytes. */
export interface Zip32StepLimits {
	/** Maximum encoded ZIP bytes returned from one step. */
	maxOutputBytes: number;
	/** Maximum immutable source range calls made by one step. */
	maxSourceReads: number;
	/** Maximum raw payload bytes read by one step. */
	maxSourceBytes: number;
}

/** One bounded archive step and its serializable continuation cursor. */
export interface Zip32StepResult {
	/** Serializable state required to continue after the emitted bytes. */
	cursor: Zip32Cursor;
	/** Encoded ZIP bytes emitted by this bounded step. */
	bytes: Uint8Array;
	/** Immutable source range calls made during this step. */
	sourceReads: number;
	/** Raw payload bytes consumed during this step. */
	sourceBytes: number;
}

/** Read one immutable member range at the exact supplied byte offset. */
export type Zip32MemberReader = (
	member: number,
	offset: number,
	length: number,
) => Promise<Uint8Array>;

/** UTF-8 encoder shared by ZIP member names and manifest bytes. */
const utf8 = new TextEncoder();

/** CRC-32/ISO-HDLC lookup table for resumable ZIP data checksums. */
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1)
		value = value & 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
	return value >>> 0;
});

/**
 * Create a fresh ZIP32 cursor after validating every path and exact encoded-size bound.
 * Member payloads remain external and are read only when a caller advances the cursor.
 * @throws If the member list exceeds `maxArchiveBytes` or contains an unsafe archive path.
 */
export function createZip32Cursor(
	members: readonly Zip32Member[],
	maxArchiveBytes = ZIP32_MAX_VALUE,
): Zip32Cursor {
	if (
		members.length > 0xffff ||
		!Number.isSafeInteger(maxArchiveBytes) ||
		maxArchiveBytes < 22 ||
		maxArchiveBytes > ZIP32_MAX_VALUE
	)
		throw new Zip32LimitFailure();
	let encodedSize = 22;
	for (const member of members) {
		const name = safeMemberName(member.name);
		if (!Number.isSafeInteger(member.size) || member.size < 0)
			throw new Zip32LimitFailure("Invalid ZIP32 member size");
		encodedSize += 30 + name.byteLength + member.size + 16;
		encodedSize += 46 + name.byteLength;
		if (member.size > ZIP32_MAX_VALUE || encodedSize > maxArchiveBytes)
			throw new Zip32LimitFailure();
	}
	return {
		phase: members.length === 0 ? "end" : "local",
		memberIndex: 0,
		memberOffset: 0,
		memberCrc: 0xffff_ffff,
		memberStart: 0,
		archiveOffset: 0,
		centralOffset: 0,
		centralIndex: 0,
		directory: [],
		pendingRecord: [],
		pendingOffset: 0,
	};
}

/**
 * Advance a stored ZIP32 stream with strict output, read-count, and source-byte budgets.
 * The returned cursor can be persisted after each call and resumed without duplicate bytes.
 * @throws If a source range is empty before declared EOF or returns more bytes than requested.
 */
export async function advanceZip32(
	members: readonly Zip32Member[],
	inputCursor: Zip32Cursor,
	readMember: Zip32MemberReader,
	limits: Zip32StepLimits,
): Promise<Zip32StepResult> {
	validateStepLimits(limits);
	const cursor = structuredClone(inputCursor);
	const chunks: Uint8Array[] = [];
	let outputBytes = 0;
	let sourceReads = 0;
	let sourceBytes = 0;

	stepLoop: while (
		outputBytes < limits.maxOutputBytes &&
		(cursor.phase !== "done" ||
			cursor.pendingOffset < cursor.pendingRecord.length)
	) {
		if (cursor.pendingOffset < cursor.pendingRecord.length) {
			const end = Math.min(
				cursor.pendingRecord.length,
				cursor.pendingOffset + limits.maxOutputBytes - outputBytes,
			);
			const bytes = Uint8Array.from(
				cursor.pendingRecord.slice(cursor.pendingOffset, end),
			);
			chunks.push(bytes);
			cursor.pendingOffset = end;
			cursor.archiveOffset += bytes.byteLength;
			outputBytes += bytes.byteLength;
			if (cursor.pendingOffset === cursor.pendingRecord.length) {
				cursor.pendingRecord = [];
				cursor.pendingOffset = 0;
			}
			continue;
		}

		switch (cursor.phase) {
			case "local": {
				if (cursor.memberIndex >= members.length) {
					cursor.centralOffset = cursor.archiveOffset;
					cursor.phase = "central";
					continue;
				}
				const member = members[cursor.memberIndex];
				if (!member) throw new Zip32CursorFailure();
				cursor.memberStart = cursor.archiveOffset;
				cursor.memberOffset = 0;
				cursor.memberCrc = 0xffff_ffff;
				cursor.phase = "data";
				cursor.pendingRecord = localHeader(member);
				continue;
			}
			case "data": {
				const member = members[cursor.memberIndex];
				if (!member) throw new Zip32CursorFailure();
				if (cursor.memberOffset === member.size) {
					cursor.phase = "descriptor";
					continue;
				}
				if (
					sourceReads >= limits.maxSourceReads ||
					sourceBytes >= limits.maxSourceBytes
				)
					break stepLoop;
				const remainingOutput = limits.maxOutputBytes - outputBytes;
				const length = Math.min(
					ZIP32_SOURCE_RANGE_BYTES,
					member.size - cursor.memberOffset,
					limits.maxSourceBytes - sourceBytes,
					remainingOutput,
				);
				if (length <= 0) break;
				const bytes = await readMember(
					cursor.memberIndex,
					cursor.memberOffset,
					length,
				);
				sourceReads += 1;
				if (bytes.byteLength === 0 || bytes.byteLength > length)
					throw new Zip32SourceFailure();
				chunks.push(bytes);
				cursor.memberCrc = updateCrc32(cursor.memberCrc, bytes);
				cursor.memberOffset += bytes.byteLength;
				cursor.archiveOffset += bytes.byteLength;
				outputBytes += bytes.byteLength;
				sourceBytes += bytes.byteLength;
				continue;
			}
			case "descriptor": {
				const member = members[cursor.memberIndex];
				if (!member) throw new Zip32CursorFailure();
				cursor.directory[cursor.memberIndex] = {
					crc: (cursor.memberCrc ^ 0xffff_ffff) >>> 0,
					offset: cursor.memberStart,
				};
				cursor.pendingRecord = dataDescriptor(
					cursor.directory[cursor.memberIndex]?.crc ?? 0,
					member.size,
				);
				cursor.memberIndex += 1;
				cursor.phase = "local";
				continue;
			}
			case "central": {
				if (cursor.centralIndex >= members.length) {
					cursor.phase = "end";
					continue;
				}
				const member = members[cursor.centralIndex];
				const entry = cursor.directory[cursor.centralIndex];
				if (!member || !entry) throw new Zip32CursorFailure();
				cursor.pendingRecord = centralHeader(member, entry);
				cursor.centralIndex += 1;
				continue;
			}
			case "end":
				cursor.pendingRecord = endRecord(
					members.length,
					cursor.centralOffset,
					cursor.archiveOffset - cursor.centralOffset,
				);
				cursor.phase = "done";
				continue;
		}
	}

	return {
		cursor,
		bytes: concatenate(chunks, outputBytes),
		sourceReads,
		sourceBytes,
	};
}

/** Validate durable ZIP continuation state before resuming untrusted SQLite JSON. */
export function parseZip32Cursor(serialized: string): Zip32Cursor {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Zip32CursorFailure();
	}
	if (!isRecord(value)) throw new Zip32CursorFailure();
	const phases = ["local", "data", "descriptor", "central", "end", "done"];
	const directory = value.directory;
	const pendingRecord = value.pendingRecord;
	if (
		!phases.includes(String(value.phase)) ||
		!isUnsigned(value.memberIndex, 0xffff) ||
		!isUnsigned(value.memberOffset, ZIP32_MAX_VALUE) ||
		!isUnsigned(value.memberCrc, ZIP32_MAX_VALUE) ||
		!isUnsigned(value.memberStart, ZIP32_MAX_VALUE) ||
		!isUnsigned(value.archiveOffset, ZIP32_MAX_VALUE) ||
		!isUnsigned(value.centralOffset, ZIP32_MAX_VALUE) ||
		!isUnsigned(value.centralIndex, 0xffff) ||
		!Array.isArray(directory) ||
		!Array.isArray(pendingRecord) ||
		!pendingRecord.every((byte) => isUnsigned(byte, 255)) ||
		!isUnsigned(value.pendingOffset, pendingRecord.length) ||
		!directory.every(
			(entry) =>
				isRecord(entry) &&
				isUnsigned(entry.crc, ZIP32_MAX_VALUE) &&
				isUnsigned(entry.offset, ZIP32_MAX_VALUE),
		)
	)
		throw new Zip32CursorFailure();
	return {
		phase: value.phase as Zip32Cursor["phase"],
		memberIndex: value.memberIndex,
		memberOffset: value.memberOffset,
		memberCrc: value.memberCrc,
		memberStart: value.memberStart,
		archiveOffset: value.archiveOffset,
		centralOffset: value.centralOffset,
		centralIndex: value.centralIndex,
		directory: directory.map((entry) => ({
			crc: (entry as Record<string, number>).crc,
			offset: (entry as Record<string, number>).offset,
		})),
		pendingRecord: pendingRecord as number[],
		pendingOffset: value.pendingOffset,
	};
}

/** Show whether ZIP EOF and every pending end-record byte were emitted. */
export function isZip32Complete(cursor: Zip32Cursor): boolean {
	return (
		cursor.phase === "done" &&
		cursor.pendingOffset === cursor.pendingRecord.length
	);
}

/** Check one parsed JSON object without admitting arrays or null values. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one nonnegative safe integer against its ZIP field maximum. */
function isUnsigned(value: unknown, maximum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= maximum
	);
}

/** Validate local fairness limits before reading any source or changing persisted progress. */
function validateStepLimits(limits: Zip32StepLimits): void {
	if (
		!Number.isSafeInteger(limits.maxOutputBytes) ||
		limits.maxOutputBytes < 1 ||
		!Number.isSafeInteger(limits.maxSourceReads) ||
		limits.maxSourceReads < 0 ||
		!Number.isSafeInteger(limits.maxSourceBytes) ||
		limits.maxSourceBytes < 0
	)
		throw new Error("Invalid ZIP32 step limits");
}

/** Validate a relative POSIX archive name and return its exact UTF-8 bytes. */
function safeMemberName(name: string): Uint8Array {
	if (
		name.length === 0 ||
		name.startsWith("/") ||
		name.includes("\\") ||
		name.split("/").some((part) => part === "" || part === "." || part === "..")
	)
		throw new Zip32LimitFailure("Invalid ZIP32 member path");
	const bytes = utf8.encode(name);
	if (bytes.byteLength > 0xffff)
		throw new Zip32LimitFailure("ZIP32 member name is too long");
	return bytes;
}

/** Encode one UTF-8 store-only local header with a trailing data descriptor. */
function localHeader(member: Zip32Member): number[] {
	const name = safeMemberName(member.name);
	const bytes = new Uint8Array(30 + name.byteLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x0403_4b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(6, 0x0808, true);
	view.setUint16(8, 0, true);
	view.setUint16(10, 0, true);
	view.setUint16(12, 0x0021, true);
	view.setUint32(18, member.size, true);
	view.setUint32(22, member.size, true);
	view.setUint16(26, name.byteLength, true);
	bytes.set(name, 30);
	return [...bytes];
}

/** Encode the ZIP32 data descriptor after one complete member body. */
function dataDescriptor(crc: number, size: number): number[] {
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x0807_4b50, true);
	view.setUint32(4, crc, true);
	view.setUint32(8, size, true);
	view.setUint32(12, size, true);
	return [...bytes];
}

/** Encode one central-directory record from captured member metadata and computed CRC evidence. */
function centralHeader(
	member: Zip32Member,
	entry: Zip32DirectoryEntry,
): number[] {
	const name = safeMemberName(member.name);
	const bytes = new Uint8Array(46 + name.byteLength);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x0201_4b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(6, 20, true);
	view.setUint16(8, 0x0808, true);
	view.setUint16(10, 0, true);
	view.setUint16(12, 0, true);
	view.setUint16(14, 0x0021, true);
	view.setUint32(16, entry.crc, true);
	view.setUint32(20, member.size, true);
	view.setUint32(24, member.size, true);
	view.setUint16(28, name.byteLength, true);
	view.setUint32(42, entry.offset, true);
	bytes.set(name, 46);
	return [...bytes];
}

/** Encode the final ZIP32 end-of-central-directory record. */
function endRecord(count: number, offset: number, size: number): number[] {
	const bytes = new Uint8Array(22);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 0x0605_4b50, true);
	view.setUint16(8, count, true);
	view.setUint16(10, count, true);
	view.setUint32(12, size, true);
	view.setUint32(16, offset, true);
	return [...bytes];
}

/** Update unfinalized CRC-32 state for one streamed payload range. */
function updateCrc32(previous: number, bytes: Uint8Array): number {
	let crc = previous;
	for (const byte of bytes)
		crc = ((crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
	return crc;
}

/** Join one bounded step without retaining bytes from earlier invocations. */
function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
