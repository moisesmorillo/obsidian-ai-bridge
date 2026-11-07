import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	mergeRelationalMigrations,
	type RelationalMigration,
	relationalSchemaDefinitions,
} from "@worker/infrastructure/sqlite/migration-chain";

const migrationDirectory = "./drizzle";
const generatedModule = "./src/infrastructure/sqlite/schema.generated.ts";
const checkOnly = process.argv.includes("--check");

/**
 * Read every sequential Drizzle relational migration as UTF-8 SQL.
 *
 * @param directory - Directory that contains the versioned migration chain.
 * @returns Ordered migration filenames and SQL bodies.
 * @throws If files are missing, misnumbered, malformed, or inaccessible.
 */
async function readRelationalMigrations(
	directory: string,
): Promise<RelationalMigration[]> {
	const files = (await readdir(directory))
		.filter((name) => name.endsWith(".sql"))
		.sort();
	const migrations = await Promise.all(
		files.map(async (name) => ({
			name,
			sql: await readFile(join(directory, name), "utf8"),
		})),
	);
	mergeRelationalMigrations(migrations);
	return migrations;
}

/**
 * Format generated source with the repository Biome executable from the Worker working directory.
 * Relative executable and output paths resolve from `apps/worker`.
 *
 * @param source - Generated module source sent to Biome on standard input.
 * @returns The formatted module from standard output.
 * @throws If Biome cannot start or returns a nonzero exit status.
 */
function formatGeneratedModule(source: string): string {
	return execFileSync(
		resolve("../../node_modules/.bin/biome"),
		["format", `--stdin-file-path=${generatedModule}`],
		{ encoding: "utf8", input: source },
	);
}

const checkedInMigrations = await readRelationalMigrations(migrationDirectory);
const checkedInDefinitions = relationalSchemaDefinitions(checkedInMigrations);
if (checkOnly) {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "oab-vault-schema-"));
	const temporaryConfigDirectory = mkdtempSync(
		join("tooling", ".drizzle-config-"),
	);
	const temporaryConfig = join(temporaryConfigDirectory, "drizzle.config.ts");
	try {
		await writeFile(
			temporaryConfig,
			`import config from "../drizzle.config.ts";\nexport default { ...config, out: ${JSON.stringify(temporaryDirectory)} };\n`,
		);
		execFileSync(
			resolve("node_modules/.bin/drizzle-kit"),
			["generate", "--config", temporaryConfig],
			{ encoding: "utf8", stdio: "pipe" },
		);
		const currentModelMigrations =
			await readRelationalMigrations(temporaryDirectory);
		const currentModelDefinitions = relationalSchemaDefinitions(
			currentModelMigrations,
		);
		if (!sameDefinitions(currentModelDefinitions, checkedInDefinitions)) {
			throw new Error(
				"Drizzle model differs from the versioned relational migration chain; run bun run db:generate and review the result",
			);
		}
	} finally {
		rmSync(temporaryConfigDirectory, { recursive: true, force: true });
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

const statements = mergeRelationalMigrations(checkedInMigrations);
if (statements.length === 0) {
	throw new Error("Generated vault DDL contains no statements");
}

const source = `/** Generated from the Drizzle Kit relational migration chain; do not edit. */\nexport const RELATIONAL_SCHEMA_STATEMENTS = ${JSON.stringify(statements, null, 2)} as const;\n`;
const output = formatGeneratedModule(source);
if (checkOnly) {
	const current = await readFile(generatedModule, "utf8");
	if (current !== output) {
		throw new Error(
			"Runtime relational DDL artifact is stale; run bun run db:generate from apps/worker",
		);
	}
} else {
	await writeFile(generatedModule, output);
}

/** Compare every normalized relational object definition without relying on statement order. */
function sameDefinitions(
	left: Map<string, string>,
	right: Map<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [name, definition] of left)
		if (right.get(name) !== definition) return false;
	return true;
}
