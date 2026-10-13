import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { buildPlugin } from "@plugin-tools/build";
import { describe, expect, it } from "vitest";

const outputDirectory = resolve(import.meta.dirname, "../dist");

describe("production plugin artifact", () => {
	it("emits the expected manifest beside a browser CommonJS bundle without builtin runtime imports", async () => {
		const result = await buildPlugin();
		const manifest = JSON.parse(
			readFileSync(resolve(outputDirectory, "manifest.json"), "utf8"),
		);
		const bundle = readFileSync(resolve(outputDirectory, "main.js"), "utf8");
		const metafile = result.metafile;
		if (!metafile)
			throw new Error("esbuild did not return the requested metafile");
		const builtinNames = new Set(
			builtinModules.map((name) => name.replace(/^node:/, "")),
		);
		const isBuiltin = (specifier: string) =>
			specifier.startsWith("node:") ||
			builtinNames.has(specifier) ||
			[...builtinNames].some((name) => specifier.startsWith(`${name}/`));

		expect(existsSync(resolve(outputDirectory, "main.js"))).toBe(true);
		expect(existsSync(resolve(outputDirectory, "manifest.json"))).toBe(true);
		expect(manifest.id).toBe("ai-bridge");
		expect(manifest.minAppVersion).toBe("1.13.0");
		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.version).toBe("0.1.0");
		expect(bundle).toMatch(/module\.exports|exports\./);

		const runtimeImports = Object.values(metafile.outputs).flatMap(
			(output) => output.imports,
		);
		expect(
			runtimeImports.filter((item) => item.external).map((item) => item.path),
		).toEqual(["obsidian"]);
		expect(runtimeImports.some((item) => isBuiltin(item.path))).toBe(false);
		expect(
			Object.keys(metafile.inputs).some((input) =>
				/(^|\/)(node:|electron|bun:|node_modules\/(@types\/node|typescript\/))/i.test(
					input,
				),
			),
		).toBe(false);
	});
});
