import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Trusted repository configuration shape. This is not a runtime validator for external input. */
interface AliasConfig {
	compilerOptions: { paths: Record<string, string[]> };
}

/** Converts selected repository mappings to Vite aliases without changing workspace selection. */
export function resolveViteAliases(
	repositoryRoot: string,
	paths: Record<string, string[]>,
	names: readonly string[],
): Array<{ find: string; replacement: string }> {
	return names.map((name) => {
		const target = paths[name]?.[0];
		if (!target)
			throw new Error(`Missing TypeScript alias mapping for ${name}`);
		return {
			find: name.replace(/\/\*$/, ""),
			replacement: resolve(repositoryRoot, target.replace(/\*$/, "")),
		};
	});
}

/**
 * Reads trusted repository aliases and converts only the requested names.
 * File access, JSON syntax, configuration shape, and missing mapping failures stop configuration loading.
 */
export function readViteAliases(
	repositoryRoot: string,
	names: readonly string[],
): Array<{ find: string; replacement: string }> {
	const config = JSON.parse(
		readFileSync(resolve(repositoryRoot, "tsconfig.aliases.json"), "utf8"),
	) as AliasConfig;
	return resolveViteAliases(
		repositoryRoot,
		config.compilerOptions.paths,
		names,
	);
}
