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

/** Extracts the tag-source verification shell from the publish job. */
function verifyTagShell(): string {
	const workflow = readFileSync(
		join(repositoryRoot, ".github/workflows/release.yml"),
		"utf8",
	);
	const step = workflow.match(
		/- name: Verify tag source\n\s+shell: bash\n\s+env:[\s\S]*?\n\s+run: \|\n((?:\s{10}.+\n|\s*\n)+)/,
	);
	if (!step) throw new Error("Tag-source verification shell block not found");
	return step[1].replace(/^ {10}/gm, "");
}

/** Extracts the release-creation shell from the checked-in workflow. */
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

/** Extracts the post-publication compatibility update shell from the workflow. */
function compatibilityRecordShell(): string {
	const workflow = readFileSync(
		join(repositoryRoot, ".github/workflows/release.yml"),
		"utf8",
	);
	const step = workflow.match(
		/- name: Record published compatibility entry on main\n\s+shell: bash\n\s+env:[\s\S]*?\n\s+run: \|\n((?:\s{10}.+\n|\s*\n)+)/,
	);
	if (!step) throw new Error("Compatibility recording shell block not found");
	return step[1].replace(/^ {10}/gm, "");
}

/** Runs a git command in a fixture repository and returns its successful output. */
function runGit(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

/** Runs workflow publication commands against non-creating local command stubs. */
function runPublicationShell(options: {
	remoteTag?: string;
	checkedCommit?: string;
	eventCommit?: string;
	tagRefKind?: "annotated" | "lightweight";
	releaseExists?: boolean;
	existingAssets?: {
		manifest?: "matching" | "mismatched";
		main?: "matching" | "mismatched";
	};
}): { status: number | null; stderr: string; root: string; log: string } {
	const root = mkdtempSync(join(tmpdir(), "plugin-publication-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "gh.log");
	const assetDirectory = join(root, "release-assets");
	mkdirSync(assetDirectory);
	writeFileSync(log, "");
	mkdirSync(join(root, "apps/plugin/dist"), { recursive: true });
	writeFileSync(join(root, "apps/plugin/dist/manifest.json"), "manifest-bytes");
	writeFileSync(join(root, "apps/plugin/dist/main.js"), "main-bytes");
	for (const [name, asset] of Object.entries(options.existingAssets ?? {})) {
		if (!asset) continue;
		const file = name === "manifest" ? "manifest.json" : "main.js";
		writeFileSync(
			join(assetDirectory, file),
			asset === "matching" ? `${name}-bytes` : `wrong-${name}-bytes`,
		);
	}
	const remoteCommit = options.remoteTag ?? "checked-commit";
	const remoteTagLines =
		options.tagRefKind === "lightweight"
			? `printf '%s\\trefs/tags/ai-bridge-v0.1.0\\n' "${remoteCommit}"`
			: `printf '%s\\trefs/tags/ai-bridge-v0.1.0\\n' tag-object; printf '%s\\trefs/tags/ai-bridge-v0.1.0^{}\\n' "${remoteCommit}"`;
	const gitStub = `#!/bin/sh\ncase "$*" in\n  "ls-remote origin refs/tags/ai-bridge-v0.1.0^{} refs/tags/ai-bridge-v0.1.0") ${remoteTagLines} ;;\n  "rev-parse HEAD") printf '%s\\n' "${options.checkedCommit ?? "checked-commit"}" ;;\n  *) exit 2 ;;\nesac\n`;
	const existingNames = Object.entries(options.existingAssets ?? {})
		.filter(([, asset]) => asset !== undefined)
		.map(([name]) => (name === "manifest" ? "manifest.json" : "main.js"))
		.map((name) => `printf '%s\\n' '${name}'`)
		.join("; ");
	const ghStub = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  if [ "$4" = "--json" ]; then
    ${existingNames}
    exit 0
  fi
  ${options.releaseExists ? "exit 0" : "exit 1"}
fi
if [ "$1 $2" = "release download" ]; then
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) name="$2"; shift 2 ;;
      --dir) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$GH_ASSET_DIR/$name" "$target/$name"
  exit 0
fi
if [ "$1 $2" = "release upload" ]; then
  shift 3
  for file in "$@"; do
    name="$(basename "$file")"
    if [ -e "$GH_ASSET_DIR/$name" ]; then echo "asset already exists" >&2; exit 1; fi
    cp "$file" "$GH_ASSET_DIR/$name"
  done
  exit 0
fi
if [ "$1 $2" = "release create" ]; then exit 0; fi
exit 2
`;
	writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
	writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		GITHUB_REF_NAME: "ai-bridge-v0.1.0",
		RELEASE_TAG: "ai-bridge-v0.1.0",
		GITHUB_SHA:
			options.eventCommit ?? options.checkedCommit ?? "checked-commit",
		GH_LOG: log,
		GH_ASSET_DIR: assetDirectory,
	};
	const verify = spawnSync(
		"bash",
		["-euo", "pipefail", "-c", verifyTagShell()],
		{
			cwd: root,
			encoding: "utf8",
			env,
		},
	);
	const result =
		verify.status === 0
			? spawnSync("bash", ["-euo", "pipefail", "-c", publicationShell()], {
					cwd: root,
					encoding: "utf8",
					env,
				})
			: verify;
	return { status: result.status, stderr: result.stderr ?? "", root, log };
}

describe("plugin release metadata validation", () => {
	const manifest = {
		version: "0.1.0",
		minAppVersion: "1.13.0",
		isDesktopOnly: false,
	};
	const versions = { "0.1.0": "1.13.0" };

	it("accepts a tag after the tag manifest writes its missing compatibility entry", () => {
		const root = createMetadataDirectory(manifest, {});
		try {
			const result = spawnSync(
				"bun",
				[
					join(repositoryRoot, "apps/plugin/tools/release-versions.ts"),
					join(root, "apps/plugin/manifest.json"),
					join(root, "apps/plugin/versions.json"),
				],
				{ cwd: root, encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			const validation = runValidator(root, "ai-bridge-v0.1.0");
			expect(validation.status, String(validation.stderr)).toBe(0);
			expect(String(validation.stdout).trim()).toBe("ai-bridge-v0.1.0");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		["wrong prefix", "release-v0.1.0", manifest, versions],
		["malformed tag version", "ai-bridge-v01.0.0", manifest, versions],
		["manifest version mismatch", "ai-bridge-v0.2.0", manifest, versions],
		["missing compatibility entry", "ai-bridge-v0.1.0", manifest, {}],
		[
			"compatibility version mismatch",
			"ai-bridge-v0.1.0",
			manifest,
			{ "0.1.0": "1.14.0" },
		],
		["null manifest", "ai-bridge-v0.1.0", null, versions],
		["malformed manifest fields", "ai-bridge-v0.1.0", { version: 1 }, versions],
		["null compatibility map", "ai-bridge-v0.1.0", manifest, null],
		[
			"desktop-only manifest",
			"ai-bridge-v0.1.0",
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
			expect(runValidator(root, "ai-bridge-v0.1.0").status).not.toBe(0);
			writeFileSync(join(pluginDirectory, "manifest.json"), "{");
			writeFileSync(join(pluginDirectory, "versions.json"), "{}");
			expect(runValidator(root, "ai-bridge-v0.1.0").status).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("release workflow publication shell", () => {
	it("keeps build code read-only and passes only checked plugin artifacts to publication", () => {
		const workflow = readFileSync(
			join(repositoryRoot, ".github/workflows/release.yml"),
			"utf8",
		);
		const buildMatch = / {2}build:\n([\s\S]*?)\n {2}publish:\n/.exec(workflow);
		const publishMatch = / {2}publish:\n([\s\S]*)$/.exec(workflow);
		const buildJob = buildMatch?.[1] ?? "";
		const publishJob = publishMatch?.[1] ?? "";

		expect(buildJob).not.toBe("");
		expect(publishJob).not.toBe("");
		expect(buildJob).toContain("permissions:\n      contents: read");
		expect(buildJob).not.toContain("contents: write");
		expect(buildJob).toContain("bun install --frozen-lockfile");
		expect(buildJob).toContain("bun run check");
		expect(buildJob).toContain(
			"actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
		);
		expect(buildJob).toContain("if-no-files-found: error");
		expect(buildJob).toContain("overwrite: false");
		expect(buildJob).toContain(
			"path: |\n            apps/plugin/dist/manifest.json\n            apps/plugin/dist/main.js",
		);
		expect(publishJob).toContain("needs: build");
		expect(publishJob).toContain("permissions:\n      contents: write");
		expect(publishJob).toContain("fetch-depth: 0");
		expect(publishJob).toContain(
			"jdx/mise-action@08ae2a091c038e1e05ec6f5115dc5c69d5a2a6b8",
		);
		expect(publishJob.indexOf("jdx/mise-action")).toBeLessThan(
			publishJob.indexOf("Record published compatibility entry on main"),
		);
		expect(publishJob).toContain(
			"actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
		);
		expect(publishJob).toContain("name: plugin-release-assets");
		expect(publishJob).toContain("git ls-remote origin");
		expect(publishJob).toContain("gh release upload");
		expect(publishJob).toContain("gh release create");
		expect(publishJob).toContain("apps/plugin/dist/manifest.json");
		expect(publishJob).toContain("apps/plugin/dist/main.js");
		const publication = publicationShell();
		expect(publication).not.toMatch(/\bbun\b|\bnpm\b|\byarn\b|\bpnpm\b/);
	});

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

	it("records the tag manifest entry on fresh main after publication", () => {
		const root = mkdtempSync(join(tmpdir(), "plugin-compatibility-main-"));
		const remote = join(root, "origin.git");
		const seed = join(root, "seed");
		const checkout = join(root, "checkout");
		mkdirSync(seed);
		runGit(root, "init", "--bare", "--initial-branch=main", remote);
		runGit(seed, "init", "--initial-branch=main");
		runGit(seed, "config", "user.name", "Test Agent");
		runGit(seed, "config", "user.email", "test@example.com");
		mkdirSync(join(seed, "apps/plugin"), { recursive: true });
		writeFileSync(
			join(seed, "apps/plugin/manifest.json"),
			JSON.stringify({ version: "0.1.0", minAppVersion: "1.13.0" }),
		);
		writeFileSync(join(seed, "apps/plugin/versions.json"), "{}\n");
		mkdirSync(join(seed, "apps/plugin/tools"), { recursive: true });
		writeFileSync(
			join(seed, "apps/plugin/tools/release-versions.ts"),
			readFileSync(
				join(repositoryRoot, "apps/plugin/tools/release-versions.ts"),
				"utf8",
			),
		);
		runGit(seed, "add", ".");
		runGit(seed, "commit", "-m", "tag source");
		runGit(seed, "tag", "ai-bridge-v0.1.0");
		writeFileSync(
			join(seed, "apps/plugin/manifest.json"),
			JSON.stringify({ version: "0.2.0", minAppVersion: "1.14.0" }),
		);
		writeFileSync(
			join(seed, "apps/plugin/versions.json"),
			JSON.stringify({ "0.0.9": "1.12.0" }),
		);
		runGit(seed, "add", ".");
		runGit(seed, "commit", "-m", "newer main manifest");
		runGit(seed, "remote", "add", "origin", remote);
		runGit(seed, "push", "origin", "main", "--tags");
		spawnSync("git", ["clone", remote, checkout], { encoding: "utf8" });
		runGit(checkout, "checkout", "ai-bridge-v0.1.0");
		const bin = join(root, "bin");
		const assets = join(root, "assets");
		const ghLog = join(root, "gh.log");
		mkdirSync(bin);
		mkdirSync(assets);
		mkdirSync(join(checkout, "apps/plugin/dist"), { recursive: true });
		const tagManifest = JSON.stringify({
			version: "0.1.0",
			minAppVersion: "1.13.0",
		});
		writeFileSync(
			join(checkout, "apps/plugin/dist/manifest.json"),
			tagManifest,
		);
		writeFileSync(join(checkout, "apps/plugin/dist/main.js"), "checked-main");
		writeFileSync(join(assets, "manifest.json"), tagManifest);
		writeFileSync(join(assets, "main.js"), "checked-main");
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "release view" ]; then
  if [ "$4" = "--json" ]; then printf 'manifest.json\\nmain.js\\n'; fi
  exit 0
fi
if [ "$1 $2" = "release download" ]; then
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) name="$2"; shift 2 ;;
      --dir) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$GH_ASSET_DIR/$name" "$target/$name"
  exit 0
fi
if [ "$1 $2" = "release upload" ]; then exit 0; fi
exit 2
`,
			{ mode: 0o755 },
		);
		writeFileSync(ghLog, "");

		try {
			const publication = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", publicationShell()],
				{
					cwd: checkout,
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						RELEASE_TAG: "ai-bridge-v0.1.0",
						GH_LOG: ghLog,
						GH_ASSET_DIR: assets,
					},
				},
			);
			expect(publication.status, String(publication.stderr)).toBe(0);
			expect(readFileSync(ghLog, "utf8")).toContain(
				"release download ai-bridge-v0.1.0 --pattern manifest.json",
			);
			const result = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", compatibilityRecordShell()],
				{
					cwd: checkout,
					encoding: "utf8",
					env: {
						...process.env,
						RELEASE_TAG: "ai-bridge-v0.1.0",
						GH_TOKEN: "fake-token",
					},
				},
			);
			expect(result.status, result.stderr).toBe(0);
			const pushedMap = JSON.parse(
				runGit(remote, "show", "main:apps/plugin/versions.json"),
			);
			expect(pushedMap).toEqual({
				"0.0.9": "1.12.0",
				"0.1.0": "1.13.0",
			});
			expect(runGit(remote, "log", "-1", "--format=%s", "main")).toBe(
				"chore(plugin): record compatibility for 0.1.0",
			);
			const firstMainCommit = runGit(remote, "rev-parse", "main");
			const rerun = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", compatibilityRecordShell()],
				{
					cwd: checkout,
					encoding: "utf8",
					env: {
						...process.env,
						RELEASE_TAG: "ai-bridge-v0.1.0",
						GH_TOKEN: "fake-token",
					},
				},
			);
			expect(rerun.status, String(rerun.stderr)).toBe(0);
			expect(runGit(remote, "rev-parse", "main")).toBe(firstMainCommit);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses a matching fallback branch after PR failure and refuses unrelated changes", () => {
		const root = mkdtempSync(join(tmpdir(), "plugin-compatibility-pr-"));
		const remote = join(root, "origin.git");
		const seed = join(root, "seed");
		const checkout = join(root, "checkout");
		mkdirSync(seed);
		runGit(root, "init", "--bare", "--initial-branch=main", remote);
		runGit(seed, "init", "--initial-branch=main");
		runGit(seed, "config", "user.name", "Test Agent");
		runGit(seed, "config", "user.email", "test@example.com");
		mkdirSync(join(seed, "apps/plugin/tools"), { recursive: true });
		writeFileSync(
			join(seed, "apps/plugin/tools/release-versions.ts"),
			readFileSync(
				join(repositoryRoot, "apps/plugin/tools/release-versions.ts"),
				"utf8",
			),
		);
		writeFileSync(
			join(seed, "apps/plugin/manifest.json"),
			JSON.stringify({ version: "0.1.0", minAppVersion: "1.13.0" }),
		);
		writeFileSync(join(seed, "apps/plugin/versions.json"), "{}\n");
		runGit(seed, "add", ".");
		runGit(seed, "commit", "-m", "tag source");
		runGit(seed, "tag", "ai-bridge-v0.1.0");
		runGit(seed, "remote", "add", "origin", remote);
		runGit(seed, "push", "origin", "main", "--tags");
		writeFileSync(
			join(remote, "hooks/pre-receive"),
			`#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then echo protected >&2; exit 1; fi
done
`,
			{ mode: 0o755 },
		);
		spawnSync("git", ["clone", remote, checkout], { encoding: "utf8" });
		runGit(checkout, "checkout", "ai-bridge-v0.1.0");
		const bin = join(root, "bin");
		const ghLog = join(root, "gh.log");
		mkdirSync(bin);
		writeFileSync(ghLog, "");
		const failureMarker = join(root, "first-pr-failure");
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1 $2" = "pr list" ]; then exit 0; fi
if [ "$1 $2" = "pr create" ]; then
  if [ ! -f "$GH_FAILURE_MARKER" ]; then touch "$GH_FAILURE_MARKER"; exit 1; fi
  exit 0
fi
exit 2
`,
			{ mode: 0o755 },
		);

		const recordEnvironment = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			RELEASE_TAG: "ai-bridge-v0.1.0",
			GH_TOKEN: "fake-token",
			GH_LOG: ghLog,
			GH_FAILURE_MARKER: failureMarker,
		};
		try {
			const firstRun = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", compatibilityRecordShell()],
				{ cwd: checkout, encoding: "utf8", env: recordEnvironment },
			);
			expect(firstRun.status).not.toBe(0);
			const branchRef = "refs/heads/chore/plugin-compatibility-0.1.0";
			const branchHashBeforeRetry = runGit(remote, "rev-parse", branchRef);
			const retry = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", compatibilityRecordShell()],
				{ cwd: checkout, encoding: "utf8", env: recordEnvironment },
			);
			expect(retry.status, String(retry.stderr)).toBe(0);
			expect(String(retry.stderr)).not.toMatch(/non-fast-forward|fetch first/);
			expect(runGit(remote, "rev-parse", branchRef)).toBe(
				branchHashBeforeRetry,
			);
			const branchMap = JSON.parse(
				runGit(remote, "show", `${branchRef}:apps/plugin/versions.json`),
			);
			expect(branchMap).toEqual({ "0.1.0": "1.13.0" });
			const ghCalls = readFileSync(ghLog, "utf8");
			expect(ghCalls).toContain(
				"pr list --state open --head chore/plugin-compatibility-0.1.0",
			);
			expect(ghCalls.match(/pr create --base main/g)).toHaveLength(2);

			const conflictCheckout = join(root, "conflict-checkout");
			runGit(
				root,
				"clone",
				"--branch",
				"chore/plugin-compatibility-0.1.0",
				remote,
				conflictCheckout,
			);
			runGit(conflictCheckout, "config", "user.name", "Test Agent");
			runGit(conflictCheckout, "config", "user.email", "test@example.com");
			writeFileSync(join(conflictCheckout, "unrelated.txt"), "do not replace");
			runGit(conflictCheckout, "add", "unrelated.txt");
			runGit(conflictCheckout, "commit", "-m", "unrelated branch change");
			runGit(
				conflictCheckout,
				"push",
				"origin",
				"HEAD:refs/heads/chore/plugin-compatibility-0.1.0",
			);
			const conflictingBranchHash = runGit(remote, "rev-parse", branchRef);
			const createCallsBeforeConflict = readFileSync(ghLog, "utf8").match(
				/\bpr create --base main\b/g,
			);
			const conflictRun = spawnSync(
				"bash",
				["-euo", "pipefail", "-c", compatibilityRecordShell()],
				{ cwd: checkout, encoding: "utf8", env: recordEnvironment },
			);
			expect(conflictRun.status).not.toBe(0);
			expect(String(conflictRun.stderr)).toContain(
				"has changes that do not match this release entry",
			);
			expect(runGit(remote, "rev-parse", branchRef)).toBe(
				conflictingBranchHash,
			);
			expect(
				readFileSync(ghLog, "utf8").match(/\bpr create --base main\b/g),
			).toHaveLength(createCallsBeforeConflict?.length ?? 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("verifies the remote tag and creates a release with only plugin assets", () => {
		const result = runPublicationShell({});
		try {
			expect(result.status, result.stderr).toBe(0);
			const calls = readFileSync(result.log, "utf8");
			expect(calls).toContain("release view ai-bridge-v0.1.0");
			expect(calls).toContain("release create ai-bridge-v0.1.0");
			expect(calls).toContain("--verify-tag");
			expect(calls).toContain("apps/plugin/dist/manifest.json");
			expect(calls).toContain("apps/plugin/dist/main.js");
			expect(calls.split("\n")).toContain(
				"release create ai-bridge-v0.1.0 --verify-tag --title ai-bridge-v0.1.0 --notes Plugin release ai-bridge-v0.1.0. apps/plugin/dist/manifest.json apps/plugin/dist/main.js",
			);
			expect(calls).not.toContain("styles.css");
			expect(calls).not.toContain("--clobber");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it("accepts a matching direct lightweight tag ref", () => {
		const result = runPublicationShell({ tagRefKind: "lightweight" });
		try {
			expect(result.status, result.stderr).toBe(0);
			expect(readFileSync(result.log, "utf8")).toContain(
				"release create ai-bridge-v0.1.0",
			);
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it("accepts matching existing assets on a release retry without replacing them", () => {
		const result = runPublicationShell({
			releaseExists: true,
			existingAssets: { manifest: "matching", main: "matching" },
		});
		try {
			expect(result.status, result.stderr).toBe(0);
			const calls = readFileSync(result.log, "utf8");
			expect(calls).toContain(
				"release download ai-bridge-v0.1.0 --pattern manifest.json",
			);
			expect(calls).toContain(
				"release download ai-bridge-v0.1.0 --pattern main.js",
			);
			expect(calls).not.toContain("release upload");
			expect(calls).not.toContain("release create");
			expect(calls).not.toContain("--clobber");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it("rejects an existing asset whose bytes differ from the checked build", () => {
		const result = runPublicationShell({
			releaseExists: true,
			existingAssets: { manifest: "mismatched", main: "matching" },
		});
		try {
			expect(result.status).not.toBe(0);
			const calls = readFileSync(result.log, "utf8");
			expect(calls).toContain(
				"release download ai-bridge-v0.1.0 --pattern manifest.json",
			);
			expect(calls).not.toContain("release upload");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it("uploads only the missing asset when an existing asset matches", () => {
		const result = runPublicationShell({
			releaseExists: true,
			existingAssets: { manifest: "matching" },
		});
		try {
			expect(result.status, result.stderr).toBe(0);
			const calls = readFileSync(result.log, "utf8");
			expect(calls).toContain(
				"release download ai-bridge-v0.1.0 --pattern manifest.json",
			);
			expect(calls).toContain(
				"release upload ai-bridge-v0.1.0 apps/plugin/dist/main.js",
			);
			expect(calls).not.toContain("--clobber");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});

	it.each([
		["a missing remote tag", { remoteTag: "" }],
		["an annotated tag at another commit", { remoteTag: "other-commit" }],
		[
			"a lightweight tag at another commit",
			{ tagRefKind: "lightweight", remoteTag: "other-commit" },
		],
		[
			"a checkout that differs from the tag event",
			{ eventCommit: "other-commit" },
		],
	] as const)("refuses publication for %s", (_name, options) => {
		const result = runPublicationShell(options);
		try {
			expect(result.status).not.toBe(0);
			expect(readFileSync(result.log, "utf8")).not.toContain("release create");
		} finally {
			rmSync(result.root, { recursive: true, force: true });
		}
	});
});
