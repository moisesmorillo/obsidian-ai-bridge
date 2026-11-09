import { readFile, writeFile } from "node:fs/promises";

/** Adds the exact current manifest compatibility to the release map without changing prior entries. */
export async function syncCompatibilityVersion(
	manifestPath: string,
	versionsPath: string,
): Promise<void> {
	const [manifestText, versionsText] = await Promise.all([
		readFile(manifestPath, "utf8"),
		readFile(versionsPath, "utf8"),
	]);
	const manifest: unknown = JSON.parse(manifestText);
	const versions: unknown = JSON.parse(versionsText);
	if (!isObject(manifest)) throw new Error("Manifest must be a JSON object");
	if (manifest.id !== "vaultwire")
		throw new Error("Manifest id must be vaultwire");
	const version = exactVersion(manifest.version, "Manifest version");
	const minimum = exactVersion(
		manifest.minAppVersion,
		"Manifest minAppVersion",
	);
	if (!isObject(versions))
		throw new Error("Compatibility map must be a JSON object");
	for (const [key, value] of Object.entries(versions)) {
		exactVersion(key, "Compatibility map version");
		exactVersion(value, `Compatibility map entry ${key}`);
	}
	const existingMinimum = versions[version];
	if (existingMinimum !== undefined && existingMinimum !== minimum) {
		throw new Error(
			`Compatibility map entry ${version} conflicts with manifest minAppVersion`,
		);
	}
	if (existingMinimum === minimum) return;
	versions[version] = minimum;
	await writeFile(versionsPath, `${JSON.stringify(versions, null, "\t")}\n`);
}

/** Confirms a plain JSON object before release metadata reads or writes. */
function isObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** Validates exact numeric three-part versions for the plugin compatibility map. */
function exactVersion(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
	) {
		throw new Error(
			`${label} must use exact numeric semver (major.minor.patch)`,
		);
	}
	return value;
}

if (process.argv[1] === import.meta.filename) {
	const [manifestPath, versionsPath] = process.argv.slice(2);
	if (!manifestPath || !versionsPath || process.argv.length !== 4) {
		throw new Error(
			"Usage: bun apps/plugin/tools/release-versions.ts <manifest.json> <versions.json>",
		);
	}
	syncCompatibilityVersion(manifestPath, versionsPath).catch(
		(error: unknown) => {
			console.error(
				error instanceof Error
					? error.message
					: "Compatibility map update failed",
			);
			process.exitCode = 1;
		},
	);
}
