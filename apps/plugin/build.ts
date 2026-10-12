import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildResult, build } from "esbuild";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = resolve(packageDirectory, "dist");

export async function buildPlugin(): Promise<BuildResult> {
	await mkdir(outputDirectory, { recursive: true });
	const result = await build({
		entryPoints: [resolve(packageDirectory, "src/main.ts")],
		outfile: resolve(outputDirectory, "main.js"),
		bundle: true,
		format: "cjs",
		platform: "browser",
		target: "es2022",
		external: ["obsidian"],
		metafile: true,
	});
	await copyFile(
		resolve(packageDirectory, "manifest.json"),
		resolve(outputDirectory, "manifest.json"),
	);
	return result;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await buildPlugin();
}
