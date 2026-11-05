import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Resolves the plugin workspace root for workflow and CLI file access. */
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

/** Creates temporary plugin metadata files for one validator invocation. */
function createMetadataDirectory(manifest: unknown, versions: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "plugin-release-"));
	const pluginDirectory = join(root, "apps", "plugin");
	mkdirSync(pluginDirectory, { recursive: true });
	writeFileSync(
		join(pluginDirectory, "manifest.json"),
		JSON.stringify(manifest),
	);
	writeFileSync(
		join(pluginDirectory, "versions.json"),
		JSON.stringify(versions),
	);
	return root;
}

/** Runs the release validator CLI from a temporary repository root. */
function runValidator(root: string, tag: string): ReturnType<typeof spawnSync> {
	return spawnSync(
		"bun",
		[join(repositoryRoot, "apps/plugin/tools/release.ts"), tag],
		{ cwd: root, encoding: "utf8" },
	);
}

/** Reads one single-line workflow command by its exact step name. */
function checkCommand(): string {
	const workflow = readFileSync(
		join(repositoryRoot, ".github/workflows/release.yml"),
		"utf8",
	);
	const step = workflow.match(
		/- name: Check repository and build plugin\n\s+run: ([^\n]+)/,
	);
	if (!step) throw new Error("Repository check command not found");
	return step[1];
}

/** Extracts the publication shell from the checked-in workflow. */
function publicationShell(): string {
	const workflow = readFileSync(
		join(repositoryRoot, ".github/workflows/release.yml"),
		"utf8",
	);
	const step = workflow.match(
		/- name: Publish release\n\s+shell: bash\n\s+env:[\s\S]*?\n\s+run: \|\n((?:\s{10}.+\n|\s*\n)+)/,
	);
	if (!step) throw new Error("Publish release shell block not found");
	return step[1].replace(/^ {10}/gm, "");
}

/** Runs workflow publication commands against non-creating local command stubs. */
function runPublicationShell(options: {
	remoteTag?: string;
	checkedCommit?: string;
	eventCommit?: string;
	releaseExists?: boolean;
}): { status: number | null; stderr: string; root: string; log: string } {
	const root = mkdtempSync(join(tmpdir(), "plugin-publication-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "gh.log");
	writeFileSync(log, "");
	const gitStub = `#!/bin/sh\ncase "$*" in\n  "ls-remote origin refs/tags/plugin-v0.1.0^{} refs/tags/plugin-v0.1.0") printf '%s\\trefs/tags/plugin-v0.1.0^{}\\n' "${options.remoteTag ?? "checked-commit"}" ;;\n  "rev-parse HEAD") printf '%s\\n' "${options.checkedCommit ?? "checked-commit"}" ;;\n  *) exit 2 ;;\nesac\n`;
	const ghStub = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\nif [ "$1 $2" = "release view" ]; then\n  ${options.releaseExists ? "exit 0" : "exit 1"}\nfi\nif [ "$1 $2" = "release create" ]; then exit 0; fi\nexit 2\n`;
	writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
	writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
	const result = spawnSync(
		"bash",
		["-euo", "pipefail", "-c", publicationShell()],
		{
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				GITHUB_REF_NAME: "plugin-v0.1.0",
				GITHUB_SHA:
					options.eventCommit ?? options.checkedCommit ?? "checked-commit",
				GH_LOG: log,
			},
		},
	);
	return { status: result.status, stderr: result.stderr ?? "", root, log };
}

describe("plugin release metadata validation", () => {
	const manifest = {
		version: "0.1.0",
		minAppVersion: "1.13.0",
		isDesktopOnly: false,
	};
	const versions = { "0.1.0": "1.13.0" };

	it("accepts a tag that matches the manifest and compatibility map", () => {
		const root = createMetadataDirectory(manifest, versions);
		try {
			const result = runValidator(root, "plugin-v0.1.0");
			expect(result.status).toBe(0);
			expect(String(result.stdout).trim()).toBe("plugin-v0.1.0");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["wrong prefix", "release-v0.1.0", manifest, versions],
		["malformed tag version", "plugin-v01.0.0", manifest, versions],
		["manifest version mismatch", "plugin-v0.2.0", manifest, versions],
		["missing compatibility entry", "plugin-v0.1.0", manifest, {}],
		[
			"compatibility version mismatch",
			"plugin-v0.1.0",
			manifest,
			{ "0.1.0": "1.14.0" },
		],
		["null manifest", "plugin-v0.1.0", null, versions],
		["malformed manifest fields", "plugin-v0.1.0", { version: 1 }, versions],
		["null compatibility map", "plugin-v0.1.0", manifest, null],
		[
			"desktop-only manifest",
			"plugin-v0.1.0",
			{ ...manifest, isDesktopOnly: true },
			versions,
		],
	] as const)(
		"rejects %s",
		(_name, tag, suppliedManifest, suppliedVersions) => {
			const root = createMetadataDirectory(suppliedManifest, suppliedVersions);
			try {
				expect(runValidator(root, tag).status).not.toBe(0);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects missing files and invalid JSON", () => {
		const root = mkdtempSync(join(tmpdir(), "plugin-release-invalid-"));
		const pluginDirectory = join(root, "apps", "plugin");
		mkdirSync(pluginDirectory, { recursive: true });
		try {
			expect(runValidator(root, "plugin-v0.1.0").status).not.toBe(0);
			writeFileSync(join(pluginDirectory, "manifest.json"), "{");
			writeFileSync(join(pluginDirectory, "versions.json"), "{}");
			expect(runValidator(root, "plugin-v0.1.0").status).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("release workflow publication shell", () => {
	it("stops when the repository check command fails", () => {
		const workflow = readFileSync(
			join(repositoryRoot, ".github/workflows/release.yml"),
			"utf8",
		);
		const check = checkCommand();
		const publishPosition = workflow.indexOf("- name: Publish release");
		expect(check).toBe("bun run check");
		expect(
			workflow.indexOf(`- name: Check repository and build plugin`),
		).toBeLessThan(publishPosition);

		const root = mkdtempSync(join(tmpdir(), "plugin-check-failure-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "bun"),
			`#!/bin/sh
exit 23
`,
			{ mode: 0o755 },
		);
		try {
			const result = spawnSync("bash", ["-euo", "pipefail", "-c", check], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			});
			expect(result.status).toBe(23);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("verifies the remote tag and creates a release with only plugin assets", () => {
		const result = runPublicationShell({});
		try {
			expect(result.status, result.stderr).toBe(0);
			const calls = readFileSync(result.log, "utf8");
			expect(calls).toContain("release view plugin-v0.1.0");
			expect(calls).toContain("release create plugin-v0.1.0");
			expect(calls).toContain("--verify-tag");
			expect(calls).toContain("apps/plugin/dist/manifest.json");
			expect(calls).toContain("apps/plugin/dist/main.js");
			expect(calls.split("\n")).toContain(
				"release create plugin-v0.1.0 --verify-tag --title plugin-v0.1.0 --notes Plugin release plugin-v0.1.0. apps/plugin/dist/manifest.json apps/plugin/dist/main.js",
			);
			expect(calls).not.toContain("styles.css");
			expect(calls).not.toContain("--clobber");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it.each([
		["a missing remote tag", { remoteTag: "" }],
		["a tag at another commit", { remoteTag: "other-commit" }],
		[
			"a checkout that differs from the tag event",
			{ eventCommit: "other-commit" },
		],
		["an existing release", { releaseExists: true }],
	])("refuses publication for %s", (_name, options) => {
		const result = runPublicationShell(options);
		try {
			expect(result.status).not.toBe(0);
			expect(readFileSync(result.log, "utf8")).not.toContain("release create");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});
});
