import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { ObsidianCredentialStorage } from "../src/infrastructure/credential-storage";

const credential = {
	service_origin: "https://service.test",
	client_id: "client-a",
	access_token: "synthetic-access",
	refresh_token: "synthetic-refresh",
	token_type: "Bearer" as const,
	expires_at: 1_800_000_000_000,
	scope: [
		"vault:read" as const,
		"vault:write" as const,
		"vault:delete" as const,
	],
};

/** Creates a host facade that records device-local writes without exposing plugin data. */
function createApp(secretStorage?: {
	/** Reads one synthetic secret value by device key. */
	getSecret(id: string): string | null;
	/** Stores one synthetic secret value by device key. */
	setSecret(id: string, value: string): void;
}) {
	const values = new Map<string, unknown>();
	const app = {
		secretStorage,
		/** Reads one synthetic localStorage value. */
		loadLocalStorage: (key: string) => values.get(key),
		/** Saves one synthetic localStorage value. */
		saveLocalStorage: (key: string, value: unknown) => values.set(key, value),
	} as unknown as App;
	return { app, values };
}

describe("ObsidianCredentialStorage", () => {
	it("uses distinct secretStorage keys for separate devices", async () => {
		const secrets = new Map<string, string>();
		const host = createApp({
			/** Reads a secret by its device-scoped key. */
			getSecret: (id) => secrets.get(id) ?? null,
			/** Stores a secret by its device-scoped key. */
			setSecret: (id, value) => secrets.set(id, value),
		});
		const first = new ObsidianCredentialStorage(
			host.app,
			"018f47b2-5c00-7000-8000-000000000001",
		);
		const second = new ObsidianCredentialStorage(
			host.app,
			"018f47b2-5c00-7000-8000-000000000002",
		);
		await first.write(credential);
		expect(await first.read()).toEqual(credential);
		await first.clear();
		expect(await first.read()).toBeNull();
		expect(await second.read()).toBeNull();
		expect(first.warning).toBeNull();
	});

	it("uses localStorage only when secretStorage is absent and reports the warning", async () => {
		const host = createApp();
		const store = new ObsidianCredentialStorage(
			host.app,
			"018f47b2-5c00-7000-8000-000000000001",
		);
		await store.write(credential);
		expect(await store.read()).toEqual(credential);
		expect(store.warning).toBe("tokens stored unencrypted on this device");
		expect(host.values.size).toBe(1);
	});

	it("serializes credential transactions shared by multiple sessions", async () => {
		const host = createApp();
		const store = new ObsidianCredentialStorage(
			host.app,
			"018f47b2-5c00-7000-8000-000000000001",
		);
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const first = store.runWriteTransaction(async (transaction) => {
			await transaction.write(credential);
			markFirstStarted?.();
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
		});
		await firstStarted;
		let secondStarted = false;
		const second = store.runWriteTransaction(async (transaction) => {
			secondStarted = true;
			await transaction.write({
				...credential,
				access_token: "next-access",
			});
		});
		await Promise.resolve();
		expect(secondStarted).toBe(false);
		releaseFirst?.();
		await Promise.all([first, second]);
		expect((await store.read())?.access_token).toBe("next-access");
	});

	it("does not fall back after secretStorage write errors", async () => {
		const host = createApp({
			getSecret: () => null,
			setSecret: () => {
				throw new Error("synthetic storage failure");
			},
		});
		const store = new ObsidianCredentialStorage(
			host.app,
			"018f47b2-5c00-7000-8000-000000000001",
		);
		await expect(store.write(credential)).rejects.toThrow();
		expect(host.values.size).toBe(0);
	});
});
