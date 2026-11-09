import { describe, expect, it } from "vitest";
import { migrateLegacyPluginSettings } from "../src/infrastructure/plugin-settings-migration";

const sourcePath = ".obsidian/plugins/ai-bridge/data.json";
const destinationPath = ".obsidian/plugins/vaultwire/data.json";
const backupPath = ".obsidian/plugins/ai-bridge-vaultwire-backup/data.json";

/** Creates an Obsidian-like app with exact path effects for migration checks. */
function createMigrationApp(
	options: { files?: Record<string, string>; enabledPlugins?: string[] } = {},
) {
	const files = new Map([
		[
			".obsidian/community-plugins.json",
			JSON.stringify(options.enabledPlugins ?? []),
		],
		...Object.entries(options.files ?? {}),
	]);
	const directories = new Set([
		".obsidian/plugins/ai-bridge",
		".obsidian/plugins/vaultwire",
		".obsidian/plugins",
	]);
	const payload = new Map([
		[".ai-bridge/pending/operation-payload", "unsynced-bytes"],
	]);
	const adapter = {
		exists: async (path: string) => files.has(path) || directories.has(path),
		read: async (path: string) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`Missing ${path}`);
			return content;
		},
		write: async (path: string, content: string) => {
			files.set(path, content);
		},
		mkdir: async (path: string) => {
			directories.add(path);
		},
		remove: async (path: string) => {
			files.delete(path);
		},
		rmdir: async (path: string) => {
			directories.delete(path);
		},
		rename: async (from: string, to: string) => {
			const content = files.get(from);
			if (content === undefined) throw new Error(`Missing ${from}`);
			files.set(to, content);
			files.delete(from);
		},
	};
	const app = {
		plugins: { enabledPlugins: new Set(options.enabledPlugins ?? []) },
		vault: { adapter },
	};
	return { app, files, payload };
}

const idleState = {
	sessionStatus: "disconnected" as const,
	syncActive: false,
	syncControllerActive: false,
};

describe("explicit old plugin settings migration", () => {
	it("copies only old data with a verified backup and retains device-only state", async () => {
		const oldData =
			'{"serverUrl":"https://old.example","coexistenceMode":true}';
		const { app, files, payload } = createMigrationApp({
			files: { [sourcePath]: oldData },
		});

		await migrateLegacyPluginSettings(app as never, idleState);

		expect(files.get(destinationPath)).toBe(oldData);
		expect(files.get(backupPath)).toBe(oldData);
		expect(files.get(sourcePath)).toBe(oldData);
		expect(payload.get(".ai-bridge/pending/operation-payload")).toBe(
			"unsynced-bytes",
		);
	});

	it("refuses migration while AI Bridge remains enabled", async () => {
		const oldData = '{"serverUrl":"https://old.example"}';
		const { app, files } = createMigrationApp({
			files: { [sourcePath]: oldData },
			enabledPlugins: ["ai-bridge"],
		});

		await expect(
			migrateLegacyPluginSettings(app as never, idleState),
		).rejects.toThrow(/Disable AI Bridge/);
		expect(files.has(destinationPath)).toBe(false);
	});

	it.each([
		[{ ...idleState, sessionStatus: "connected" as const }],
		[{ ...idleState, syncActive: true }],
		[{ ...idleState, syncControllerActive: true }],
	])(
		"refuses migration while Vaultwire is connected or active",
		async (state) => {
			const { app, files } = createMigrationApp({
				files: { [sourcePath]: '{"serverUrl":"https://old.example"}' },
			});

			await expect(
				migrateLegacyPluginSettings(app as never, state),
			).rejects.toThrow(/disconnected and idle/);
			expect(files.has(destinationPath)).toBe(false);
		},
	);

	it("refuses an existing Vaultwire data file without replacing it", async () => {
		const { app, files } = createMigrationApp({
			files: {
				[sourcePath]: '{"serverUrl":"https://old.example"}',
				[destinationPath]: '{"serverUrl":"https://new.example"}',
			},
		});

		await expect(
			migrateLegacyPluginSettings(app as never, idleState),
		).rejects.toThrow(/already exists/);
		expect(files.get(destinationPath)).toBe(
			'{"serverUrl":"https://new.example"}',
		);
	});
});
