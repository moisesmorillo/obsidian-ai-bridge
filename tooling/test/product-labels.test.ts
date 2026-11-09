import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Reads repository text for offline product-name checks. */
function repositoryText(path: string): string {
	return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Vaultwire product labels and package names", () => {
	it("uses the approved root and published workspace package names", () => {
		const root = JSON.parse(repositoryText("package.json"));
		const plugin = JSON.parse(repositoryText("apps/plugin/package.json"));
		const worker = JSON.parse(repositoryText("apps/worker/package.json"));
		const protocol = JSON.parse(
			repositoryText("packages/protocol/package.json"),
		);
		const tooling = JSON.parse(repositoryText("tooling/package.json"));
		const lock = repositoryText("bun.lock");

		expect(root.name).toBe("vaultwire");
		expect(plugin.name).toBe("@vaultwire/plugin");
		expect(worker.name).toBe("@vaultwire/worker");
		expect(protocol.name).toBe("@vaultwire/protocol");
		expect(tooling.name).toBe("@vaultwire/tooling");
		expect(plugin.dependencies).toHaveProperty(
			"@vaultwire/protocol",
			"workspace:*",
		);
		expect(worker.dependencies).toHaveProperty(
			"@vaultwire/protocol",
			"workspace:*",
		);
		expect(lock).toMatch(/"": \{\s*"name": "vaultwire"/);
		expect(lock).toMatch(/"apps\/plugin": \{\s*"name": "@vaultwire\/plugin"/);
		expect(lock).toMatch(/"apps\/worker": \{\s*"name": "@vaultwire\/worker"/);
		expect(lock).toMatch(
			/"packages\/protocol": \{\s*"name": "@vaultwire\/protocol"/,
		);
		expect(lock).toMatch(/"tooling": \{\s*"name": "@vaultwire\/tooling"/);
	});

	it("uses Vaultwire package filters and public tooling imports", () => {
		const root = repositoryText("package.json");
		const workflow = repositoryText(".github/workflows/check.yml");
		const protocolConfig = repositoryText("packages/protocol/vitest.config.ts");
		const pluginConfig = repositoryText("apps/plugin/vitest.config.ts");
		const workerConfig = repositoryText("apps/worker/tooling/vitest-config.ts");

		expect(root).toContain("@vaultwire/*");
		expect(workflow).toContain("@vaultwire/worker");
		expect(protocolConfig).toContain("@vaultwire/tooling/vite-aliases");
		expect(pluginConfig).toContain("@vaultwire/tooling/vite-aliases");
		expect(workerConfig).toContain("@vaultwire/tooling/vite-aliases");
	});

	it("separates historical vault evidence from current cutover duties", () => {
		const api = repositoryText("docs/api/f2.md");
		const readme = repositoryText("README.md");

		expect(api).toContain(
			"Historical OAB-7.8 evidence records four synthetic notes under `oab-7.8/` in the test vault at that time.",
		);
		expect(api).toContain(
			"OAB-50.4 must transfer the existing `Vault` Durable Object namespace to the `vaultwire` script.",
		);
		expect(api).toContain(
			"OAB-50.6 must copy every blob and backup object with SHA-256 checksums, preserve existing vault authority, and verify the journal cursor and file set against the final export before clients reconnect.",
		);
		expect(api).not.toContain("so no data migration is needed.");
		expect(readme).toContain("# Vaultwire");
		expect(readme).not.toContain("so no data migration is needed.");
	});

	it("uses Vaultwire in current plugin and owner-facing labels", () => {
		const settings = repositoryText("apps/plugin/src/settings.ts");
		const plugin = repositoryText("apps/plugin/src/main.ts");
		const ownerShell = repositoryText(
			"apps/worker/src/transport/owner-pages/shell.ts",
		);
		const consent = repositoryText(
			"apps/worker/src/transport/owner-pages/consent.ts",
		);
		const mcp = repositoryText("apps/worker/src/transport/mcp.ts");
		const oauth = repositoryText(
			"apps/worker/src/infrastructure/auth/oauth.ts",
		);
		const readme = repositoryText("README.md");

		expect(settings).toContain('text: "Vaultwire"');
		expect(settings).toContain("https://vaultwire.mmorillo.dev");
		expect(plugin).toContain(
			'DEFAULT_SERVER_URL = "https://vaultwire.mmorillo.dev"',
		);
		expect(plugin).toContain("Vaultwire kept your version");
		expect(ownerShell).toContain("Vaultwire · Owner console</title>");
		expect(ownerShell).toContain(">Vaultwire</div>");
		expect(consent).toContain("· Vaultwire</title>");
		expect(consent).toContain("<strong>Vaultwire</strong>");
		expect(mcp).toContain('{ name: "vaultwire", version: "1.0.0" }');
		expect(oauth).toContain('resource_name: "Vaultwire"');
		expect(readme).toContain("# Vaultwire");
		expect(readme).toContain(
			"Self-hosted vault sync and storage, with MCP tools for AI agents.",
		);
	});
});
