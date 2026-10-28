import {
	DEVICE_PAYLOAD_DIRECTORY,
	DevicePayloadReferenceSchema,
	type DeviceState,
	DeviceStateSchema,
} from "@obsidian-ai-bridge/protocol";
import type { DeviceJournalStorage } from "@plugin/sync/device-journal";
import type { App } from "obsidian";

/** Stable localStorage key for the single device-only journal document. */
const LOCAL_STORAGE_KEY = "obsidian-ai-bridge:device-state:v1";

/** Adapts one localStorage document and confined payload files to the journal port. */
export class ObsidianDeviceStorage implements DeviceJournalStorage {
	constructor(private readonly app: App) {}

	/** Reads the one localStorage document without repairing invalid persisted values. */
	async readState(): Promise<unknown> {
		return this.app.loadLocalStorage(LOCAL_STORAGE_KEY);
	}

	/** Replaces the complete localStorage document; the journal verifies read-back. */
	async writeState(state: DeviceState): Promise<void> {
		this.app.saveLocalStorage(
			LOCAL_STORAGE_KEY,
			DeviceStateSchema.parse(state),
		);
	}

	/** Reads only payload files whose reference matches the journal UUIDv7 layout. */
	async readPayload(path: string): Promise<Uint8Array> {
		const filePath = DevicePayloadReferenceSchema.parse(path);
		return new Uint8Array(await this.app.vault.adapter.readBinary(filePath));
	}

	/** Creates the excluded payload directory and never replaces different existing bytes. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		const filePath = DevicePayloadReferenceSchema.parse(path);
		const directory = DEVICE_PAYLOAD_DIRECTORY.slice(0, -1);
		const rootDirectory = directory.slice(0, directory.indexOf("/"));
		if (!(await this.app.vault.adapter.exists(directory))) {
			if (!(await this.app.vault.adapter.exists(rootDirectory)))
				await this.app.vault.adapter.mkdir(rootDirectory);
			if (!(await this.app.vault.adapter.exists(directory)))
				await this.app.vault.adapter.mkdir(directory);
		}
		if (await this.app.vault.adapter.exists(filePath)) {
			const existing = new Uint8Array(
				await this.app.vault.adapter.readBinary(filePath),
			);
			if (!sameBytes(existing, bytes))
				throw new Error("Payload path already contains different bytes");
			return;
		}
		const data = bytes.slice().buffer as ArrayBuffer;
		await this.app.vault.adapter.writeBinary(filePath, data);
		const written = new Uint8Array(
			await this.app.vault.adapter.readBinary(filePath),
		);
		if (!sameBytes(written, bytes))
			throw new Error("Payload write did not verify");
	}
}

/** Compares full bytes without relying on mutable input array identity. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return (
		left.byteLength === right.byteLength &&
		left.every((value, index) => value === right[index])
	);
}
