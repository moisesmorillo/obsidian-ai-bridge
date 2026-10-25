import * as etagCodecs from "@protocol/codecs/etag";
import * as pathCodecs from "@protocol/codecs/path";
import * as protocol from "@protocol/index";
import * as etagSchemas from "@protocol/schemas/etag";
import { ETagPartsSchema } from "@protocol/schemas/etag";
import * as pathSchemas from "@protocol/schemas/path";
import type { ETagParts } from "@protocol/types/etag";
import type { Path } from "@protocol/types/path";
import { describe, expect, it } from "vitest";

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

	/** The exported configuration schema accepts absence but rejects unsafe origins. */
	it("validates canonical local authentication settings and accepts missing values", () => {
		const schema = protocol.LocalAuthConfigurationSchema;
		expect(schema.parse({})).toEqual({});
		expect(
			schema.safeParse({
				SERVICE_ORIGIN: "https://service.test",
				ACCESS_TEAM_DOMAIN: "https://team.test",
				ACCESS_AUDIENCE: "synthetic-audience",
				OWNER_SUBJECT: "synthetic-owner",
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({ SERVICE_ORIGIN: "https://service.test/path" }).success,
		).toBe(false);
		expect(schema.safeParse({ OWNER_SUBJECT: "bad:subject" }).success).toBe(
			false,
		);
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
