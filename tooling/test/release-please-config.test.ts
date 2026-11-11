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

/** Checks component settings, tags, and version links against supplied release metadata. */
function expectReleaseConfigurationMatchesMetadata(
	config: {
		"separate-pull-requests": boolean;
		packages: {
			"apps/plugin": {
				component: string;
				"release-type": string;
				"include-component-in-tag": boolean;
				"tag-separator": string;
				"extra-files": { type: string; path: string; jsonpath: string }[];
			};
			"apps/worker": {
				component: string;
				"release-type": string;
				"include-component-in-tag": boolean;
				"tag-separator": string;
			};
		};
	},
	releaseManifest: { "apps/plugin": string; "apps/worker": string },
	pluginManifest: { version: string },
	workerPackage: { version: string },
): void {
	const pluginConfig = config.packages["apps/plugin"];
	const workerConfig = config.packages["apps/worker"];
	const pluginTag = `${pluginConfig.component}${pluginConfig["tag-separator"]}v${releaseManifest["apps/plugin"]}`;
	const workerTag = `${workerConfig.component}${workerConfig["tag-separator"]}v${releaseManifest["apps/worker"]}`;

	expectVersionAlignment(releaseManifest, pluginManifest, workerPackage);
	expect(Object.keys(releaseManifest).sort()).toEqual([
		"apps/plugin",
		"apps/worker",
	]);
	expect(config["separate-pull-requests"]).toBe(true);
	expect(pluginConfig).toMatchObject({
		component: "vaultwire",
		"release-type": "node",
		"include-component-in-tag": true,
		"tag-separator": "-",
	});
	expect(workerConfig).toMatchObject({
		component: "worker",
		"release-type": "node",
		"include-component-in-tag": true,
		"tag-separator": "-",
	});
	expect(pluginTag).toMatch(/^vaultwire-v\d+\.\d+\.\d+$/);
	expect(workerTag).toMatch(/^worker-v\d+\.\d+\.\d+$/);
	expect(pluginTag).toBe(`vaultwire-v${pluginManifest.version}`);
	expect(workerTag).toBe(`worker-v${workerPackage.version}`);
	expect(pluginConfig["extra-files"]).toContainEqual({
		type: "json",
		path: "manifest.json",
		jsonpath: "$.version",
	});
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
		expectReleaseConfigurationMatchesMetadata(
			config,
			releaseManifest,
			pluginManifest,
			workerPackage,
		);
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
		const pluginConfig = config.packages["apps/plugin"];
		const pluginTagPrefix = `${pluginConfig.component}${pluginConfig["tag-separator"]}v`;
		const workerConfig = config.packages["apps/worker"];
		/** Historical tag used to model the plugin's pre-rename release history. */
		const legacyPluginTag = "ai-bridge-v0.2.1";
		const workerFirstTag = `${workerConfig.component}${workerConfig["tag-separator"]}v${nextPatchVersion(workerPackage.version)}`;
		const workerFirstTags = [legacyPluginTag, workerFirstTag];
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

		expect(workerFirstTags).toContain(legacyPluginTag);
		expect(workerFirstTag).toMatch(/^worker-v\d+\.\d+\.\d+$/);
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

			expectReleaseConfigurationMatchesMetadata(
				config,
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
		expect(workflow).toContain(
			"tag: ${{ needs.release-please.outputs.plugin-tag }}",
		);
		expect(workflow).not.toContain("sync-plugin-compatibility:");
		expect(workflow).not.toContain("release-versions.ts");
	});

	it("starts plugin publication only from the Release Please workflow call", () => {
		const workflow = workflowText("release.yml");
		const triggers = workflow.slice(
			workflow.indexOf("\non:\n"),
			workflow.indexOf("\npermissions:\n"),
		);

		expect(triggers).toContain("workflow_call:");
		expect(triggers).toContain("required: true");
		expect(triggers).not.toMatch(/^\s+push:/m);
		expect(triggers).not.toMatch(/^\s+tags:/m);
		expect(triggers).not.toContain("workflow_dispatch:");
		expect(workflow).not.toContain("github.ref_name");
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
