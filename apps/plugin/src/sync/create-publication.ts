import type { DeviceSession } from "@plugin/auth/device-session";
import { SyncTransport } from "@plugin/infrastructure/sync-transport";
import { ObsidianTextVault } from "@plugin/infrastructure/text-vault";
import { VaultEventAdapter } from "@plugin/infrastructure/vault-events";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { PublicationController } from "@plugin/sync/publication";
import { ReconciliationController } from "@plugin/sync/reconciliation";
import { TextApplyEngine } from "@plugin/sync/text-apply";
import type { Vault } from "obsidian";

/** Explicit startup and event registration choices for text publication composition. */
export interface CreatePublicationOptions {
	/** Deterministic clock used to calculate persisted retry deadlines. */
	now(): number;
	/** Registers live vault events only when the caller explicitly sets this flag. */
	registerEvents?: boolean;
	/** Receives event callback failures so the lifecycle owner can report attention. */
	onEventError(error: unknown): void;
}

/** Shared text synchronization services and their caller-owned disposal boundary. */
export interface PublicationComposition {
	publication: PublicationController;
	reconciliation: ReconciliationController;
	/** Fences publication, disposes optional event listeners, and closes the shared apply engine. */
	dispose(): void;
}

/** Composes publication and reconciliation around one journal, vault adapter, and apply engine. */
export function createPublication(
	serviceOrigin: string,
	session: DeviceSession,
	journal: DeviceJournal,
	vault: Vault,
	deviceName: string,
	options: CreatePublicationOptions,
): PublicationComposition {
	const remote = new SyncTransport(serviceOrigin, session);
	const textVault = new ObsidianTextVault(vault);
	const applyEngine = new TextApplyEngine(journal, textVault, remote, {
		deviceName,
	});
	const reconciliation = new ReconciliationController(
		journal,
		applyEngine,
		textVault,
		remote,
	);
	const publication = new PublicationController(journal, textVault, remote, {
		now: options.now,
		recoverPrecondition: () => reconciliation.replay(),
	});
	const events = options.registerEvents
		? new VaultEventAdapter(vault, publication, options.onEventError)
		: null;
	let disposed = false;
	return {
		publication,
		reconciliation,
		/** Fences all shared effects and releases optional host event listeners. */
		dispose() {
			if (disposed) return;
			disposed = true;
			events?.dispose();
			publication.close();
			reconciliation.close();
		},
	};
}
