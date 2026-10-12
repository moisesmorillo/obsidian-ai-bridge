import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readJson<T>(path: URL): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

type PackageConfig = {
	exports?: Record<string, string>;
	imports?: Record<string, string>;
};
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
const biome = readJson<BiomeConfig>(
	new URL("../../../biome.json", import.meta.url),
);

const aliases = [
	{
		name: "protocol",
		packageJson: protocolPackage,
		tsconfig: protocolTsconfig,
		paths: { "#protocol/*": ["./src/*"] },
		imports: { "#protocol/*": "./src/*.ts" },
	},
	{
		name: "worker",
		packageJson: workerPackage,
		tsconfig: workerTsconfig,
		paths: { "#worker/*": ["./src/*"] },
		imports: { "#worker/*": "./src/*.ts" },
	},
	{
		name: "plugin",
		packageJson: pluginPackage,
		tsconfig: pluginTsconfig,
		paths: {
			obsidian: ["./node_modules/obsidian/obsidian.d.ts"],
			"#plugin/*": ["./src/*"],
			"#plugin-tools/build": ["./build.ts"],
		},
		imports: {
			"#plugin/*": "./src/*.ts",
			"#plugin-tools/build": "./build.ts",
		},
	},
];

const relativeImportRule = biome.linter?.rules?.style?.noRestrictedImports;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

function run(command: string, args: string[], cwd: string, input?: string) {
	return spawnSync(command, args, { cwd, encoding: "utf8", input });
}

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

describe("workspace import aliases", () => {
	it.each(aliases)(
		"keeps $name TypeScript and native package mappings paired",
		(workspace) => {
			const compilerOptions = workspace.tsconfig.compilerOptions ?? {};
			expect(compilerOptions.baseUrl).toBeUndefined();
			expect(compilerOptions.paths).toEqual(workspace.paths);
			expect(workspace.packageJson.imports).toEqual(workspace.imports);
		},
	);

	it("retains the public protocol package export", () => {
		expect(protocolPackage.exports?.["."]).toBe("./src/index.ts");
	});

	it("preserves plugin tooling roots and inherits its source aliases", () => {
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
		expect(pluginTsconfig.compilerOptions?.paths?.obsidian).toEqual([
			"./node_modules/obsidian/obsidian.d.ts",
		]);
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
				'import worker from "#worker/index"; import { readFileSync } from "node:fs"; import { formatETag } from "@obsidian-ai-bridge/protocol"; void worker; void readFileSync; void formatETag;',
			);
			const allowed = lint(allowedPath);
			expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
		});
	});

	it("typechecks and bundles a raw public protocol consumer without private alias paths", async () => {
		const compiler = join(repositoryRoot, "node_modules/.bin/tsc");
		const esbuild = join(
			repositoryRoot,
			"apps/plugin/node_modules/.bin/esbuild",
		);
		expect(existsSync(compiler)).toBe(true);
		expect(existsSync(esbuild)).toBe(true);

		await withTemporaryDirectory(".protocol-public-consumer-", async (root) => {
			const moduleDirectory = join(root, "node_modules/@obsidian-ai-bridge");
			await mkdir(moduleDirectory, { recursive: true });
			await symlink(packageRoot, join(moduleDirectory, "protocol"), "dir");
			await writeFile(
				join(root, "consumer.ts"),
				'import { PathSchema, formatETag, parseETag } from "@obsidian-ai-bridge/protocol";\nconst path = PathSchema.parse("Notes/example.md");\nif (path !== "Notes/example.md") throw new Error("Unexpected normalized path");\nconst epoch = "a".repeat(32);\nconst tag = formatETag(epoch, 1);\nif (tag !== String.fromCharCode(34) + epoch + ".1" + String.fromCharCode(34)) throw new Error("Unexpected formatted ETag");\nconst parsed = parseETag(tag);\nif (parsed.epoch !== epoch || parsed.rev !== 1) throw new Error("Unexpected parsed ETag");\n',
			);
			const consumerConfig = {
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
			expect(consumerConfig.compilerOptions).not.toHaveProperty("paths");
			await writeFile(
				join(root, "tsconfig.json"),
				JSON.stringify(consumerConfig),
			);

			const typecheck = run(
				compiler,
				["--noEmit", "--pretty", "false", "-p", join(root, "tsconfig.json")],
				root,
			);
			expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
			const bundle = run(
				esbuild,
				[
					"consumer.ts",
					"--bundle",
					"--platform=browser",
					`--outfile=${join(root, "consumer.js")}`,
				],
				root,
			);
			expect(bundle.status, bundle.stdout + bundle.stderr).toBe(0);
			const bundlePath = join(root, "consumer.js");
			expect(existsSync(bundlePath)).toBe(true);
			const execution = run(process.execPath, [bundlePath], root);
			expect(execution.status, execution.stdout + execution.stderr).toBe(0);
		});
	});
});
