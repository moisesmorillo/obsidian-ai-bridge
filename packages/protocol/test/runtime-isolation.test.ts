import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const compilerPath = resolve(repositoryRoot, "node_modules/.bin/tsc");
const runtimeProbe = [
	"const __processProbe = process.version;",
	'const __bufferProbe = Buffer.from("x").toString();',
	"const __bunProbe = Bun.version;",
	'const __urlProbe: URL = new URL("https://example.com");',
	'const __encoderProbe: Uint8Array = new TextEncoder().encode("x");',
].join("\n");

interface Fixture {
	packageRoot: string;
}

interface CompilerResult {
	status: number;
	output: string;
	missingNames: string[];
	diagnosticCount: number;
}

async function withFixture<T>(
	run: (fixture: Fixture) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(
		join(repositoryRoot, ".protocol-runtime-isolation-"),
	);
	const fixturePackage = join(root, "packages/protocol");
	try {
		await mkdir(fixturePackage, { recursive: true });
		await cp(
			join(repositoryRoot, "tsconfig.base.json"),
			join(root, "tsconfig.base.json"),
		);
		await cp(join(packageRoot, "src"), join(fixturePackage, "src"), {
			recursive: true,
		});
		await cp(join(packageRoot, "test"), join(fixturePackage, "test"), {
			recursive: true,
		});
		await cp(
			join(packageRoot, "package.json"),
			join(fixturePackage, "package.json"),
		);
		await cp(
			join(packageRoot, "tsconfig.json"),
			join(fixturePackage, "tsconfig.json"),
		);
		await cp(
			join(packageRoot, "tsconfig.tools.json"),
			join(fixturePackage, "tsconfig.tools.json"),
		);
		await cp(
			join(packageRoot, "vitest.config.ts"),
			join(fixturePackage, "vitest.config.ts"),
		);
		await symlink(
			join(packageRoot, "node_modules"),
			join(fixturePackage, "node_modules"),
			"dir",
		);
		return await run({ packageRoot: fixturePackage });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function addProbe(
	fixture: Fixture,
	relativePath: string,
	probe: string,
): Promise<void> {
	const path = join(fixture.packageRoot, relativePath);
	const source = await readFile(path, "utf8");
	await writeFile(path, `${source}\n${probe}\n`);
}

function runCompiler(fixture: Fixture, configName: string): CompilerResult {
	if (!existsSync(compilerPath)) {
		throw new Error(
			`Installed TypeScript compiler CLI is missing: ${compilerPath}`,
		);
	}
	const configPath = join(fixture.packageRoot, configName);
	if (!existsSync(configPath)) {
		throw new Error(`Fixture TypeScript config is missing: ${configPath}`);
	}
	const result = spawnSync(
		compilerPath,
		["--noEmit", "--pretty", "false", "-p", configPath],
		{ cwd: fixture.packageRoot, encoding: "utf8" },
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status === null) {
		throw new Error(
			`TypeScript CLI exited without a status: ${result.signal ?? "unknown signal"}`,
		);
	}
	const output = `${result.stdout}\n${result.stderr}`;
	const diagnosticCount = [...output.matchAll(/error TS\d+:/g)].length;
	const missingNames = [
		...output.matchAll(/error TS\d+: Cannot find name '([^']+)'/g),
	].map((match) => match[1]);
	return { status: result.status, output, missingNames, diagnosticCount };
}

function expectOnlyMissingNames(
	result: CompilerResult,
	expected: string[],
): void {
	expect(result.status).not.toBe(0);
	expect(result.diagnosticCount).toBe(expected.length);
	expect(result.missingNames).toEqual(expected);
}

describe("protocol runtime type isolation", () => {
	it("rejects only Node and Bun globals while allowing web-standard globals", async () => {
		await withFixture(async (fixture) => {
			await addProbe(fixture, "src/index.ts", runtimeProbe);
			const result = runCompiler(fixture, "tsconfig.json");
			expectOnlyMissingNames(result, ["process", "Buffer", "Bun"]);
			expect(result.missingNames).not.toContain("URL");
			expect(result.missingNames).not.toContain("TextEncoder");
			expect(result.missingNames).not.toContain("Uint8Array");
		});
	});

	it("allows Node globals in tooling and detects a leaky runtime config", async () => {
		await withFixture(async (fixture) => {
			const nodeProbe = [
				"const __toolProcessProbe: string = process.version;",
				'const __toolBufferProbe: string = Buffer.from("x").toString();',
			].join("\n");
			await addProbe(fixture, "test/path.test.ts", nodeProbe);
			const toolingResult = runCompiler(fixture, "tsconfig.tools.json");
			expect(toolingResult.status, toolingResult.output).toBe(0);
			expect(toolingResult.diagnosticCount).toBe(0);

			await addProbe(fixture, "src/index.ts", nodeProbe);
			await writeFile(
				join(fixture.packageRoot, "tsconfig.leaky.json"),
				JSON.stringify({
					extends: "./tsconfig.json",
					include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
				}),
			);
			const leakyRuntimeResult = runCompiler(fixture, "tsconfig.leaky.json");
			expect(leakyRuntimeResult.status, leakyRuntimeResult.output).toBe(0);
			expect(leakyRuntimeResult.diagnosticCount).toBe(0);
		});
	});
});
