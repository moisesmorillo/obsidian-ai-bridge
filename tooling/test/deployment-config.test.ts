import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Raw production configuration text, used to reject local fixture strings in the deployed settings. */
const productionConfigText = readFileSync(
	new URL("../../apps/worker/wrangler.production.jsonc", import.meta.url),
	"utf8",
);
/** Parsed production settings for direct checks of each Cloudflare binding and route. */
const productionConfig = JSON.parse(productionConfigText) as Record<
	string,
	unknown
>;

describe("production Worker configuration", () => {
	it("uses the configured object name at every Durable Object routing seam", () => {
		const entry = readFileSync(
			new URL("../../apps/worker/src/index.ts", import.meta.url),
			"utf8",
		);
		const oauth = readFileSync(
			new URL(
				"../../apps/worker/src/infrastructure/auth/oauth.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(entry.split("idFromName(")).toHaveLength(8);
		expect(oauth.split("idFromName(")).toHaveLength(3);
		expect(entry).not.toContain("idFromName(new URL");
		expect(oauth).not.toContain("idFromName(new URL");
		expect(entry).not.toContain("idFromName(env.SERVICE_ORIGIN");
		expect(oauth).not.toContain("idFromName(env.SERVICE_ORIGIN");
		expect(entry).toContain("idFromName(env.VAULT_OBJECT_NAME");
		expect(oauth).toContain("callbackEnv.VAULT_OBJECT_NAME");
		expect(oauth).toContain("idFromName(objectName)");
	});

	it("deploys only from a release event or an owner dispatch", () => {
		const workflow = readFileSync(
			new URL("../../.github/workflows/deploy.yml", import.meta.url),
			"utf8",
		);
		expect(workflow).toContain("workflow_call:");
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toContain("  push:");
		expect(workflow).toContain(
			"github.actor == github.repository_owner && github.triggering_actor == github.repository_owner",
		);
		expect(workflow).toContain(
			"bun run --filter '@vaultwire/worker' preflight",
		);
		expect(workflow).toContain("VAULTWIRE_CUTOVER_AUTHORIZED");
		expect(workflow).toContain("OAB-50.6 must approve it");
		expect(workflow).toContain("PENDING_S17_VAULTWIRE_");
		expect(workflow).toContain(
			"https://vaultwire.mmorillo.dev/.well-known/oauth-protected-resource",
		);
		expect(workflow).toContain("CLOUDFLARE_DEPLOY_TOKEN");
	});
	it("uses the production Worker name, canonical origin, and disabled alternate routes", () => {
		expect(productionConfig.name).toBe("vaultwire");
		expect(productionConfig.account_id).toBe(
			"cb1688e69610249def9ac8e0448d5040",
		);
		expect(productionConfig.vars).toEqual({
			SERVICE_ORIGIN: "https://vaultwire.mmorillo.dev",
			VAULT_OBJECT_NAME: "obsidian-bridge.mmorillo.dev",
			ACCESS_TEAM_DOMAIN: "https://mmorillo.cloudflareaccess.com",
			ACCESS_AUDIENCE:
				"1ccdb36c95194c63eeb487eb666285ab5832e35cd0e10eb74a4cdd3141a3ed95",
		});
		expect(productionConfig.vars).not.toHaveProperty("OWNER_SUBJECT");
		const authVars = productionConfig.vars as Record<string, string>;
		expect(new URL(authVars.ACCESS_TEAM_DOMAIN).protocol).toBe("https:");
		expect(authVars.ACCESS_AUDIENCE.length).toBeGreaterThan(0);
		expect(productionConfig.workers_dev).toBe(false);
		expect(productionConfig.preview_urls).toBe(false);
		expect(productionConfig).not.toHaveProperty("route");
		expect(productionConfig).not.toHaveProperty("routes");
		expect(productionConfigText).not.toContain("custom_domain");
	});

	it("binds the Vault, OAuth KV, blob and backup R2 buckets, and hourly Cron", () => {
		const config = productionConfig as {
			durable_objects?: { bindings?: Array<Record<string, unknown>> };
			kv_namespaces?: Array<Record<string, unknown>>;
			r2_buckets?: Array<Record<string, unknown>>;
			triggers?: { crons?: string[] };
			migrations?: Array<Record<string, unknown>>;
		};

		expect(config.durable_objects?.bindings).toContainEqual({
			name: "VAULTS",
			class_name: "Vault",
		});
		expect(config.kv_namespaces).toHaveLength(1);
		expect(config.kv_namespaces).toEqual([
			{
				binding: "OAUTH_KV",
				id: "f1332596a3e84e4691d5ce71f1131510",
			},
		]);
		expect(config.r2_buckets).toEqual([
			{ binding: "R2_BUCKET", bucket_name: "vaultwire-blobs" },
			{ binding: "BACKUP_BUCKET", bucket_name: "vaultwire-backups" },
		]);
		expect(config.triggers?.crons).toEqual(["0 * * * *"]);
		expect(config.migrations).toEqual([
			{
				tag: "vaultwire-transfer-v1",
				transferred_classes: [
					{
						from: "Vault",
						from_script: "obsidian-ai-bridge",
						to: "Vault",
					},
				],
			},
		]);
		expect(config.migrations?.[0]).not.toHaveProperty("new_sqlite_classes");
	});

	it("uses isolated development scripts and local namespace creation", () => {
		const development = JSON.parse(
			readFileSync(
				new URL("../../apps/worker/wrangler.jsonc", import.meta.url),
				"utf8",
			),
		) as {
			name: string;
			vars: { VAULT_OBJECT_NAME: string };
			migrations: Array<Record<string, unknown>>;
		};
		const f2 = JSON.parse(
			readFileSync(
				new URL("../../apps/worker/wrangler.f2.jsonc", import.meta.url),
				"utf8",
			),
		) as {
			name: string;
			vars: { VAULT_OBJECT_NAME: string };
			migrations: Array<Record<string, unknown>>;
		};

		expect(development.name).toBe("vaultwire-development");
		expect(f2.name).toBe("vaultwire-f2-tests");
		expect(development.name).not.toBe(productionConfig.name);
		expect(f2.name).not.toBe(productionConfig.name);
		expect(development.vars.VAULT_OBJECT_NAME).toBe(development.name);
		expect(f2.vars.VAULT_OBJECT_NAME).toBe(f2.name);
		expect(development.vars.VAULT_OBJECT_NAME).not.toBe(
			f2.vars.VAULT_OBJECT_NAME,
		);
		for (const config of [development, f2]) {
			expect(config.migrations).toHaveLength(1);
			expect(config.migrations[0]).toHaveProperty("new_sqlite_classes", [
				"Vault",
			]);
			expect(config.migrations[0]).not.toHaveProperty("transferred_classes");
		}
	});

	it("contains no local or synthetic authentication fixtures", () => {
		expect(productionConfigText).not.toContain("oab-f2-local-kv");
		expect(productionConfigText).not.toContain("oab-f2-test-blobs");
		expect(productionConfigText).not.toContain("service.test");
		expect(productionConfigText).not.toContain("team.test");
		expect(productionConfigText).not.toContain("synthetic-owner");
		expect(productionConfigText).not.toContain("synthetic-access-app");
	});

	it("ignores local UniPi settings", () => {
		const gitignore = readFileSync(
			new URL("../../.gitignore", import.meta.url),
			"utf8",
		);

		expect(gitignore.split("\n")).toContain(".unipi/");
	});
});
