import type { PendingOperation } from "@obsidian-ai-bridge/protocol";
import type { CoexistenceEffectFence } from "@plugin/sync/coexistence-effect-fence";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import type { PublicationEvent } from "@plugin/sync/publication";

/** Metadata-only capability for finding an iCloud placeholder at a source path. */
export interface CoexistenceVault {
	/** Returns true when an adapter stat finds either supported placeholder form. */
	isUnavailable(path: string): Promise<boolean>;
	/** Returns current metadata size for an available exact path, or null when absent. */
	size(path: string): Promise<number | null>;
}

/** Owns durable owner decisions and unavailable-path metadata for coexistence mode. */
export class CoexistenceController {
	/** Binds durable authority to current mode without owning plugin lifecycle. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: CoexistenceVault,
		private readonly isEnabled: () => boolean,
		private readonly now: () => number = Date.now,
		/** Closes shared effect admission until captured intent reaches durable state. */
		private readonly effectFence?: CoexistenceEffectFence,
	) {}

	/** Captures destructive intent before debounce and tracks placeholder transitions. */
	async observe(event: PublicationEvent): Promise<boolean> {
		if (!this.isEnabled()) return false;
		const destructive =
			(event.type === "delete" || event.type === "rename") &&
			classifyEnrollmentPath(event.path, 0) !== "excluded";
		const releaseCapture = destructive
			? this.effectFence?.beginCapture()
			: undefined;
		let persisted = false;
		try {
			const placeholder = placeholderSource(
				event.type === "rename" ? event.to : event.path,
			);
			const placeholderDetected =
				placeholder !== null && (await this.vault.isUnavailable(placeholder));
			if (placeholderDetected && placeholder)
				await this.journal.markUnavailable(placeholder);
			else if (
				placeholder &&
				this.journal.snapshot().unavailable_paths.includes(placeholder)
			)
				await this.journal.clearUnavailable(placeholder);
			if (event.type === "delete" || event.type === "rename") {
				if (!destructive) return false;
				await this.journal.captureCoexistenceEvent(event, this.now());
				persisted = true;
				if (await this.vault.isUnavailable(event.path))
					await this.journal.markUnavailable(event.path);
				return true;
			}
			if (placeholderDetected) return true;
			if (
				this.journal.snapshot().unavailable_paths.includes(event.path) &&
				!(await this.vault.isUnavailable(event.path))
			)
				await this.journal.clearUnavailable(event.path);
			return false;
		} finally {
			releaseCapture?.(persisted);
		}
	}

	/** Transfers only an unchanged observed source into durable outgoing work. */
	async confirm(id: string): Promise<PendingOperation | null> {
		const item = this.journal
			.snapshot()
			.coexistence_confirmations.find((candidate) => candidate.id === id);
		if (!item) return null;
		const unavailable = await this.vault.isUnavailable(item.path);
		const sourceExists = (await this.vault.size(item.path)) !== null;
		if (unavailable) {
			await this.journal.markUnavailable(item.path);
			await this.journal.markCoexistenceStale(
				id,
				"The source path is unavailable while iCloud holds a placeholder.",
			);
			return null;
		}
		if (sourceExists) {
			await this.journal.markCoexistenceStale(
				id,
				"The source path exists again. Keep server state or review it.",
			);
			return null;
		}
		if (item.kind === "rename") {
			if (classifyEnrollmentPath(item.to, 0) === "excluded") {
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is excluded from synchronization.",
				);
				return null;
			}
			if (await this.vault.isUnavailable(item.to)) {
				await this.journal.markUnavailable(item.to);
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is unavailable while iCloud holds a placeholder.",
				);
				return null;
			}
			if ((await this.vault.size(item.to)) === null) {
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is no longer available.",
				);
				return null;
			}
		}
		return this.journal.confirmCoexistence(id);
	}

	/** Removes one decision while leaving remote state and placeholder protection unchanged. */
	keepServerState(id: string): Promise<void> {
		return this.journal.clearCoexistenceConfirmation(id);
	}
}

/** Maps a placeholder's visible name to the original source path without reading bytes. */
function placeholderSource(path: string): string | null {
	if (!path.endsWith(".icloud")) return null;
	const nameStart = path.lastIndexOf("/") + 1;
	const name = path.slice(nameStart, -".icloud".length);
	const sourceName = name.startsWith(".") ? name.slice(1) : name;
	if (!sourceName) return null;
	return `${path.slice(0, nameStart)}${sourceName}`;
}
