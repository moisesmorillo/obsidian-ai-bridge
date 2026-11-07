import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncCompatibilityVersion } from "../tools/release-versions";

describe("release compatibility version sync", () => {
	it("adds manifest version and minimum app version without changing old entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "release-versions-"));
		const manifestPath = join(root, "manifest.json");
		const versionsPath = join(root, "versions.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({ version: "0.1.7", minAppVersion: "1.14.0" }),
		);
		writeFileSync(versionsPath, JSON.stringify({ "0.1.6": "1.13.0" }));
		try {
			await syncCompatibilityVersion(manifestPath, versionsPath);
			expect(JSON.parse(readFileSync(versionsPath, "utf8"))).toEqual({
				"0.1.6": "1.13.0",
				"0.1.7": "1.14.0",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid versions and malformed compatibility maps", async () => {
		const root = mkdtempSync(join(tmpdir(), "release-versions-invalid-"));
		const manifestPath = join(root, "manifest.json");
		const versionsPath = join(root, "versions.json");
		try {
			writeFileSync(
				manifestPath,
				JSON.stringify({ version: "bad", minAppVersion: "1.13.0" }),
			);
			writeFileSync(versionsPath, "{}");
			await expect(
				syncCompatibilityVersion(manifestPath, versionsPath),
			).rejects.toThrow();
			writeFileSync(
				manifestPath,
				JSON.stringify({ version: "0.1.7", minAppVersion: "1.14.0" }),
			);
			writeFileSync(versionsPath, "[]");
			await expect(
				syncCompatibilityVersion(manifestPath, versionsPath),
			).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
