import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const migrationDirectory = "./drizzle";
const generatedModule = "./src/infrastructure/sqlite/schema.generated.ts";
const checkOnly = process.argv.includes("--check");

async function readInitialMigration(directory: string): Promise<{
	name: string;
	sql: string;
}> {
	const files = (await readdir(directory)).filter((name) =>
		name.endsWith(".sql"),
	);
	if (files.length !== 1 || !/^0000_[a-z0-9_]+\.sql$/.test(files[0] ?? "")) {
		throw new Error(
			`Expected only the version-0 initial relational DDL artifact; found ${files.join(", ") || "none"}`,
		);
	}
	const name = files[0];
	if (!name) throw new Error("Initial generated vault DDL file is missing");
	return { name, sql: await readFile(join(directory, name), "utf8") };
}

function formatGeneratedModule(source: string): string {
	return execFileSync(
		resolve("../../node_modules/.bin/biome"),
		["format", `--stdin-file-path=${generatedModule}`],
		{ encoding: "utf8", input: source },
	);
}

const checkedInMigration = await readInitialMigration(migrationDirectory);
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
		const currentModelMigration =
			await readInitialMigration(temporaryDirectory);
		if (currentModelMigration.sql !== checkedInMigration.sql) {
			throw new Error(
				"Drizzle model differs from the versioned initial DDL; run bun run db:generate and review the result",
			);
		}
	} finally {
		rmSync(temporaryConfigDirectory, { recursive: true, force: true });
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

const statements = checkedInMigration.sql
	.split("--> statement-breakpoint")
	.map((statement) => statement.trim())
	.filter(Boolean);
if (statements.length === 0) {
	throw new Error("Generated vault DDL contains no statements");
}

const source = `/** Generated from Drizzle Kit's versioned initial migration; do not edit. */\nexport const RELATIONAL_SCHEMA_STATEMENTS = ${JSON.stringify(statements, null, 2)} as const;\n`;
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
