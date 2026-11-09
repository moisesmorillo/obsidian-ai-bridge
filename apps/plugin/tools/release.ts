import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Accepts exact three-part numeric versions without leading zeroes. */
const exactVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parses an exact supported semantic version or reports invalid metadata. */
function requireExactVersion(value: unknown, label: string): string {
	if (typeof value !== "string" || !exactVersionPattern.test(value)) {
		throw new Error(
			`${label} must use exact numeric semver (major.minor.patch)`,
		);
	}
	return value;
}

/**
 * Validates a Vaultwire tag, the plugin manifest, and the compatibility map.
 * The return value is the exact input tag.
 */
export function validatePluginRelease(
	tag: string,
	manifest: unknown,
	versions: unknown,
): string {
	const tagMatch =
		/^vaultwire-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
	if (!tagMatch)
		throw new Error("Tag must match vaultwire-v<major>.<minor>.<patch>");

	const metadata = objectValue(manifest, "Plugin manifest");
	const version = requireExactVersion(metadata.version, "Manifest version");
	const minimumAppVersion = requireExactVersion(
		metadata.minAppVersion,
		"Manifest minAppVersion",
	);
	if (metadata.isDesktopOnly !== false) {
		throw new Error(
			"Manifest isDesktopOnly must remain false for the mobile release",
		);
	}
	if (tagMatch[1] !== version) {
		throw new Error("Tag version must match the plugin manifest version");
	}

	const compatibility = objectValue(versions, "Compatibility map");
	for (const [mappedVersion, mappedMinimum] of Object.entries(compatibility)) {
		requireExactVersion(mappedVersion, "Compatibility map version");
		requireExactVersion(
			mappedMinimum,
			`Compatibility map entry ${mappedVersion}`,
		);
	}
	if (compatibility[version] !== minimumAppVersion) {
		throw new Error(
			"Compatibility map entry must match manifest minAppVersion",
		);
	}
	return tag;
}

/** Narrows parsed JSON to a plain object before release fields are read. */
function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error(`${label} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

/** Reads release metadata from the current repository and validates one tag. */
async function validateRepositoryRelease(tag: string): Promise<string> {
	const pluginDirectory = resolve("apps/plugin");
	const [manifestText, versionsText] = await Promise.all([
		readFile(resolve(pluginDirectory, "manifest.json"), "utf8"),
		readFile(resolve(pluginDirectory, "versions.json"), "utf8"),
	]);
	return validatePluginRelease(
		tag,
		JSON.parse(manifestText) as unknown,
		JSON.parse(versionsText) as unknown,
	);
}

/** Runs CLI validation and returns a nonzero process status for any invalid input. */
async function runReleaseValidator(): Promise<void> {
	const tag = process.argv[2];
	if (!tag || process.argv.length !== 3) {
		throw new Error(
			"Usage: bun apps/plugin/tools/release.ts <vaultwire-v<version>>",
		);
	}
	console.log(await validateRepositoryRelease(tag));
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(import.meta.filename)
) {
	runReleaseValidator().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "Release validation failed",
		);
		process.exitCode = 1;
	});
}
