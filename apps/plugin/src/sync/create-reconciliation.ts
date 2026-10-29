import type { DeviceSession } from "@plugin/auth/device-session";
import { SyncTransport } from "@plugin/infrastructure/sync-transport";
import { ObsidianTextVault } from "@plugin/infrastructure/text-vault";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { ReconciliationController } from "@plugin/sync/reconciliation";
import { TextApplyEngine } from "@plugin/sync/text-apply";
import type { Vault } from "obsidian";

/** Builds explicit reconciliation services without installing lifecycle triggers. */
export function createReconciliation(
	serviceOrigin: string,
	session: DeviceSession,
	journal: DeviceJournal,
	vault: Vault,
	deviceName: string,
): ReconciliationController {
	const remote = new SyncTransport(serviceOrigin, session);
	const textVault = new ObsidianTextVault(vault);
	const applyEngine = new TextApplyEngine(journal, textVault, remote, {
		deviceName,
	});
	return new ReconciliationController(journal, applyEngine, textVault, remote);
}
