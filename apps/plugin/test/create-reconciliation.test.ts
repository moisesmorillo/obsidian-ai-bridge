import type { ManifestPage } from "@obsidian-ai-bridge/protocol";
import { TFile, type Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import type { DeviceSession } from "../src/auth/device-session";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import type { SyncResponseSession } from "../src/infrastructure/sync-transport";
import { createReconciliation } from "../src/sync/create-reconciliation";
import {
	DeviceJournal,
	type DeviceJournalStorage,
} from "../src/sync/device-journal";

const epoch = "a".repeat(32);
const text = "composition read";

/** Stores the real journal JSON and immutable payload bytes for composition tests. */
class MemoryStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Reads the last committed device state. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Stores a cloned journal state. */
	async writeState(state: unknown): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Reads an exact immutable payload path. */
	async readPayload(path: string): Promise<Uint8Array> {
		return this.payloads.get(path)?.slice() ?? new Uint8Array();
	}
	/** Stores a defensive payload copy. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Sends Worker-shaped JSON responses to the real production SyncTransport. */
class WorkerSession {
	calls: string[] = [];
	readonly manifest: ManifestPage;
	readonly body: string;
	/** Builds canonical manifest and text-read bodies. */
	constructor(hash: string) {
		this.manifest = {
			epoch,
			head_seq: 4,
			entries: [
				{
					path: "remote.md",
					etag: `"${epoch}.2"`,
					seq: 2,
					hash,
					size: new TextEncoder().encode(text).byteLength,
					kind: "text",
					deleted: false,
					large: false,
				},
			],
			next_page: null,
		};
		this.body = JSON.stringify({
			path: "remote.md",
			etag: `"${epoch}.2"`,
			hash,
			size: new TextEncoder().encode(text).byteLength,
			kind: "text",
			deleted: false,
			origin: "device",
			updated_at: 1,
			content: text,
			offset: 0,
			length: text.length,
			truncated: false,
		});
	}
	/** Returns a protocol response for the requested production endpoint. */
	async requestResponse(path: string): Promise<OAuthTransportResponse> {
		const requestPath = new URL(path).pathname + new URL(path).search;
		this.calls.push(requestPath);
		if (requestPath.startsWith("/v1/manifest"))
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				text: JSON.stringify(this.manifest),
			};
		if (requestPath.includes("/v1/files/remote.md"))
			return {
				status: 200,
				headers: {
					"content-type": "application/json",
					etag: `"${epoch}.2"`,
				},
				text: this.body,
			};
		throw new Error(`Unexpected path ${path}`);
	}
}

/** Runs production reconciliation composition against a guarded fake Obsidian vault. */
async function runComposition(
	session: SyncResponseSession,
	localFiles: Record<string, string> = {},
) {
	const files: TFile[] = Object.entries(localFiles).map(([path, value]) =>
		Object.assign(new TFile(), {
			path,
			stat: { size: new TextEncoder().encode(value).byteLength },
		}),
	);
	const content = new Map(Object.entries(localFiles));
	const host = {
		getFiles: () => files,
		getAbstractFileByPath: (path: string) =>
			files.find((file) => file.path === path) ?? null,
		read: async (file: TFile) => content.get(file.path) ?? "",
		process: async (file: TFile, callback: (value: string) => string) => {
			content.set(file.path, callback(content.get(file.path) ?? ""));
		},
		create: async (path: string, value: string) => {
			const file = Object.assign(new TFile(), {
				path,
				stat: { size: new TextEncoder().encode(value).byteLength },
			});
			files.push(file);
			content.set(path, value);
			return file;
		},
		trash: async () => undefined,
		rename: async () => undefined,
		createFolder: async () => undefined,
	};
	const journal = await DeviceJournal.open(new MemoryStorage());
	const controller = createReconciliation(
		"https://service.test",
		session as unknown as DeviceSession,
		journal,
		host as unknown as Vault,
		"test device",
	);
	await controller.enroll();
	return { content, session, journal };
}

describe("createReconciliation", () => {
	it("uses the production SyncTransport and Worker JSON read contract", async () => {
		const hash = [
			...new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
			),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const session = new WorkerSession(hash);
		const result = await runComposition(session);
		expect(result.content.get("remote.md")).toBe(text);
		expect(session.calls).toEqual([
			"/v1/manifest",
			`/v1/files/remote.md?rev=2`,
		]);
		expect(result.journal.snapshot().cursor).toBe(4);
	});

	it("continues enrollment after a canonical path_collision response", async () => {
		const calls: string[] = [];
		const session = {
			/** Returns canonical responses for manifest and create requests. */
			async requestResponse(path: string): Promise<OAuthTransportResponse> {
				const url = new URL(path);
				const route = url.pathname + url.search;
				calls.push(route);
				if (route === "/v1/manifest")
					return {
						status: 200,
						headers: { "content-type": "application/json" },
						text: JSON.stringify({
							epoch,
							head_seq: 4,
							entries: [],
							next_page: null,
						}),
					};
				if (route === "/v1/files/notes/a.md")
					return {
						status: 409,
						headers: { "content-type": "application/json" },
						text: JSON.stringify({
							error: "path_collision",
							message: "Another file uses this path key.",
							existing_path: "notes/A.md",
						}),
					};
				if (route === "/v1/files/notes/b.md")
					return {
						status: 201,
						headers: { etag: `"${epoch}.5"` },
						text: "",
					};
				throw new Error(`Unexpected path ${path}`);
			},
		};
		const result = await runComposition(session, {
			"notes/a.md": "first local note",
			"notes/b.md": "second local note",
		});

		expect(calls).toEqual([
			"/v1/manifest",
			"/v1/files/notes/a.md",
			"/v1/files/notes/b.md",
		]);
		expect(result.journal.snapshot().pending_ops).toEqual([]);
		expect(result.journal.snapshot().attention).toContainEqual({
			path: "notes/A.md",
			reason: "Enrollment create rejected (path_collision) for notes/a.md",
		});
		expect(result.journal.snapshot().cursor).toBe(4);
	});
});
