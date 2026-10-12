import { describe, expect, it } from "vitest";
import * as etagCodecs from "../src/codecs/etag";
import * as pathCodecs from "../src/codecs/path";
import * as protocol from "../src/index";
import * as etagSchemas from "../src/schemas/etag";
import { ETagPartsSchema } from "../src/schemas/etag";
import * as pathSchemas from "../src/schemas/path";
import type { ETagParts } from "../src/types/etag";
import type { Path } from "../src/types/path";

const pathTypecheck: Path = pathSchemas.PathSchema.parse("Notes/example.md");
const etagPartsTypecheck: ETagParts = ETagPartsSchema.parse({
	epoch: "a".repeat(32),
	rev: 1,
});

void pathTypecheck;
void etagPartsTypecheck;

describe("protocol contract modules", () => {
	it("keeps schema modules limited to canonical schema exports", () => {
		expect(Object.keys(pathSchemas).sort()).toEqual(["PathSchema"]);
		expect(Object.keys(etagSchemas).sort()).toEqual([
			"ETagPartsSchema",
			"ETagSchema",
			"EpochSchema",
		]);
	});

	it("keeps codec modules limited to executable helpers", () => {
		expect(Object.keys(pathCodecs).sort()).toEqual([
			"normalizePath",
			"pathKey",
		]);
		expect(Object.keys(etagCodecs).sort()).toEqual(["formatETag", "parseETag"]);
	});

	it("re-exports identical public schema and codec references", () => {
		expect(protocol.PathSchema).toBe(pathSchemas.PathSchema);
		expect(protocol.EpochSchema).toBe(etagSchemas.EpochSchema);
		expect(protocol.ETagSchema).toBe(etagSchemas.ETagSchema);
		expect(protocol.normalizePath).toBe(pathCodecs.normalizePath);
		expect(protocol.pathKey).toBe(pathCodecs.pathKey);
		expect(protocol.formatETag).toBe(etagCodecs.formatETag);
		expect(protocol.parseETag).toBe(etagCodecs.parseETag);
	});
});
