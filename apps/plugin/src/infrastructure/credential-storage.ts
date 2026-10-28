import {
	type DeviceCredential,
	DeviceCredentialSchema,
} from "@obsidian-ai-bridge/protocol";
import type { App } from "obsidian";

/** Credential persistence capability with a safe UI warning for localStorage fallback. */
export interface CredentialWriteTransaction {
	/** Reads the current validated record while the writer owns admission. */
	read(): Promise<DeviceCredential | null>;
	/** Writes and verifies a record without reacquiring the shared writer queue. */
	write(credential: DeviceCredential): Promise<void>;
	/** Clears and verifies the record without reacquiring the shared writer queue. */
	clear(): Promise<void>;
}

/** Serializes credential commits shared by every session built from one device store. */
export interface CredentialStorage {
	/** Safe warning shown when the record uses unencrypted localStorage fallback. */
	readonly warning: string | null;
	/** Reads and validates a complete credential record or returns null when absent. */
	read(): Promise<DeviceCredential | null>;
	/** Writes the complete record and blocks authorization if read-back differs. */
	write(credential: DeviceCredential): Promise<void>;
	/** Removes credentials and verifies absence during failed first enrollment rollback. */
	clear(): Promise<void>;
	/** Holds shared write admission until credential and journal identity updates settle. */
	runWriteTransaction<T>(
		action: (transaction: CredentialWriteTransaction) => Promise<T>,
	): Promise<T>;
}

/** Stores one validated credential record in device secret storage or local-only fallback. */
export class ObsidianCredentialStorage implements CredentialStorage {
	readonly warning: string | null;
	private readonly secretId: string;
	private readonly localKey: string;
	/** Shared admission queue for all sessions using this device-keyed store. */
	private writeTail: Promise<void> = Promise.resolve();

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

	/** Writes and reads back one record through the shared device-store queue. */
	async write(credential: DeviceCredential): Promise<void> {
		return this.runWriteTransaction(async (transaction) =>
			transaction.write(credential),
		);
	}

	/** Clears one device record through the shared device-store queue. */
	async clear(): Promise<void> {
		return this.runWriteTransaction(async (transaction) => transaction.clear());
	}

	/** Holds shared write admission until credential and journal identity updates settle. */
	async runWriteTransaction<T>(
		action: (transaction: CredentialWriteTransaction) => Promise<T>,
	): Promise<T> {
		const result = this.writeTail.then(async () => {
			let active = true;
			/** Rejects transaction callbacks that escaped the serialized write lifetime. */
			const assertActive = () => {
				if (!active)
					throw new Error("Credential write transaction is no longer active");
			};
			try {
				return await action({
					read: async () => {
						assertActive();
						return this.read();
					},
					write: async (credential) => {
						assertActive();
						return this.writeUnlocked(credential);
					},
					clear: async () => {
						assertActive();
						return this.clearUnlocked();
					},
				});
			} finally {
				active = false;
			}
		});
		this.writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Writes and verifies one credential without acquiring the shared queue again. */
	private async writeUnlocked(credential: DeviceCredential): Promise<void> {
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

	/** Clears and verifies one record without acquiring the shared queue again. */
	private async clearUnlocked(): Promise<void> {
		if (this.app.secretStorage) {
			this.app.secretStorage.setSecret(this.secretId, "null");
		} else {
			this.app.saveLocalStorage(this.localKey, null);
		}
		if ((await this.read()) !== null)
			throw new Error("Credential storage clear did not verify");
	}
}
