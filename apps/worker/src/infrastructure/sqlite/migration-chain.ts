/** One numbered relational migration, ordered by its four-digit filename prefix. */
export interface RelationalMigration {
	name: string;
	sql: string;
}

/** Split sequential migration files into the exact DDL statements used for bootstrap. */
export function mergeRelationalMigrations(
	migrations: readonly RelationalMigration[],
): string[] {
	const statements: string[] = [];
	for (const [index, migration] of migrations.entries()) {
		const expectedPrefix = String(index).padStart(4, "0");
		if (
			!migration.name.startsWith(`${expectedPrefix}_`) ||
			!migration.name.endsWith(".sql")
		)
			throw new Error("Expected sequential relational migration files");
		for (const statement of migration.sql
			.split("--> statement-breakpoint")
			.map((item) => item.trim())
			.filter(Boolean))
			statements.push(statement);
	}
	if (migrations.length === 0 || statements.length === 0)
		throw new Error("Generated vault DDL contains no statements");
	return statements;
}

/** Map relational CREATE statements to normalized catalog SQL by object name. */
export function relationalSchemaDefinitions(
	migrations: readonly RelationalMigration[],
): Map<string, string> {
	const definitions = new Map<string, string>();
	for (const statement of mergeRelationalMigrations(migrations)) {
		const header =
			/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+[`"]?([A-Za-z_][A-Za-z_0-9]*)\b[`"]?/i.exec(
				statement,
			);
		const name = header?.[2];
		if (!name) throw new Error("Invalid relational migration statement");
		if (definitions.has(name))
			throw new Error(`Duplicate relational schema object: ${name}`);
		definitions.set(
			name,
			statement.trim().replace(/;\s*$/, "").replace(/\s+/g, " "),
		);
	}
	return definitions;
}
