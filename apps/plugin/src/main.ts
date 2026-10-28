import { ObsidianDeviceStorage } from "@plugin/infrastructure/device-storage";
import {
	DEVICE_JOURNAL_ATTENTION_REASON,
	DeviceJournal,
} from "@plugin/sync/device-journal";
import { Plugin } from "obsidian";

/** Owns device-local journal admission without starting synchronization or note effects. */
export default class AIBridgePlugin extends Plugin {
	/** Active journal for this plugin lifecycle, or null when unavailable. */
	private journal: DeviceJournal | null = null;
	/** Fences asynchronous journal opens when unload or a newer load occurs. */
	private lifecycleGeneration = 0;
	/** Safe user-facing reason when local journal initialization cannot proceed. */
	attentionReason: string | null = null;

	/** Opens validated local state and discards stale completion after unload or reload. */
	async onload(): Promise<void> {
		const generation = ++this.lifecycleGeneration;
		try {
			const journal = await DeviceJournal.open(
				new ObsidianDeviceStorage(this.app),
			);
			if (generation !== this.lifecycleGeneration) {
				journal.close();
				return;
			}
			this.journal = journal;
		} catch {
			if (generation === this.lifecycleGeneration)
				this.attentionReason = DEVICE_JOURNAL_ATTENTION_REASON;
		}
	}

	/** Blocks journal actions immediately and preserves all local data. */
	onunload(): void {
		this.lifecycleGeneration += 1;
		this.journal?.close();
		this.journal = null;
	}
}
