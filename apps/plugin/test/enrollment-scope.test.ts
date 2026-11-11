import { describe, expect, it } from "vitest";
import {
	classifyEnrollmentPath,
	DEFAULT_SETTINGS_SYNC_POLICY,
	shouldTraverseSettingsDirectory,
} from "../src/sync/enrollment-scope";

describe("classifyEnrollmentPath", () => {
	it.each([
		...[
			"png",
			"jpg",
			"jpeg",
			"gif",
			"webp",
			"svg",
			"pdf",
			"mp3",
			"m4a",
			"wav",
			"mp4",
			"mov",
			"webm",
			"json",
			"csv",
			"txt",
		].map((extension) => [`notes/file.${extension}`, 24, "blob"] as const),
		["note.md", 24, "text"],
		["canvas.CANVAS", 24, "text"],
		["notes/photo.PNG", 24, "blob"],
		["notes/data.json", 24, "blob"],
		["notes/large.md", 1_000_001, "blob"],
		[".obsidian/plugins/x.md", 24, "excluded"],
		[".trash/old.md", 24, "excluded"],
		[".vaultwire/pending/x", 24, "excluded"],
		[".TRASH/private.md", 24, "excluded"],
		[".VAULTWIRE/private.md", 24, "excluded"],
		["notes/.vaultwire/note.md", 24, "text"],
		[".OBSIDIAN/app.json", 4, "excluded"],
		[".ObSiDiAn/app.json", 4, "excluded"],
		["notes/.DS_Store", 24, "excluded"],
		["notes/photo.icloud", 24, "excluded"],
		["notes/binary.exe", 24, "excluded"],
		["notes/too-large.png", 25_000_001, "unsupported"],
		["notes/too-large.exe", 25_000_001, "excluded"],
		[".obsidian/huge.png", 25_000_001, "excluded"],
		["notes/too-large.md", 25_000_001, "unsupported"],
		["notes/maximum.png", 25_000_000, "blob"],
		["notes/oversized.txt", 25_000_001, "unsupported"],
		["note.md", 1_000_000, "text"],
		["note.md", 1_000_001, "blob"],
		["../outside.md", 24, "excluded"],
	] as const)("classifies %s", (path, size, expected) => {
		expect(classifyEnrollmentPath(path, size)).toBe(expected);
	});
});

describe("settings category enrollment", () => {
	it("keeps selected settings excluded while the master switch is off", () => {
		expect(
			classifyEnrollmentPath(".obsidian/appearance.json", 12, {
				...DEFAULT_SETTINGS_SYNC_POLICY,
				appearance: true,
			}),
		).toBe("excluded");
	});

	it.each([
		[".obsidian/appearance.json", "appearance"],
		[".obsidian/themes/Minimal/theme.css", "appearance"],
		[".obsidian/snippets/custom.css", "appearance"],
		[".obsidian/app.json", "core"],
		[".obsidian/core-plugins.json", "core"],
		[".obsidian/hotkeys.json", "core"],
		[".obsidian/types.json", "core"],
		[".obsidian/community-plugins.json", "communityPlugins"],
		[".obsidian/plugins/tasks/manifest.json", "communityPlugins"],
		[".obsidian/plugins/tasks/main.js", "communityPlugins"],
		[".obsidian/plugins/tasks/styles.css", "communityPlugins"],
		[".obsidian/plugins/tasks/data.json", "communityPlugins"],
		[".ObSiDiAn/appearance.json", "appearance"],
		[".OBSIDIAN/APP.JSON", "core"],
		[".ObSiDiAn/PLUGINS/Tasks/MAIN.JS", "communityPlugins"],
	] as const)(
		"admits %s only when its %s category is enabled",
		(path, category) => {
			const policy = {
				...DEFAULT_SETTINGS_SYNC_POLICY,
				enabled: true,
				[category]: true,
			};
			expect(classifyEnrollmentPath(path, 12, policy)).toBe("blob");
			expect(
				classifyEnrollmentPath(path, 12, {
					...policy,
					[category]: false,
				}),
			).toBe("excluded");
		},
	);

	it.each([
		".obsidian/themes/Example/.DS_Store",
		".obsidian/themes/Example/font.icloud",
		".OBSIDIAN/THEMES/Example/.DS_STORE",
		".OBSIDIAN/THEMES/Example/font.ICLOUD",
		".obsidian/plugins/VAULTWIRE/main.js",
		".obsidian/PLUGINS/VAULTWIRE/data.json",
		".obsidian/workspace.json",
		".obsidian/workspace-mobile.json",
		".obsidian/plugins/vaultwire/data.json",
		".obsidian/cache/cache.db",
		".obsidian/cache2/cache.db",
		".obsidian/graph.json",
		".obsidian/plugins/tasks/node_modules/pkg/main.js",
		".OBSIDIAN/WORKSPACE.json",
		".OBSIDIAN/PLUGINS/VAULTWIRE/main.js",
		".OBSIDIAN/CACHE/cache.db",
		".OBSIDIAN/GRAPH.JSON",
		".OBSIDIAN/PLUGINS/tasks/NODE_MODULES/pkg/main.js",
	] as const)("always excludes %s", (path) => {
		expect(
			classifyEnrollmentPath(path, 12, {
				...DEFAULT_SETTINGS_SYNC_POLICY,
				enabled: true,
				appearance: true,
				core: true,
				communityPlugins: true,
			}),
		).toBe("excluded");
	});

	it("traverses former plugin folders when settings sync is enabled", () => {
		const policy = {
			...DEFAULT_SETTINGS_SYNC_POLICY,
			enabled: true,
			appearance: true,
			core: true,
			communityPlugins: true,
		};
		expect(shouldTraverseSettingsDirectory(".obsidian/plugins", policy)).toBe(
			true,
		);
		expect(
			shouldTraverseSettingsDirectory(
				`.obsidian/plugins/${"ai-" + "bridge"}`,
				policy,
			),
		).toBe(true);
	});

	it("preserves exact JavaScript and CSS bytes within the blob limit", () => {
		const policy = {
			...DEFAULT_SETTINGS_SYNC_POLICY,
			enabled: true,
			communityPlugins: true,
		};
		expect(
			classifyEnrollmentPath(".obsidian/plugins/x/main.js", 25_000_000, policy),
		).toBe("blob");
		expect(
			classifyEnrollmentPath(".obsidian/plugins/x/main.js", 25_000_001, policy),
		).toBe("unsupported");
		expect(
			classifyEnrollmentPath(".OBSIDIAN/PLUGINS/X/MAIN.JS", 25_000_001, policy),
		).toBe("unsupported");
	});
});
