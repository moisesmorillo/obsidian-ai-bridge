import type { DeviceSessionStatus } from "@plugin/auth/device-session";
import type { App } from "obsidian";

/** Activation file used to prove that the old plugin stays disabled. */
const ACTIVATION_PATH = ".obsidian/community-plugins.json";
/** Source settings file read only by the explicit user migration action. */
const OLD_SETTINGS_PATH = ".obsidian/plugins/ai-bridge/data.json";
/** Destination settings file; existing data is never overwritten. */
const NEW_SETTINGS_PATH = ".obsidian/plugins/vaultwire/data.json";
/** Dedicated sibling directory that retains the old settings bytes. */
const BACKUP_DIRECTORY = ".obsidian/plugins/ai-bridge-vaultwire-backup";
/** Backup file verified before the destination settings write. */
const BACKUP_SETTINGS_PATH = `${BACKUP_DIRECTORY}/data.json`;
/** Temporary sibling file renamed only after its bytes match the source. */
const STAGED_SETTINGS_PATH =
	".obsidian/plugins/vaultwire/.data.json.migration-stage";

/** Shows a one-time migration command only when old settings exist without a target file. */
export async function hasLegacyPluginSettingsToMigrate(
	app: App,
): Promise<boolean> {
	return (
		(await app.vault.adapter.exists(OLD_SETTINGS_PATH)) &&
		!(await app.vault.adapter.exists(NEW_SETTINGS_PATH))
	);
}

/** Safe settings copied from the old plugin folder after backup verification. */
export interface LegacyPluginMigrationResult {
	/** The retained backup path inside the vault's plugin directory. */
	backupPath: string;
	/** Exact parsed JSON object copied to the Vaultwire plugin folder. */
	settings: Record<string, unknown>;
}

/** Runtime state that must remain idle before the one-time settings copy. */
export interface LegacyPluginMigrationState {
	/** Current credential session; migration accepts only disconnected state. */
	sessionStatus: DeviceSessionStatus;
	/** True while a synchronization cycle can read or write vault state. */
	syncActive: boolean;
	/** True while the synchronization controller owns timers or event admission. */
	syncControllerActive: boolean;
}

/** Copies old shared settings once, only while both plugin and sync state are safe. */
export async function migrateLegacyPluginSettings(
	app: App,
	state: LegacyPluginMigrationState,
): Promise<LegacyPluginMigrationResult> {
	const adapter = app.vault.adapter;
	let enabledPlugins: unknown;
	try {
		enabledPlugins = JSON.parse(await adapter.read(ACTIVATION_PATH));
	} catch {
		throw new Error("Plugin activation state could not be verified");
	}
	if (
		!Array.isArray(enabledPlugins) ||
		!enabledPlugins.every((id) => typeof id === "string")
	)
		throw new Error("Plugin activation state could not be verified");
	if (enabledPlugins.includes("ai-bridge"))
		throw new Error("Disable AI Bridge before migrating its settings");
	if (
		state.sessionStatus !== "disconnected" ||
		state.syncActive ||
		state.syncControllerActive
	)
		throw new Error("Vaultwire must be disconnected and idle before migration");
	if (!(await adapter.exists(OLD_SETTINGS_PATH)))
		throw new Error("Old AI Bridge data.json was not found");
	if (await adapter.exists(NEW_SETTINGS_PATH))
		throw new Error("Vaultwire data.json already exists");
	const oldData = await adapter.read(OLD_SETTINGS_PATH);
	const parsed: unknown = JSON.parse(oldData);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error("Old AI Bridge data.json must contain a settings object");
	const backupDirectoryExists = await adapter.exists(BACKUP_DIRECTORY);
	if (backupDirectoryExists) {
		if (!(await adapter.exists(BACKUP_SETTINGS_PATH)))
			throw new Error("Migration backup is incomplete and needs inspection");
		if ((await adapter.read(BACKUP_SETTINGS_PATH)) !== oldData)
			throw new Error("Migration backup does not match the old settings");
	} else {
		await adapter.mkdir(BACKUP_DIRECTORY);
		try {
			await adapter.write(BACKUP_SETTINGS_PATH, oldData);
			if ((await adapter.read(BACKUP_SETTINGS_PATH)) !== oldData)
				throw new Error("Migration backup did not verify");
		} catch (error) {
			if (await adapter.exists(BACKUP_SETTINGS_PATH))
				await adapter.remove(BACKUP_SETTINGS_PATH);
			await adapter.rmdir(BACKUP_DIRECTORY, false);
			throw error;
		}
	}
	if (await adapter.exists(STAGED_SETTINGS_PATH))
		throw new Error("A staged Vaultwire settings file needs inspection");
	try {
		await adapter.write(STAGED_SETTINGS_PATH, oldData);
		if ((await adapter.read(STAGED_SETTINGS_PATH)) !== oldData)
			throw new Error("Staged Vaultwire settings did not verify");
		if (await adapter.exists(NEW_SETTINGS_PATH))
			throw new Error("Vaultwire data.json appeared during migration");
		await adapter.rename(STAGED_SETTINGS_PATH, NEW_SETTINGS_PATH);
	} catch (error) {
		if (await adapter.exists(STAGED_SETTINGS_PATH))
			await adapter.remove(STAGED_SETTINGS_PATH);
		throw error;
	}
	return {
		backupPath: BACKUP_SETTINGS_PATH,
		settings: parsed as Record<string, unknown>,
	};
}
