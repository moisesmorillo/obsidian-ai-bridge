import type { DeviceState } from "@vaultwire/protocol";
import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/auth/device-session";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import VaultwirePlugin from "../src/main";
import type { DesktopSyncController } from "../src/sync/desktop-sync";
import type { DeviceJournalStorage } from "../src/sync/device-journal";
import { DeviceJournal } from "../src/sync/device-journal";

const epoch = "c".repeat(32);
const localPath = "notes/fresh.md";
const localText = "fresh local content";

/** Stores validated local journal state for one plugin startup test. */
class MemoryJournalStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();

	/** Returns the persisted state document for journal validation. */
	async readState(): Promise<unknown> {
		return this.state;
	}

	/** Stores a defensive copy of validated journal state. */
	async writeState(state: DeviceState): Promise<void> {
		this.state = structuredClone(state);
	}

	/** Reads a defensive copy of an immutable operation payload. */
	async readPayload(path: string): Promise<Uint8Array> {
		return this.payloads.get(path)?.slice() ?? new Uint8Array();
	}

	/** Stores a defensive copy of an immutable operation payload. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Provides one indexed text file and the host methods used by the real plugin composition. */
function makeVault(): Vault {
	const content = new Map([[localPath, localText]]);
	const files = new Map<string, TFile>();
	const folders = new Set<string>(["notes"]);
	/** Returns a stable host file object for one current local path. */
	const fileAt = (path: string): TFile | null => {
		if (!content.has(path)) return null;
		let file = files.get(path);
		if (!file) {
			file = Object.assign(new TFile(), {
				path,
				stat: {
					size: new TextEncoder().encode(content.get(path) ?? "").length,
				},
			});
			files.set(path, file);
		}
		return file;
	};
	return {
		/** Finds a host file or folder without inventing absent files. */
		getAbstractFileByPath(path: string) {
			return fileAt(path) ?? (folders.has(path) ? ({ path } as never) : null);
		},
		/** Lists only indexed local files for startup enrollment. */
		getFiles() {
			return [...content.keys()].flatMap((path) => {
				const file = fileAt(path);
				return file ? [file] : [];
			});
		},
		on: () => ({}) as never,
		offref: () => undefined,
		read: async (file: TFile) => content.get(file.path) ?? "",
		readBinary: async (file: TFile) =>
			new TextEncoder().encode(content.get(file.path) ?? "").buffer,
		create: async (path: string, text: string) => {
			content.set(path, text);
			return fileAt(path) as TFile;
		},
		createFolder: async (path: string) => {
			folders.add(path);
			return { path } as never;
		},
		modify: async (file: TFile, text: string) => {
			content.set(file.path, text);
		},
		modifyBinary: async (file: TFile, bytes: ArrayBuffer) => {
			content.set(file.path, new TextDecoder().decode(bytes));
		},
		process: async () => undefined,
		trash: async () => undefined,
		rename: async () => undefined,
		adapter: {
			stat: async (path: string) =>
				content.has(path)
					? {
							type: "file",
							mtime: 0,
							size: new TextEncoder().encode(content.get(path) ?? "").length,
						}
					: folders.has(path)
						? { type: "folder", mtime: 0, size: 0 }
						: null,
			list: async () => ({ files: [], folders: [] }),
			readBinary: async () => new ArrayBuffer(0),
			writeBinary: async () => undefined,
			remove: async () => undefined,
		},
	} as unknown as Vault;
}

/** Returns realistic summary, manifest, enrollment receipt, and feed responses. */
class EnrollmentSession {
	requests: string[] = [];
	closed = false;
	vaultReadCount = 0;
	vaultFailure: {
		status: number;
		body: unknown;
		headers?: Record<string, string>;
	} | null = null;

	/** Supplies only the validated responses needed by the real startup cycle. */
	async requestResponse(
		url: string,
		options?: { method?: string },
	): Promise<OAuthTransportResponse> {
		const path = new URL(url).pathname;
		this.requests.push(`${options?.method ?? "GET"} ${path}`);
		if (path === "/v1/vault") {
			if (this.vaultFailure) {
				const failure = this.vaultFailure;
				this.vaultFailure = null;
				return response(failure.body, failure.status, failure.headers);
			}
			return response({
				epoch,
				head_seq: 0,
				counts: {
					live: this.vaultReadCount++ === 0 ? 0 : 1,
					deleted: 0,
				},
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				capacity: {
					database_bytes: 0,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: 0,
					referenced_blob_bytes: 0,
				},
				attention: [],
			});
		}
		if (path === "/v1/manifest")
			return response({ epoch, head_seq: 0, entries: [], next_page: null });
		if (path === `/v1/files/${localPath}` && options?.method === "PUT") {
			const hash = await hashText(localText);
			return response(
				{
					path: localPath,
					etag: `"${epoch}.1"`,
					seq: 1,
					hash,
					size: new TextEncoder().encode(localText).byteLength,
					deleted: false,
				},
				201,
				{ etag: `"${epoch}.1"` },
			);
		}
		if (path === "/v1/changes")
			return response({
				epoch,
				head_seq: 1,
				entries: [
					{
						seq: 1,
						op: "put",
						path: localPath,
						etag: `"${epoch}.1"`,
						hash: await hashText(localText),
						origin: "startup-device",
						at: 1,
					},
				],
			});
		throw new Error(`Unexpected startup request: ${path}`);
	}

	/** Marks the fake host session closed during plugin unload. */
	close(): void {
		this.closed = true;
	}
}

/** Builds a response envelope with optional exact HTTP status and headers. */
function response(
	body: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
): OAuthTransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
		text: JSON.stringify(body),
	};
}

/** Computes the canonical lowercase SHA-256 content hash. */
async function hashText(text: string): Promise<string> {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("plugin startup enrollment", () => {
	it("propagates a safe 429 failure through the real cycle and retains times after recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
		vi.stubGlobal("window", {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			setInterval: () => 2,
			clearInterval: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		vi.stubGlobal("document", {
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		const plugin = new VaultwirePlugin({} as never, {} as never);
		const session = new EnrollmentSession();
		session.vaultFailure = {
			status: 429,
			headers: { "retry-after": "30" },
			body: {
				error: "admission_limited",
				message: "The vault cannot accept another operation now.",
			},
		};
		const journal = await DeviceJournal.open(new MemoryJournalStorage());
		Reflect.set(plugin, "app", { vault: makeVault() });
		Reflect.set(plugin, "journal", journal);
		Reflect.set(plugin, "session", session as unknown as DeviceSession);
		Reflect.set(plugin, "sessionStatus", "connected");
		Reflect.apply(Reflect.get(plugin, "startSync") as () => void, plugin, []);
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		await controller.waitForIdle();

		/** Reads bounded cycle diagnostics from the real plugin status owner. */
		const projectStatus = () =>
			Reflect.apply(
				Reflect.get(plugin, "syncStatus") as () => never,
				plugin,
				[],
			) as {
				failure: {
					transportClass: string;
					code: string;
					retryAfterSeconds: string;
				} | null;
				lastFailureAt: string | null;
				lastSuccessAt: string | null;
			};
		expect(projectStatus()).toMatchObject({
			failure: {
				transportClass: "4xx",
				code: "admission_limited",
				retryAfterSeconds: "30",
			},
			lastFailureAt: "2026-11-09T12:00:00.000Z",
		});

		vi.setSystemTime(new Date("2026-11-09T12:01:00.000Z"));
		await controller.syncNow();
		expect(projectStatus()).toMatchObject({
			failure: null,
			lastFailureAt: "2026-11-09T12:00:00.000Z",
			lastSuccessAt: "2026-11-09T12:01:00.000Z",
		});

		plugin.onunload();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("establishes a fresh journal epoch before it admits local publication", async () => {
		vi.stubGlobal("window", {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			setInterval: () => 2,
			clearInterval: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		vi.stubGlobal("document", {
			visibilityState: "visible",
			hasFocus: () => true,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		const plugin = new VaultwirePlugin({} as never, {} as never);
		const session = new EnrollmentSession();
		const journal = await DeviceJournal.open(new MemoryJournalStorage());
		Reflect.set(plugin, "app", { vault: makeVault() });
		Reflect.set(plugin, "journal", journal);
		Reflect.set(plugin, "session", session as unknown as DeviceSession);
		Reflect.set(plugin, "sessionStatus", "connected");
		Reflect.apply(Reflect.get(plugin, "startSync") as () => void, plugin, []);

		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		await controller.waitForIdle();

		expect(journal.snapshot().epoch).toBe(epoch);
		expect(journal.snapshot().base[localPath]).toEqual({
			deleted: false,
			rev: 1,
			hash: await hashText(localText),
		});
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(
			journal
				.snapshot()
				.attention.some((item: { reason: string }) =>
					item.reason.includes("old vault epoch"),
				),
		).toBe(false);
		expect(session.requests).toContain("GET /v1/manifest");
		expect(session.requests).toContain("PUT /v1/files/notes/fresh.md");
		expect(session.requests).toContain("GET /v1/changes");
		const status = Reflect.apply(
			Reflect.get(plugin, "syncStatus") as () => {
				counts: { live: number } | null;
			},
			plugin,
			[],
		);
		expect(status?.counts?.live).toBe(1);
		expect(session.vaultReadCount).toBe(2);

		plugin.onunload();
		vi.unstubAllGlobals();
	});
});
