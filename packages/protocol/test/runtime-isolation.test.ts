import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function diagnosticsForOverlay(
	configName: string,
	targetRelativePath: string,
	probe: string,
): string[] {
	const configPath = resolve(packageRoot, configName);
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) {
		throw new Error(
			ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
		);
	}

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		dirname(configPath),
		undefined,
		configPath,
	);
	if (parsed.errors.length > 0) {
		throw new Error(
			parsed.errors
				.map((error) =>
					ts.flattenDiagnosticMessageText(error.messageText, "\n"),
				)
				.join("\n"),
		);
	}

	const targetPath = resolve(packageRoot, targetRelativePath);
	const host = ts.createCompilerHost(parsed.options);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (
		fileName,
		languageVersion,
		onError,
		shouldCreateNewSourceFile,
	) => {
		const sourceFile = originalGetSourceFile(
			fileName,
			languageVersion,
			onError,
			shouldCreateNewSourceFile,
		);
		if (resolve(fileName) !== targetPath || sourceFile === undefined) {
			return sourceFile;
		}

		return ts.createSourceFile(
			fileName,
			`${sourceFile.text}\n${probe}`,
			languageVersion,
		);
	};

	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
		host,
	});
	const sourceFile = program.getSourceFile(targetPath);
	if (sourceFile === undefined) {
		throw new Error(`Project does not include ${targetRelativePath}`);
	}
	const probeStart = sourceFile.text.length - probe.length;

	return ts
		.getPreEmitDiagnostics(program)
		.filter(
			(diagnostic) =>
				diagnostic.file !== undefined &&
				resolve(diagnostic.file.fileName) === targetPath &&
				diagnostic.start !== undefined &&
				diagnostic.start >= probeStart,
		)
		.map((diagnostic) => {
			const start = diagnostic.start as number;
			return sourceFile.text.slice(start, start + (diagnostic.length ?? 0));
		});
}

describe("protocol runtime type isolation", () => {
	it("rejects Node and Bun globals while allowing web-standard source globals", () => {
		const identifiers = diagnosticsForOverlay(
			"tsconfig.json",
			"src/index.ts",
			[
				"const __processProbe = process.version;",
				'const __bufferProbe = Buffer.from("x").toString();',
				"const __bunProbe = Bun.version;",
				'const __urlProbe: URL = new URL("https://example.com");',
				'const __encoderProbe: Uint8Array = new TextEncoder().encode("x");',
			].join("\n"),
		);

		expect(identifiers).toEqual(
			expect.arrayContaining(["process", "Buffer", "Bun"]),
		);
		expect(identifiers).not.toContain("URL");
		expect(identifiers).not.toContain("TextEncoder");
		expect(identifiers).not.toContain("Uint8Array");
	});

	it("keeps Node globals available in the separate tooling type environment", () => {
		const toolingConfig = existsSync(
			resolve(packageRoot, "tsconfig.tools.json"),
		)
			? "tsconfig.tools.json"
			: "tsconfig.json";
		const identifiers = diagnosticsForOverlay(
			toolingConfig,
			"test/path.test.ts",
			[
				"const __toolProcessProbe: string = process.version;",
				'const __toolBufferProbe: string = Buffer.from("x").toString();',
			].join("\n"),
		);

		expect(identifiers).not.toContain("process");
		expect(identifiers).not.toContain("Buffer");
	});
});
