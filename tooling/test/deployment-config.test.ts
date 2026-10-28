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
	it("uses the production Worker name, canonical origin, and disabled alternate routes", () => {
		expect(productionConfig.name).toBe("obsidian-ai-bridge-f2");
		expect(productionConfig.account_id).toBe(
			"cb1688e69610249def9ac8e0448d5040",
		);
		expect(productionConfig.vars).toEqual({
			SERVICE_ORIGIN: "https://obsidian-bridge.mmorillo.dev",
			ACCESS_TEAM_DOMAIN: "https://mmorillo.cloudflareaccess.com",
			ACCESS_AUDIENCE:
				"814c82665e70c64298202c81873612c44297520b8947a9b08ac2742206b5a377",
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

	it("binds the Vault, OAuth KV, and immutable R2 bucket", () => {
		const config = productionConfig as {
			durable_objects?: { bindings?: Array<Record<string, unknown>> };
			kv_namespaces?: Array<Record<string, unknown>>;
			r2_buckets?: Array<Record<string, unknown>>;
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
				id: "afb1eaa5d1e444e98fd3b7c705d26d5f",
			},
		]);
		expect(config.r2_buckets).toEqual([
			{ binding: "R2_BUCKET", bucket_name: "oab-f2-immutable-blobs" },
		]);
		expect(config.migrations).toContainEqual({
			tag: "v1",
			new_sqlite_classes: ["Vault"],
		});
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
