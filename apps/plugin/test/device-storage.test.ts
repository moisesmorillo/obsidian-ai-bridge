import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ObsidianDeviceStorage } from "../src/infrastructure/device-storage";

const key = "018f47b2-5c00-7000-8000-000000000001";
const path = `.ai-bridge/pending/${key}`;

/** Models the vault adapter with missing folders, partial writes, and read-back faults. */
class AdapterMock {
	directories = new Set<string>();
	files = new Map<string, Uint8Array>();
	failWrite = false;
	mismatchReadBack = false;

	/** Reports whether this fake adapter contains a file or directory. */
	async exists(value: string): Promise<boolean> {
		return this.directories.has(value) || this.files.has(value);
	}
	/** Adds one directory level to the fake adapter. */
	async mkdir(value: string): Promise<void> {
		this.directories.add(value);
	}
	/** Reads file bytes and can corrupt the adapter's read-back result. */
	async readBinary(value: string): Promise<ArrayBuffer> {
		const bytes = this.files.get(value);
		if (!bytes) throw new Error("missing");
		const result = bytes.slice();
		if (this.mismatchReadBack) result[0] = 0;
		return result.buffer as ArrayBuffer;
	}
	/** Stores file bytes or simulates an adapter write failure. */
	async writeBinary(value: string, bytes: ArrayBuffer): Promise<void> {
		if (this.failWrite) throw new Error("partial write");
		this.files.set(value, new Uint8Array(bytes).slice());
	}
}

/** Builds a device adapter with observable localStorage calls. */
function createStorage(adapter = new AdapterMock()): {
	storage: ObsidianDeviceStorage;
	adapter: AdapterMock;
	calls: unknown[];
} {
	const calls: unknown[] = [];
	const app = {
		loadLocalStorage: (storageKey: string) => {
			calls.push(["load", storageKey]);
			return null;
		},
		saveLocalStorage: (storageKey: string, value: unknown) =>
			calls.push(["save", storageKey, value]),
		vault: { adapter },
	} as unknown as App;
	return { storage: new ObsidianDeviceStorage(app), adapter, calls };
}

const bytes = new Uint8Array([1, 2, 3]);

describe("ObsidianDeviceStorage", () => {
	it("creates missing excluded directories and verifies the binary payload", async () => {
		const { storage, adapter } = createStorage();
		await storage.writePayload(path, bytes);
		expect(adapter.directories).toEqual(
			new Set([".ai-bridge", ".ai-bridge/pending"]),
		);
		expect(await storage.readPayload(path)).toEqual(bytes);
	});

	it("does not replace an existing payload with different bytes", async () => {
		const { storage } = createStorage();
		await storage.writePayload(path, bytes);
		await expect(
			storage.writePayload(path, new Uint8Array([9])),
		).rejects.toThrow();
		expect(await storage.readPayload(path)).toEqual(bytes);
	});

	it("surfaces partial writes and read-back mismatches", async () => {
		const partial = createStorage();
		partial.adapter.failWrite = true;
		await expect(partial.storage.writePayload(path, bytes)).rejects.toThrow(
			"partial write",
		);
		const mismatch = createStorage();
		mismatch.adapter.mismatchReadBack = true;
		await expect(mismatch.storage.writePayload(path, bytes)).rejects.toThrow(
			"did not verify",
		);
	});

	it("rejects forged payload paths before adapter access", async () => {
		const { storage, adapter } = createStorage();
		await expect(
			storage.readPayload(".ai-bridge/pending/../../outside"),
		).rejects.toThrow("Invalid device payload path");
		expect(adapter.files.size).toBe(0);
	});
});
