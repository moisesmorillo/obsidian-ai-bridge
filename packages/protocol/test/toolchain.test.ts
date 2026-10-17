import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

/** Reads tracked configuration relative to the repository rather than the test process directory. */
async function readRootFile(path: string): Promise<string> {
	return readFile(new URL(path, root), "utf8");
}

/** Reads trusted repository JSON for toolchain assertions. The result is not runtime protocol validation. */
async function readManifest(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readRootFile(path)) as Record<string, unknown>;
}

/** Combines declared dependency sections for version checks without resolving installed packages. */
function versions(manifest: Record<string, unknown>): Record<string, string> {
	return {
		...(manifest.dependencies as Record<string, string> | undefined),
		...(manifest.devDependencies as Record<string, string> | undefined),
	};
}

describe("repository toolchain configuration", () => {
	it("pins Bun and Node in mise and removes the legacy Bun pin", async () => {
		expect(await readRootFile("mise.toml")).toMatch(/bun\s*=\s*"1\.4\.3"/);
		expect(await readRootFile("mise.toml")).toMatch(/node\s*=\s*"24\.21\.0"/);
		await expect(readRootFile(".bun-version")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("uses immutable pinned mise setup in CI without duplicate runtime pins", async () => {
		const workflow = await readRootFile(".github/workflows/check.yml");
		expect(workflow).toContain(
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		);
		expect(workflow).toContain(
			"jdx/mise-action@08ae2a091c038e1e05ec6f5115dc5c69d5a2a6b8",
		);
		expect(workflow).toMatch(/version:\s*["']?2026\.10\.8["']?/);
		expect(workflow).not.toMatch(/setup-bun|bun-version|node-version/);
		expect(workflow).toContain("bun install --frozen-lockfile");
		expect(workflow).toContain("bun run check");
	});

	it("pins the requested stable tooling and Workers plugin", async () => {
		const rootVersions = versions(await readManifest("package.json"));
		const pluginVersions = versions(
			await readManifest("apps/plugin/package.json"),
		);
		const workerVersions = versions(
			await readManifest("apps/worker/package.json"),
		);
		expect(rootVersions).toMatchObject({
			"@biomejs/biome": "2.5.15",
			"@types/bun": "1.4.3",
			typescript: "7.0.2",
			vitest: "5.0.4",
		});
		expect(pluginVersions).toMatchObject({
			"@codemirror/view": "6.43.13",
			esbuild: "0.28.2",
			obsidian: "1.14.4",
		});
		expect(workerVersions).toMatchObject({
			"@cloudflare/vitest-plugin": "1.4.0",
		});
		expect(workerVersions).not.toHaveProperty(
			"@cloudflare/vitest-pool-workers",
		);
		expect(await readRootFile("biome.json")).toContain(
			"https://biomejs.dev/schemas/2.5.15/schema.json",
		);
	});

	it("documents mise-based setup and preserves both protocol typecheck commands", async () => {
		const readme = await readRootFile("README.md");
		expect(readme).toMatch(/mise trust/);
		expect(readme).toMatch(/mise install/);
		expect(readme).toMatch(/mise exec -- bun install --frozen-lockfile/);
		expect(readme).toMatch(/mise exec -- bun run check/);
		const protocol = await readManifest("packages/protocol/package.json");
		expect(protocol.scripts).toMatchObject({
			typecheck: expect.stringContaining("tsc --noEmit -p tsconfig.json"),
		});
		expect(protocol.scripts).toMatchObject({
			typecheck: expect.stringContaining("tsconfig.tools.json"),
		});
	});
});
