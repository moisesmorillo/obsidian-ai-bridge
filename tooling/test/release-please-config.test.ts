import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Reads one workflow file from the repository root for offline release policy checks. */
function workflowText(path: string): string {
	return readFileSync(
		new URL(`../../.github/workflows/${path}`, import.meta.url),
		"utf8",
	);
}

/** Checks that Release Please versions match each component's authoritative package metadata. */
function expectVersionAlignment(
	releaseManifest: { "apps/plugin": string; "apps/worker": string },
	pluginManifest: { version: string },
	workerPackage: { version: string },
): void {
	expect(releaseManifest["apps/plugin"]).toBe(pluginManifest.version);
	expect(releaseManifest["apps/worker"]).toBe(workerPackage.version);
}

/** Increments a metadata version's patch part to form a future-release fixture. */
function nextPatchVersion(version: string): string {
	return version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
}

describe("Release Please configuration", () => {
	it("matches current component metadata and checks the bootstrap revision", () => {
		const config = JSON.parse(
			readFileSync(
				new URL("../../release-please-config.json", import.meta.url),
				"utf8",
			),
		);
		const releaseManifest = JSON.parse(
			readFileSync(
				new URL("../../.release-please-manifest.json", import.meta.url),
				"utf8",
			),
		);
		const pluginManifest = JSON.parse(
			readFileSync(
				new URL("../../apps/plugin/manifest.json", import.meta.url),
				"utf8",
			),
		);
		const workerPackage = JSON.parse(
			readFileSync(
				new URL("../../apps/worker/package.json", import.meta.url),
				"utf8",
			),
		);
		expect(config["bootstrap-sha"]).toBe(
			"eec41e68778e0d9e674d8e40c80b7c28e9ef80ed",
		);
		expect(config["last-release-sha"]).toBe(
			"7ed19cca1e566e9a6975c19c4c576213f4bb79ab",
		);
		expect(config["separate-pull-requests"]).toBe(true);
		expectVersionAlignment(releaseManifest, pluginManifest, workerPackage);
		expect(
			`${config.packages["apps/plugin"].component}-v${releaseManifest["apps/plugin"]}`,
		).toBe("vaultwire-v0.2.1");
		expect(
			`${config.packages["apps/worker"].component}-v${releaseManifest["apps/worker"]}`,
		).toBe("worker-v0.5.0");
		expect(config.packages["apps/plugin"]).toMatchObject({
			component: "vaultwire",
			"release-type": "node",
			"include-component-in-tag": true,
			"tag-separator": "-",
		});
		expect(config.packages["apps/worker"]).toMatchObject({
			component: "worker",
			"release-type": "node",
			"include-component-in-tag": true,
			"tag-separator": "-",
		});
		expect(releaseManifest).toEqual({
			"apps/plugin": "0.2.1",
			"apps/worker": "0.5.0",
		});
		// Release Please resolves extra-file paths relative to the package path.
		expect(config.packages["apps/plugin"]["extra-files"]).toContainEqual({
			type: "json",
			path: "manifest.json",
			jsonpath: "$.version",
		});
	});

	it("keeps the shared release pin through a Worker-first release", () => {
		const config = JSON.parse(
			readFileSync(
				new URL("../../release-please-config.json", import.meta.url),
				"utf8",
			),
		);
		const pluginManifest = JSON.parse(
			readFileSync(
				new URL("../../apps/plugin/manifest.json", import.meta.url),
				"utf8",
			),
		);
		const workerPackage = JSON.parse(
			readFileSync(
				new URL("../../apps/worker/package.json", import.meta.url),
				"utf8",
			),
		);
		const pluginTagPrefix = `${config.packages["apps/plugin"].component}-v`;
		const workerFirstTags = [
			"ai-bridge-v0.2.1",
			`${config.packages["apps/worker"].component}-v${nextPatchVersion(workerPackage.version)}`,
		];
		/** Matches the configured plugin tag family. Legacy tags do not end the pin hold. */
		const hasVaultwirePluginRelease = (tags: string[]): boolean =>
			tags.some((tag) => tag.startsWith(pluginTagPrefix));
		const tagsAfterPluginRelease = [
			...workerFirstTags,
			`${pluginTagPrefix}${nextPatchVersion(pluginManifest.version)}`,
		];
		const releaseDocs = readFileSync(
			new URL("../../docs/plugin-release.md", import.meta.url),
			"utf8",
		);

		expect(workerFirstTags).toEqual(["ai-bridge-v0.2.1", "worker-v0.5.1"]);
		expect(hasVaultwirePluginRelease(workerFirstTags)).toBe(false);
		expect(config["last-release-sha"]).toBe(
			"7ed19cca1e566e9a6975c19c4c576213f4bb79ab",
		);
		expect(hasVaultwirePluginRelease(tagsAfterPluginRelease)).toBe(true);
		expect(releaseDocs).toContain(
			"Remove the shared pin only after the first `vaultwire-v*` plugin release is published.",
		);
		expect(releaseDocs).toContain(
			"A Worker-only release PR does not meet this condition.",
		);
	});

	it.each(["plugin-only", "worker-only", "both"] as const)(
		"accepts future %s version bumps when component metadata matches",
		(change) => {
			const releaseManifest = JSON.parse(
				readFileSync(
					new URL("../../.release-please-manifest.json", import.meta.url),
					"utf8",
				),
			);
			const pluginManifest = JSON.parse(
				readFileSync(
					new URL("../../apps/plugin/manifest.json", import.meta.url),
					"utf8",
				),
			);
			const workerPackage = JSON.parse(
				readFileSync(
					new URL("../../apps/worker/package.json", import.meta.url),
					"utf8",
				),
			);
			const pluginVersion = nextPatchVersion(pluginManifest.version);
			const workerVersion = nextPatchVersion(workerPackage.version);
			const nextReleaseManifest = { ...releaseManifest };
			const nextPluginManifest = { ...pluginManifest };
			const nextWorkerPackage = { ...workerPackage };

			if (change === "plugin-only" || change === "both") {
				nextReleaseManifest["apps/plugin"] = pluginVersion;
				nextPluginManifest.version = pluginVersion;
			}
			if (change === "worker-only" || change === "both") {
				nextReleaseManifest["apps/worker"] = workerVersion;
				nextWorkerPackage.version = workerVersion;
			}

			expectVersionAlignment(
				nextReleaseManifest,
				nextPluginManifest,
				nextWorkerPackage,
			);
		},
	);

	it.each(["plugin", "worker"] as const)(
		"rejects a future %s release manifest mismatch",
		(component) => {
			const releaseManifest = JSON.parse(
				readFileSync(
					new URL("../../.release-please-manifest.json", import.meta.url),
					"utf8",
				),
			);
			const pluginManifest = JSON.parse(
				readFileSync(
					new URL("../../apps/plugin/manifest.json", import.meta.url),
					"utf8",
				),
			);
			const workerPackage = JSON.parse(
				readFileSync(
					new URL("../../apps/worker/package.json", import.meta.url),
					"utf8",
				),
			);
			const mismatchedManifest = { ...releaseManifest };
			mismatchedManifest[`apps/${component}`] = nextPatchVersion(
				releaseManifest[`apps/${component}`],
			);

			expect(() =>
				expectVersionAlignment(
					mismatchedManifest,
					pluginManifest,
					workerPackage,
				),
			).toThrow();
		},
	);

	it("runs release follow-ups without syncing a mutable release PR branch", () => {
		const workflow = workflowText("release-please.yml");
		expect(workflow).toContain(
			"googleapis/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071",
		);
		expect(workflow).toContain(
			"needs.release-please.outputs.plugin-created == 'true'",
		);
		expect(workflow).toContain(
			"needs.release-please.outputs.worker-created == 'true'",
		);
		expect(workflow).toContain("uses: ./.github/workflows/release.yml");
		expect(workflow).toContain("uses: ./.github/workflows/deploy.yml");
		expect(workflowText("release.yml")).toContain("'vaultwire-v*'");
		expect(workflow).not.toContain("sync-plugin-compatibility:");
		expect(workflow).not.toContain("release-versions.ts");
	});

	it("writes the tag compatibility entry before validation, build, and publication", () => {
		const workflow = workflowText("release.yml");
		const writePosition = workflow.indexOf("release-versions.ts");
		const validatePosition = workflow.indexOf("Validate release metadata");
		const checkPosition = workflow.indexOf("Check repository and build plugin");
		const publishPosition = workflow.indexOf("Publish release");

		expect(writePosition).toBeGreaterThanOrEqual(0);
		expect(writePosition).toBeLessThan(validatePosition);
		expect(validatePosition).toBeLessThan(checkPosition);
		expect(checkPosition).toBeLessThan(publishPosition);
	});
});
