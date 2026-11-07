import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Reads one workflow file from the repository root for offline release policy checks. */
function workflowText(path: string): string {
	return readFileSync(
		new URL(`../../.github/workflows/${path}`, import.meta.url),
		"utf8",
	);
}

describe("Release Please configuration", () => {
	it("bootstraps both components at their approved versions and main revision", () => {
		const config = JSON.parse(
			readFileSync(
				new URL("../../release-please-config.json", import.meta.url),
				"utf8",
			),
		);
		const manifest = JSON.parse(
			readFileSync(
				new URL("../../.release-please-manifest.json", import.meta.url),
				"utf8",
			),
		);
		expect(config["bootstrap-sha"]).toBe(
			"eec41e68778e0d9e674d8e40c80b7c28e9ef80ed",
		);
		expect(config["separate-pull-requests"]).toBe(true);
		expect(manifest).toEqual({
			"apps/plugin": "0.1.6",
			"apps/worker": "0.1.0",
		});
		const workerPackage = JSON.parse(
			readFileSync(
				new URL("../../apps/worker/package.json", import.meta.url),
				"utf8",
			),
		);
		expect(workerPackage.version).toBe("0.1.0");
		expect(config.packages["apps/plugin"]).toMatchObject({
			component: "ai-bridge",
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
		expect(config.packages["apps/plugin"]["extra-files"]).toContainEqual({
			type: "json",
			path: "apps/plugin/manifest.json",
			jsonpath: "$.version",
		});
	});

	it("runs each release follow-up in the same workflow and syncs plugin PR metadata", () => {
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
		expect(workflow).toContain('git push origin "HEAD:$BRANCH"');
		expect(workflow).toContain("release-versions.ts");
	});
});
