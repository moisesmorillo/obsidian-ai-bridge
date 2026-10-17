import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Reads trusted fixture JSON with a caller-declared shape, not runtime validation. */
function readJson<T>(path: URL): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Models only package export and import fields inspected by alias boundary tests. */
type PackageConfig = {
	exports?: Record<string, string>;
	imports?: Record<string, string>;
};
/** Models configuration fields inspected by consumer and runtime isolation tests. */
type TsConfig = {
	extends?: string;
	include?: string[];
	compilerOptions?: {
		baseUrl?: string;
		lib?: string[];
		noEmit?: boolean;
		paths?: Record<string, string[]>;
		types?: string[];
	};
};
/** Models the import restriction configuration inspected by the alias contract tests. */
type BiomeConfig = {
	linter?: {
		rules?: {
			style?: {
				noRestrictedImports?: {
					level?: string;
					options?: {
						patterns?: Array<{ group?: string[]; message?: string }>;
					};
				};
			};
		};
	};
};

const protocolPackage = readJson<PackageConfig>(
	new URL("../package.json", import.meta.url),
);
const protocolTsconfig = readJson<TsConfig>(
	new URL("../tsconfig.json", import.meta.url),
);
const workerPackage = readJson<PackageConfig>(
	new URL("../../../apps/worker/package.json", import.meta.url),
);
const workerTsconfig = readJson<TsConfig>(
	new URL("../../../apps/worker/tsconfig.json", import.meta.url),
);
const pluginPackage = readJson<PackageConfig>(
	new URL("../../../apps/plugin/package.json", import.meta.url),
);
const pluginTsconfig = readJson<TsConfig>(
	new URL("../../../apps/plugin/tsconfig.json", import.meta.url),
);
const pluginToolsTsconfig = readJson<TsConfig>(
	new URL("../../../apps/plugin/tsconfig.tools.json", import.meta.url),
);
const sharedTsconfigUrl = new URL(
	"../../../tsconfig.aliases.json",
	import.meta.url,
);
const sharedTsconfig = existsSync(fileURLToPath(sharedTsconfigUrl))
	? readJson<TsConfig>(sharedTsconfigUrl)
	: undefined;
const biome = readJson<BiomeConfig>(
	new URL("../../../biome.json", import.meta.url),
);

const workspaces = [
	{
		name: "protocol",
		packageJson: protocolPackage,
		tsconfig: protocolTsconfig,
	},
	{ name: "worker", packageJson: workerPackage, tsconfig: workerTsconfig },
	{ name: "plugin", packageJson: pluginPackage, tsconfig: pluginTsconfig },
];
const expectedSharedPaths = {
	"@protocol/*": ["./packages/protocol/src/*"],
	"@tooling/*": ["./tooling/*"],
	"@worker/*": ["./apps/worker/src/*"],
	"@plugin/*": ["./apps/plugin/src/*"],
	"@plugin-tools/build": ["./apps/plugin/build.ts"],
	obsidian: ["./apps/plugin/node_modules/obsidian/obsidian.d.ts"],
};
const relativeImportRule = biome.linter?.rules?.style?.noRestrictedImports;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

/** Preserves subprocess output and status for cause-specific assertions, including expected failures. */
function run(command: string, args: string[], cwd: string) {
	return spawnSync(command, args, { cwd, encoding: "utf8" });
}

/** Owns a repository-local fixture directory and removes it after success or failure. */
async function withTemporaryDirectory<T>(
	prefix: string,
	runFixture: (root: string) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(repositoryRoot, prefix));
	try {
		return await runFixture(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Copies the real public producer into an isolated consumer fixture without publishing or changing production files. */
async function createPublicConsumerFixture(root: string): Promise<string> {
	const fixturePackage = join(root, "producer/packages/protocol");
	await mkdir(fixturePackage, { recursive: true });
	await cp(join(packageRoot, "src"), join(fixturePackage, "src"), {
		recursive: true,
	});
	await cp(
		join(packageRoot, "package.json"),
		join(fixturePackage, "package.json"),
	);
	await symlink(
		join(packageRoot, "node_modules"),
		join(fixturePackage, "node_modules"),
		"dir",
	);

	const packageJsonPath = join(fixturePackage, "package.json");
	const packageJson = JSON.parse(
		await readFile(packageJsonPath, "utf8"),
	) as PackageConfig;
	delete packageJson.imports;
	await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

	const moduleDirectory = join(root, "node_modules/@obsidian-ai-bridge");
	await mkdir(moduleDirectory, { recursive: true });
	await symlink(fixturePackage, join(moduleDirectory, "protocol"), "dir");
	await writeFile(
		join(root, "consumer.ts"),
		'import { PathSchema, formatETag, parseETag } from "@obsidian-ai-bridge/protocol";\n' +
			'const path = PathSchema.parse("Notes/example.md");\n' +
			'if (path !== "Notes/example.md") throw new Error("Unexpected normalized path");\n' +
			'const epoch = "a".repeat(32);\n' +
			"const tag = formatETag(epoch, 1);\n" +
			'if (tag !== String.fromCharCode(34) + epoch + ".1" + String.fromCharCode(34)) throw new Error("Unexpected formatted ETag");\n' +
			"const parsed = parseETag(tag);\n" +
			'if (parsed.epoch !== epoch || parsed.rev !== 1) throw new Error("Unexpected parsed ETag");\n',
	);
	return fixturePackage;
}

/** Selects shared alias inheritance for the consumer compiler control. No ambient runtime types enter the consumer. */
function makeConsumerConfig(withSharedAliases: boolean) {
	return {
		...(withSharedAliases ? { extends: "../tsconfig.aliases.json" } : {}),
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			strict: true,
			noEmit: true,
			types: [],
		},
		include: ["consumer.ts"],
	};
}

describe("workspace import aliases", () => {
	it.each(workspaces)(
		"inherits exact shared @ aliases for $name",
		(workspace) => {
			expect(workspace.tsconfig.extends).toBe("../../tsconfig.aliases.json");
			expect(workspace.packageJson.imports).toBeUndefined();
			expect(sharedTsconfig).toBeDefined();
			expect(sharedTsconfig?.extends).toBe("./tsconfig.base.json");
			expect(sharedTsconfig?.compilerOptions?.baseUrl).toBeUndefined();
			expect(sharedTsconfig?.compilerOptions?.paths).toEqual(
				expectedSharedPaths,
			);
		},
	);

	it("retains the public protocol package export", () => {
		expect(protocolPackage.exports?.["."]).toBe("./src/index.ts");
	});

	it("preserves plugin tooling roots and inherits workspace aliases", () => {
		expect(pluginToolsTsconfig.extends).toBe("./tsconfig.json");
		expect(pluginToolsTsconfig.include).toEqual([
			"build.ts",
			"vitest.config.ts",
			"test/**/*.ts",
		]);
		expect(pluginToolsTsconfig.compilerOptions).toEqual({
			types: ["bun"],
			lib: ["ES2022", "DOM"],
			noEmit: true,
		});
		expect(pluginTsconfig.compilerOptions?.types).toEqual([]);
	});

	it("restricts relative module imports", () => {
		expect(relativeImportRule?.level).toBe("error");
		expect(relativeImportRule?.options?.patterns).toEqual([
			{
				group: ["./*", "../*"],
				message: "Use workspace-local import aliases.",
			},
		]);
	});

	it("reports relative value and type imports while allowing workspace, builtin, and public imports", async () => {
		const biomePath = join(repositoryRoot, "node_modules/.bin/biome");
		const configPath = join(repositoryRoot, "biome.json");
		/** Runs the installed import rule against fixture files and preserves exact diagnostics. */
		const lint = (path: string) =>
			run(
				biomePath,
				[
					"lint",
					"--only=style/noRestrictedImports",
					`--config-path=${configPath}`,
					"--colors=off",
					path,
				],
				repositoryRoot,
			);

		await withTemporaryDirectory(".biome-import-aliases-", async (root) => {
			const forbiddenPath = join(root, "forbidden.ts");
			await writeFile(
				forbiddenPath,
				'import value from "./relative"; import type { Relative } from "../types"; void value; let typeProbe: Relative; void typeProbe;',
			);
			const forbidden = lint(forbiddenPath);
			const diagnostics = forbidden.stdout + forbidden.stderr;
			expect(forbidden.status).not.toBe(0);
			expect(
				diagnostics.match(/lint\/style\/noRestrictedImports/g),
			).toHaveLength(2);
			expect(
				diagnostics.match(/Use workspace-local import aliases\./g),
			).toHaveLength(2);

			const allowedPath = join(root, "allowed.ts");
			await writeFile(
				allowedPath,
				'import worker from "@worker/index"; import { readFileSync } from "node:fs"; import { formatETag } from "@obsidian-ai-bridge/protocol"; void worker; void readFileSync; void formatETag;',
			);
			const allowed = lint(allowedPath);
			expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
		});
	});

	it("compiles, bundles, and executes a consumer using the actual shared monorepo aliases", async () => {
		expect(sharedTsconfig).toBeDefined();
		const compiler = join(repositoryRoot, "node_modules/.bin/tsc");
		const esbuild = join(
			repositoryRoot,
			"apps/plugin/node_modules/.bin/esbuild",
		);
		expect(existsSync(compiler)).toBe(true);
		expect(existsSync(esbuild)).toBe(true);

		await withTemporaryDirectory(".protocol-public-consumer-", async (root) => {
			await createPublicConsumerFixture(root);
			const configPath = join(root, "tsconfig.json");
			await writeFile(configPath, JSON.stringify(makeConsumerConfig(false)));
			const configFreeResult = run(
				compiler,
				["--noEmit", "--pretty", "false", "-p", configPath],
				root,
			);
			const configFreeErrors =
				`${configFreeResult.stdout}\n${configFreeResult.stderr}`
					.split(/\r?\n/)
					.filter((line) => /error TS\d+:/.test(line));
			expect(configFreeResult.status).not.toBe(0);
			expect(configFreeErrors.length).toBeGreaterThan(0);
			expect(
				configFreeErrors.every((line) =>
					line.includes("Cannot find module '@protocol/"),
				),
			).toBe(true);

			await writeFile(configPath, JSON.stringify(makeConsumerConfig(true)));
			const typecheck = run(
				compiler,
				["--noEmit", "--pretty", "false", "-p", join(root, "tsconfig.json")],
				root,
			);
			expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
			const bundlePath = join(root, "consumer.js");
			const bundle = run(
				esbuild,
				[
					"consumer.ts",
					"--bundle",
					"--platform=browser",
					`--outfile=${bundlePath}`,
				],
				root,
			);
			expect(bundle.status, bundle.stdout + bundle.stderr).toBe(0);
			expect(existsSync(bundlePath)).toBe(true);
			const execution = run(process.execPath, [bundlePath], root);
			expect(execution.status, execution.stdout + execution.stderr).toBe(0);
		});
	});
});
