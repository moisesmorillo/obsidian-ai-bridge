import {
	type DeviceCredential,
	DeviceCredentialSchema,
} from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";

/** Credential persistence capability with a safe UI warning for localStorage fallback. */
export interface CredentialStorage {
	/** Safe warning shown when the record uses unencrypted localStorage fallback. */
	readonly warning: string | null;
	/** Reads and validates a complete credential record or returns null when absent. */
	read(): Promise<DeviceCredential | null>;
	/** Writes the complete record and blocks authorization if read-back differs. */
	write(credential: DeviceCredential): Promise<void>;
	/** Removes credentials and verifies absence during failed first enrollment rollback. */
	clear(): Promise<void>;
}

/** Stores one validated credential record in device secret storage or local-only fallback. */
export class ObsidianCredentialStorage implements CredentialStorage {
	readonly warning: string | null;
	private readonly secretId: string;
	private readonly localKey: string;

	/** Selects one stable per-device key and never changes stores after a write error. */
	constructor(
		private readonly app: App,
		deviceId: string,
	) {
		const canonicalDeviceId = deviceId.toLowerCase();
		this.secretId = `oab-credential-${canonicalDeviceId}`;
		this.localKey = `obsidian-ai-bridge:credential:${canonicalDeviceId}`;
		this.warning = app.secretStorage
			? null
			: "tokens stored unencrypted on this device";
	}

	/** Reads and validates the complete record without repairing invalid local data. */
	async read(): Promise<DeviceCredential | null> {
		const raw = this.app.secretStorage
			? this.app.secretStorage.getSecret(this.secretId)
			: this.app.loadLocalStorage(this.localKey);
		if (raw === null || raw === undefined) return null;
		const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
		return decoded === null ? null : DeviceCredentialSchema.parse(decoded);
	}

	/** Writes and reads back one credential record; failures never trigger another store. */
	async write(credential: DeviceCredential): Promise<void> {
		const validated = DeviceCredentialSchema.parse(credential);
		const serialized = JSON.stringify(validated);
		if (this.app.secretStorage) {
			this.app.secretStorage.setSecret(this.secretId, serialized);
		} else {
			this.app.saveLocalStorage(this.localKey, serialized);
		}
		const stored = await this.read();
		if (JSON.stringify(stored) !== serialized)
			throw new Error("Credential storage did not verify");
	}

	/** Clears one device record and verifies absence without switching storage backends. */
	async clear(): Promise<void> {
		if (this.app.secretStorage) {
			this.app.secretStorage.setSecret(this.secretId, "null");
		} else {
			this.app.saveLocalStorage(this.localKey, null);
		}
		if ((await this.read()) !== null)
			throw new Error("Credential storage clear did not verify");
	}
}
