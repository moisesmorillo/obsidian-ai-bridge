import type { VaultReadResult } from "@obsidian-ai-bridge/protocol";
import type { DeviceSession } from "@plugin/auth/device-session";
import { SyncTransport } from "@plugin/infrastructure/sync-transport";
import { ObsidianTextVault } from "@plugin/infrastructure/text-vault";
import { VaultEventAdapter } from "@plugin/infrastructure/vault-events";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { PublicationController } from "@plugin/sync/publication";
import { ReconciliationController } from "@plugin/sync/reconciliation";
import type { DeleteResponseDiagnostic } from "@plugin/sync/remote-text";
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
	/** Fires only for a validated 401 revoked response before controller effects resume. */
	onRevoked?(): void;
	/** Blocks new publication and local apply effects during owner confirmation. */
	isEffectBlocked?(): boolean;
	/** Presents the path of each newly created and verified conflict copy. */
	onConflictCopy?(path: string): void;
	/** Captures safe DELETE response classes, or clears stale metadata before a retry. */
	onDeleteResponseDiagnostic?(
		diagnostic: DeleteResponseDiagnostic | null,
	): void;
}

/** Shared text synchronization services and their caller-owned disposal boundary. */
export interface PublicationComposition {
	publication: PublicationController;
	reconciliation: ReconciliationController;
	/** Reads one canonical vault summary for enrollment and capacity status. */
	readVaultSummary(): Promise<VaultReadResult>;
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
	const remote = new SyncTransport(
		serviceOrigin,
		session,
		options.onRevoked,
		options.onDeleteResponseDiagnostic,
	);
	const textVault = new ObsidianTextVault(vault);
	const applyEngine = new TextApplyEngine(journal, textVault, remote, {
		deviceName,
		isEffectBlocked: options.isEffectBlocked,
		onConflictCopy: options.onConflictCopy,
	});
	const reconciliation = new ReconciliationController(
		journal,
		applyEngine,
		textVault,
		remote,
		options.isEffectBlocked,
	);
	const publication = new PublicationController(journal, textVault, remote, {
		applyEngine,
		now: options.now,
		recoverPrecondition: (operation) =>
			reconciliation.recoverPrecondition(operation),
		onDeleteResponseDiagnostic: options.onDeleteResponseDiagnostic,
		isEffectBlocked: options.isEffectBlocked,
	});
	const events = options.registerEvents
		? new VaultEventAdapter(vault, publication, options.onEventError)
		: null;
	let disposed = false;
	return {
		publication,
		reconciliation,
		readVaultSummary: () => remote.vault(),
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
