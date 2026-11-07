import {
	classifyFilePath,
	PathSchema,
	pathKey,
} from "@obsidian-ai-bridge/protocol";

/** Per-device opt-in switches for the three supported Obsidian settings categories. */
export interface SettingsSyncPolicy {
	/** Master gate; category switches have no effect while false. */
	enabled: boolean;
	/** Includes appearance.json, themes, and snippets. */
	appearance: boolean;
	/** Includes the four core settings files. */
	core: boolean;
	/** Includes plugin manifests, code, styles, and data. */
	communityPlugins: boolean;
}

/** Safe persisted defaults. Devices must opt in before any settings path is admitted. */
export const DEFAULT_SETTINGS_SYNC_POLICY: SettingsSyncPolicy = {
	enabled: false,
	appearance: true,
	core: true,
	communityPlugins: true,
};

/** Server-matched raw-byte ceiling for inline Markdown and Canvas enrollment. */
const INLINE_TEXT_LIMIT_BYTES = 1_000_000;
/** Maximum raw file size accepted by the blob protocol. */
const BLOB_LIMIT_BYTES = 25_000_000;
/** Spec §7.8 attachment extensions admitted as blobs but not decoded as text. */
const ATTACHMENT_EXTENSIONS = new Set([
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
]);

/** Classifies one local vault path for enrollment; size is the raw byte count. */
export function classifyEnrollmentPath(
	path: string,
	size: number,
	settingsPolicy: SettingsSyncPolicy = DEFAULT_SETTINGS_SYNC_POLICY,
): "text" | "blob" | "excluded" | "unsupported" {
	if (
		!PathSchema.safeParse(path).success ||
		!Number.isSafeInteger(size) ||
		size < 0
	)
		return "excluded";
	const segments = path.split("/");
	if (
		[".trash", ".ai-bridge"].includes(segments[0] ?? "") ||
		segments.at(-1) === ".DS_Store" ||
		segments.at(-1)?.toLowerCase().endsWith(".icloud")
	)
		return "excluded";
	if (segments[0] === ".obsidian") {
		if (isHardExcludedSettingsPath(pathKey(path).split("/"))) return "excluded";
		const category = settingsCategory(segments);
		if (!settingsPolicy.enabled || !category || !settingsPolicy[category])
			return "excluded";
		return size > BLOB_LIMIT_BYTES ? "unsupported" : "blob";
	}
	const kind = classifyFilePath(path);
	if (kind === "markdown" || kind === "canvas") {
		if (size > BLOB_LIMIT_BYTES) return "unsupported";
		return size <= INLINE_TEXT_LIMIT_BYTES ? "text" : "blob";
	}
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (!ATTACHMENT_EXTENSIONS.has(extension)) return "excluded";
	return size > BLOB_LIMIT_BYTES ? "unsupported" : "blob";
}

/** Returns the enabled category for one exact supported settings path shape. */
function settingsCategory(
	segments: string[],
): keyof Omit<SettingsSyncPolicy, "enabled"> | null {
	const relative = segments.slice(1);
	if (
		relative.length === 1 &&
		[
			"appearance.json",
			"app.json",
			"core-plugins.json",
			"hotkeys.json",
			"types.json",
			"community-plugins.json",
		].includes(relative[0] ?? "")
	)
		return relative[0] === "appearance.json"
			? "appearance"
			: relative[0] === "community-plugins.json"
				? "communityPlugins"
				: "core";
	if (relative[0] === "themes" || relative[0] === "snippets")
		return relative.length > 1 ? "appearance" : null;
	if (
		relative[0] === "plugins" &&
		relative.length === 3 &&
		["manifest.json", "main.js", "styles.css", "data.json"].includes(
			relative[2] ?? "",
		)
	)
		return "communityPlugins";
	return null;
}

/** Keeps workspace, AI Bridge, cache, graph, and dependency trees outside all categories. */
function isHardExcludedSettingsPath(segments: string[]): boolean {
	const relative = segments.slice(1);
	const first = relative[0] ?? "";
	return (
		/^workspace.*\.json$/i.test(first) ||
		first === "graph.json" ||
		first.startsWith("cache") ||
		(relative[0] === "plugins" && relative[1] === "ai-bridge") ||
		relative.includes("node_modules")
	);
}

/** Admits only directories that can contain selected settings. Identity checks retain valid case collisions. */
export function shouldTraverseSettingsDirectory(
	path: string,
	policy: SettingsSyncPolicy,
): boolean {
	if (!policy.enabled || !PathSchema.safeParse(path).success) return false;
	const segments = pathKey(path).split("/");
	if (segments[0] !== ".obsidian" || isHardExcludedSettingsPath(segments))
		return false;
	if (segments.length === 1) return true;
	if (segments[1] === "themes" || segments[1] === "snippets")
		return policy.appearance;
	return (
		policy.communityPlugins && segments[1] === "plugins" && segments.length <= 3
	);
}

/** Adds a text suffix when a visible settings recovery path has no supported content extension. */
export function settingsConflictExtension(extension: string): string {
	return classifyEnrollmentPath(`recovery${extension}`, 0) === "excluded"
		? `${extension}.txt`
		: extension;
}
