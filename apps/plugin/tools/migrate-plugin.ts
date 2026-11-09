import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";

/** Describes the verified backup created before plugin data is copied. */
export interface PluginMigrationResult {
	backupDirectory: string;
}

/** Copies shared settings into a new plugin folder and retains the old folder as recovery data. */
export async function migratePluginData(
	vaultPath: string,
	copy: typeof copyFile = copyFile,
): Promise<PluginMigrationResult> {
	const root = resolve(vaultPath);
	const obsidian = join(root, ".obsidian");
	const plugins = join(obsidian, "plugins");
	const source = join(plugins, "ai-bridge");
	const destination = join(plugins, "vaultwire");
	const backupDirectory = join(plugins, "ai-bridge-vaultwire-backup");
	let stage: string | null = null;
	if (
		!(await isDirectory(root)) ||
		!(await isDirectory(obsidian)) ||
		!(await isDirectory(plugins))
	) {
		throw new Error(
			"Target must be an existing Obsidian vault with a plugins directory",
		);
	}
	if (!(await isDirectory(source)))
		throw new Error("Old ai-bridge plugin folder was not found");
	const activationPath = join(obsidian, "community-plugins.json");
	let enabledPlugins: unknown;
	try {
		enabledPlugins = JSON.parse(await readFile(activationPath, "utf8"));
	} catch (error) {
		if (isMissing(error))
			throw new Error(
				"community-plugins.json is required to verify plugin activation",
			);
		throw error;
	}
	if (
		!Array.isArray(enabledPlugins) ||
		!enabledPlugins.every((id) => typeof id === "string")
	)
		throw new Error("community-plugins.json must be a list of plugin IDs");
	if (
		enabledPlugins.includes("ai-bridge") ||
		enabledPlugins.includes("vaultwire")
	)
		throw new Error("Disable AI Bridge and Vaultwire before offline migration");
	if (await exists(destination))
		throw new Error("Vaultwire plugin folder already exists");
	if (await exists(backupDirectory))
		throw new Error("Migration backup already exists");
	const sourceData = join(source, "data.json");
	if (!(await isRegularFile(sourceData)))
		throw new Error("Old plugin data.json must be a regular file");
	await mkdir(backupDirectory);
	let backupComplete = false;
	try {
		await copy(sourceData, join(backupDirectory, "data.json"));
		backupComplete = true;
		stage = await mkdtemp(join(plugins, ".vaultwire-migration-"));
		await copy(sourceData, join(stage, "data.json"));
		await rename(stage, destination);
	} catch (error) {
		if (stage) await rm(stage, { recursive: true, force: true });
		if (!backupComplete)
			await rm(backupDirectory, { recursive: true, force: true });
		throw error;
	}
	return { backupDirectory };
}

/** Checks a path without following symbolic links. */
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

/** Accepts a real directory and refuses a symbolic-link target. */
async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

/** Accepts only a regular, non-link source data file. */
async function isRegularFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

/** Identifies missing-path errors without hiding other filesystem failures. */
function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/** Runs the migration only for the explicit vault path supplied by the operator. */
async function runMigration(): Promise<void> {
	const [vaultPath] = process.argv.slice(2);
	if (!vaultPath || process.argv.length !== 3) {
		throw new Error(
			"Usage: bun apps/plugin/tools/migrate-plugin.ts <vault-path>",
		);
	}
	const result = await migratePluginData(vaultPath);
	console.log(
		`Copied data.json to Vaultwire. Backup: ${result.backupDirectory}`,
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(import.meta.filename)
) {
	runMigration().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "Plugin migration failed",
		);
		process.exitCode = 1;
	});
}
