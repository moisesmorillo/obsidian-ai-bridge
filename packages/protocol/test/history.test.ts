import {
	FileCommandSchema,
	formatETag,
	HistoryRequestSchema,
	HistoryResultSchema,
	RenameRequestSchema,
	RenameReservationSchema,
	RestoreRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

describe("canonical history contracts", () => {
	it("normalizes paths and rejects unknown command fields", () => {
		expect(RenameRequestSchema.parse({ to: "cafe\u0301.md" })).toEqual({
			to: "café.md",
		});
		expect(
			RenameRequestSchema.safeParse({ to: "note.md", extra: true }).success,
		).toBe(false);
	});

	it("validates the namespaced source-only rename reservation independently", () => {
		const epoch = "a".repeat(32);
		expect(
			RenameReservationSchema.parse({
				path: "notes/café.md",
				if_match: formatETag(epoch, 3),
			}),
		).toEqual({ path: "notes/café.md", if_match: formatETag(epoch, 3) });
		expect(
			RenameReservationSchema.safeParse({
				path: "note.md",
				if_match: formatETag(epoch, 3),
				epoch: "b".repeat(32),
			}).success,
		).toBe(false);
	});

	it("requires safe positive restore revisions and strict restore fields", () => {
		expect(
			RestoreRequestSchema.safeParse({
				source_rev: Number.MAX_SAFE_INTEGER + 1,
			}).success,
		).toBe(false);
		expect(
			RestoreRequestSchema.safeParse({ source_rev: 1, extra: true }).success,
		).toBe(false);
	});

	it("accepts only ordered content-free retained history", () => {
		const entry = {
			rev: 1,
			hash: "a".repeat(64),
			size: 3,
			deleted: false,
			origin: "client",
			at: 1,
		};
		expect(HistoryResultSchema.safeParse([entry]).success).toBe(true);
		expect(
			HistoryResultSchema.safeParse([{ ...entry, content: "body" }]).success,
		).toBe(false);
		expect(
			HistoryResultSchema.safeParse([
				{ ...entry, rev: 2 },
				{ ...entry, rev: 1 },
			]).success,
		).toBe(false);
	});

	it("requires append identity and validates command descriptors", () => {
		expect(
			FileCommandSchema.safeParse({
				op: "append",
				content: "x",
				key: "12345678",
				intent: {
					op: "append",
					epoch: "a".repeat(32),
					paths: ["note.md"],
					precondition: { kind: "none" },
					payload_hash:
						"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
					size: 1,
				},
			}).success,
		).toBe(true);
		expect(
			FileCommandSchema.safeParse({
				op: "append",
				content: "x",
				intent: {
					op: "append",
					epoch: "a".repeat(32),
					paths: ["note.md"],
					precondition: { kind: "none" },
					payload_hash:
						"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
					size: 0,
				},
			}).success,
		).toBe(false);
		expect(
			HistoryRequestSchema.safeParse({ path: "note.md", extra: true }).success,
		).toBe(false);
	});
});
