import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Identifies one authorized desktop vault and the exact path that Obsidian must resolve. */
export type DesktopVaultId = "dev-1" | "dev-2";

/** Limits host results to non-secret evidence fields. */
export interface DesktopCaseSummary {
	caseId: string;
	evidence: "service" | "controlled" | "local";
	status: "passed" | "failed" | "blocked";
}

/** Returns the only two vault paths that this acceptance driver may target. */
export function authorizedVaults(
	home = homedir(),
): Record<DesktopVaultId, string> {
	return {
		"dev-1": resolve(home, "vaults/obsidian-ai-bridge-dev"),
		"dev-2": resolve(home, "vaults/obsidian-ai-bridge-dev-2"),
	};
}

/** Rejects unknown IDs and path mismatches before any host command can run. */
export function assertAuthorizedVault(
	id: string,
	resolvedPath: string,
	home = homedir(),
): string {
	const allowed = authorizedVaults(home);
	if (
		(id !== "dev-1" && id !== "dev-2") ||
		!isAbsolute(resolvedPath) ||
		resolve(resolvedPath) !== allowed[id]
	)
		throw new Error("Unauthorized vault target");
	return allowed[id];
}

/** Builds a summary from explicit safe fields and discards every other result value. */
export function safeCaseResult(
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	result: Record<string, unknown>,
): DesktopCaseSummary {
	const status = result.status;
	if (status !== "passed" && status !== "failed" && status !== "blocked")
		throw new Error("Invalid case status");
	return { caseId, evidence, status };
}

/** Runs one explicitly targeted Obsidian CLI command without exposing its output. */
export function runScopedObsidian(
	id: DesktopVaultId,
	vaultName: string,
	command: string,
	args: readonly string[],
	options: { executable?: string } = {},
): void {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	if (!vaultName || !/^[A-Za-z0-9 _-]+$/.test(vaultName))
		throw new Error("Invalid Obsidian vault name");
	const executable = options.executable ?? "/opt/homebrew/bin/obsidian";
	const identity = spawnSync(
		executable,
		[`vault=${vaultName}`, "vault", "info=path"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	if (identity.status !== 0 || identity.stdout.trim() !== target)
		throw new Error("Obsidian resolved an unauthorized vault path");
	const result = spawnSync(
		executable,
		[`vault=${vaultName}`, command, ...args],
		{
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	if (result.error || result.status !== 0)
		throw new Error("Obsidian command failed");
}

/** Installs the checked-in plugin bundle through the exact target vault's Obsidian adapter. */
export async function installScopedPlugin(
	id: DesktopVaultId,
	vaultName: string,
	distDirectory: string,
	options: { executable?: string } = {},
): Promise<void> {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const manifestText = await readFile(
		resolve(distDirectory, "manifest.json"),
		"utf8",
	);
	const manifest: unknown = JSON.parse(manifestText);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("id" in manifest) ||
		manifest.id !== "ai-bridge"
	)
		throw new Error("Unexpected plugin artifact identity");
	const mainText = await readFile(resolve(distDirectory, "main.js"), "utf8");
	const script = createInstallScript(id, target, manifestText, mainText);
	runScopedObsidian(id, vaultName, "eval", [`code=${script}`], options);
}

/** Creates an Obsidian-host script that refuses mismatched existing files before writing. */
export function createInstallScript(
	id: DesktopVaultId,
	target: string,
	manifestText: string,
	mainText: string,
	home = homedir(),
): string {
	const authorizedTarget = assertAuthorizedVault(id, target, home);
	/** Encodes plugin text for safe transport as one CLI argument. */
	const base64 = (value: string) =>
		Buffer.from(value, "utf8").toString("base64");
	const targetValue = JSON.stringify(authorizedTarget);
	const manifestValue = JSON.stringify(base64(manifestText));
	const mainValue = JSON.stringify(base64(mainText));
	return `(async()=>{const a=app.vault.adapter;if(a.getBasePath()!==${targetValue})throw Error("Vault path mismatch");const id="ai-bridge";const p=".obsidian/plugins/"+id;const d=s=>new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));const m=d(${manifestValue});const b=d(${mainValue});if(JSON.parse(m).id!==id)throw Error("Plugin ID mismatch");if(!(await a.exists(p)))await a.mkdir(p);for(const [n,c] of [["manifest.json",m],["main.js",b]]){const f=p+"/"+n;if(await a.exists(f)){if(await a.read(f)!==c)throw Error("Existing plugin differs")}else await a.write(f,c)}await app.plugins.loadPlugin(id);await app.plugins.enablePlugin(id);if(!app.plugins.enabledPlugins.has(id))throw Error("Plugin did not enable");return JSON.stringify({status:"passed"})})()`;
}

/** Runs the explicit install or vault-path verification command for a test vault. */
async function runCommand(arguments_: readonly string[]): Promise<void> {
	const [action, id, vaultName] = arguments_;
	if (
		(action !== "install" && action !== "verify") ||
		(id !== "dev-1" && id !== "dev-2") ||
		!vaultName
	)
		throw new Error(
			"Usage: desktop-acceptance.ts <install|verify> <dev-1|dev-2> <vault-name>",
		);
	if (action === "verify") {
		runScopedObsidian(id, vaultName, "vault", ["info=path"]);
		console.log(`Verified authorized target ${id}`);
		return;
	}
	const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
	await installScopedPlugin(id, vaultName, distDirectory);
	console.log(`Installed existing plugin artifact in ${id}`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await runCommand(process.argv.slice(2));
}
