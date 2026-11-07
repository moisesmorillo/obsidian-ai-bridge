import {
	advanceZip32,
	createZip32Cursor,
	isZip32Complete,
	ZIP32_MAX_VALUE,
} from "@worker/application/export-zip";
import { describe, expect, it } from "vitest";

const members = [
	{ name: "manifest.json", size: 2 },
	{ name: "files/note.md", size: 5 },
];
const sources = [
	new TextEncoder().encode("{}"),
	new TextEncoder().encode("hello"),
];

/** Collect a ZIP only in this small deterministic test fixture. */
async function archiveWithTinyBatches(): Promise<Uint8Array> {
	let cursor = createZip32Cursor(members);
	const output: Uint8Array[] = [];
	for (let batch = 0; batch < 1_000 && !isZip32Complete(cursor); batch += 1) {
		const step = await advanceZip32(
			members,
			cursor,
			async (member: number, offset: number, length: number) =>
				sources[member]?.slice(offset, offset + length) ?? new Uint8Array(),
			{
				maxOutputBytes: 17,
				maxSourceReads: 2,
				maxSourceBytes: 4,
			},
		);
		expect(step.bytes.byteLength).toBeLessThanOrEqual(17);
		expect(step.sourceReads).toBeLessThanOrEqual(2);
		expect(step.sourceBytes).toBeLessThanOrEqual(4);
		output.push(step.bytes);
		cursor = step.cursor;
	}
	if (!isZip32Complete(cursor))
		throw new Error(`ZIP32 cursor stalled at ${JSON.stringify(cursor)}`);
	return concatenate(output);
}

/** Concatenate bounded test batches into one fixture archive. */
function concatenate(chunks: Uint8Array[]): Uint8Array {
	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

describe("resumable ZIP32 encoder", () => {
	it("resumes between bounded reads and emits stored file bytes with a central directory", async () => {
		const archive = await archiveWithTinyBatches();
		const view = new DataView(
			archive.buffer,
			archive.byteOffset,
			archive.byteLength,
		);
		expect(view.getUint32(0, true)).toBe(0x04034b50);
		expect(new TextDecoder().decode(archive)).toContain("manifest.json");
		expect(new TextDecoder().decode(archive)).toContain("files/note.md");
		expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
	});

	it("rejects exact encoded sizes beyond ZIP32 and the 2 GB product envelope", () => {
		expect(() =>
			createZip32Cursor([{ name: "files/large", size: ZIP32_MAX_VALUE }]),
		).toThrow("ZIP32 archive limit exceeded");
		expect(() =>
			createZip32Cursor(
				[{ name: "files/large", size: 1_999_999_999 }],
				2_000_000_000,
			),
		).toThrow("ZIP32 archive limit exceeded");
		const exactBoundary = [
			{ name: "manifest.json", size: 0 },
			{ name: "files/large", size: 1_999_999_746 },
		];
		expect(createZip32Cursor(exactBoundary, 2_000_000_000).phase).toBe("local");
		expect(() =>
			createZip32Cursor(
				[
					{ name: "manifest.json", size: 1 },
					{ name: "files/large", size: 1_999_999_746 },
				],
				2_000_000_000,
			),
		).toThrow("ZIP32 archive limit exceeded");
	});
});
