import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/auth/device-session";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import { createPublication } from "../src/sync/create-publication";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import type { DeviceJournalStorage } from "../src/sync/device-journal";
import { DeviceJournal } from "../src/sync/device-journal";

const epoch = "a".repeat(32);
const remoteText = "remote body";
/** Holds a pinned file response so lifecycle fences can run at the exact network boundary. */
class DelayedSession {
	requests: string[] = [];
	fileResponse: ((response: OAuthTransportResponse) => void) | null = null;
	fileStarted: (() => void) | null = null;
	heldFileResponse = new Promise<OAuthTransportResponse>((resolve) => {
		this.fileResponse = resolve;
	});
	fileRequestStarted = new Promise<void>((resolve) => {
		this.fileStarted = resolve;
	});
	mutationStarted: (() => void) | null = null;
	resolveMutation: ((response: OAuthTransportResponse) => void) | null = null;
	heldMutation = new Promise<OAuthTransportResponse>((resolve) => {
		this.resolveMutation = resolve;
	});
	mutationRequestStarted = new Promise<void>((resolve) => {
		this.mutationStarted = resolve;
	});
	revokeChanges = false;
	changesStarted: (() => void) | null = null;
	resolveRevocation: ((response: OAuthTransportResponse) => void) | null = null;
	heldRevocation = new Promise<OAuthTransportResponse>((resolve) => {
		this.resolveRevocation = resolve;
	});
	changesRequestStarted = new Promise<void>((resolve) => {
		this.changesStarted = resolve;
	});

	/** Returns validated fake feed and pinned-file responses through the real transport adapter. */
	async requestResponse(path: string): Promise<OAuthTransportResponse> {
		this.requests.push(path);
		if (path.includes("/v1/changes")) {
			if (this.revokeChanges) {
				this.changesStarted?.();
				return this.heldRevocation;
			}
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					epoch,
					head_seq: 1,
					entries: [
						{
							seq: 1,
							op: "put",
							path: "notes/remote.md",
							etag: `"${epoch}.1"`,
							hash: await hashText(remoteText),
							origin: "other-device",
							at: 1,
						},
					],
				}),
			};
		}
		if (path.includes("/v1/files/notes/remote.md")) {
			this.fileStarted?.();
			return this.heldFileResponse;
		}
		if (path.includes("/v1/files/notes/local.md")) {
			this.mutationStarted?.();
			return this.heldMutation;
		}
		throw new Error(`Unexpected request: ${path}`);
	}
}

/** Stores verified device state and payloads for the real journal composition. */
class MemoryJournalStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Returns the untrusted persisted state for journal validation. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Stores the journal's verified full state document. */
	async writeState(
		state: import("@obsidian-ai-bridge/protocol").DeviceState,
	): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Reads one saved immutable payload by its exact reference. */
	async readPayload(path: string): Promise<Uint8Array> {
		return this.payloads.get(path)?.slice() ?? new Uint8Array();
	}
	/** Stores a defensive copy of one immutable payload. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Counts real Obsidian adapter file effects while keeping remote paths absent. */
function makeVault(): { vault: Vault; creates: string[] } {
	const creates: string[] = [];
	const vault = {
		getAbstractFileByPath: () => null,
		getFiles: () => [],
		createFolder: async () => ({ path: "folder" }),
		create: async (path: string) => {
			creates.push(path);
			return { path };
		},
		read: async () => "",
		readBinary: async () => new ArrayBuffer(0),
		createBinary: async () => undefined,
		modifyBinary: async () => undefined,
		modify: async () => undefined,
		process: async () => undefined,
		trash: async () => undefined,
		rename: async () => undefined,
		adapter: {
			stat: async () => null,
			list: async () => ({ files: [], folders: [] }),
			readBinary: async () => new ArrayBuffer(0),
			writeBinary: async () => undefined,
			remove: async () => undefined,
		},
	};
	return { vault: vault as unknown as Vault, creates };
}

/** Computes the canonical content hash used by the feed and pinned response fixtures. */
async function hashText(text: string): Promise<string> {
	return [
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Resolves the held pinned response with the exact canonical identity requested by reconciliation. */
async function releasePinnedResponse(session: DelayedSession): Promise<void> {
	const hash = await hashText(remoteText);
	session.fileResponse?.({
		status: 200,
		headers: { etag: `"${epoch}.1"`, "content-type": "application/json" },
		text: JSON.stringify({
			path: "notes/remote.md",
			etag: `"${epoch}.1"`,
			hash,
			size: new TextEncoder().encode(remoteText).byteLength,
			kind: "text",
			deleted: false,
			origin: "other-device",
			updated_at: 1,
			content: remoteText,
			offset: 0,
			length: remoteText.length,
			truncated: false,
		}),
	} as OAuthTransportResponse);
}

/** Builds the real journal, transport, apply, publication, and reconciliation composition. */
async function makeComposition(
	session: DelayedSession,
	vault: Vault,
	onRevoked: () => void = () => undefined,
) {
	const journal = await DeviceJournal.open(new MemoryJournalStorage());
	await journal.resetEpoch(epoch);
	await journal.setCursor(epoch, 0);
	const composition = createPublication(
		"https://service.test",
		session as unknown as DeviceSession,
		journal,
		vault,
		"test device",
		{ now: Date.now, onEventError: () => undefined, onRevoked },
	);
	return { journal, composition };
}

/** Makes one trigger host with actual controller serialization and no wall-clock timers. */
function makeController(cycle: () => Promise<void>, onStateChanged = vi.fn()) {
	return new DesktopSyncController({
		cycle,
		host: {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			setInterval: () => 2,
			clearInterval: () => undefined,
		},
		onStateChanged,
	});
}

describe("real publication composition lifecycle fences", () => {
	it.each(["pause", "unload", "server replacement"] as const)(
		"fences a delayed apply before any later vault write on %s",
		async (boundary) => {
			const session = new DelayedSession();
			const { vault, creates } = makeVault();
			const { journal, composition } = await makeComposition(session, vault);
			const controller = makeController(() =>
				composition.reconciliation.replay(),
			);
			const sync = controller.syncNow();
			await session.fileRequestStarted;

			if (boundary === "pause") controller.pause();
			else controller.close();
			composition.dispose();
			const replacementReady =
				boundary === "server replacement"
					? controller
							.waitForIdle()
							.then(() =>
								createPublication(
									"https://service.test",
									new DelayedSession() as unknown as DeviceSession,
									journal,
									vault,
									"replacement device",
									{ now: Date.now, onEventError: () => undefined },
								),
							)
					: Promise.resolve(null);

			await releasePinnedResponse(session);
			await expect(sync).rejects.toThrow();
			await controller.waitForIdle();
			const replacement = await replacementReady;
			if (boundary === "server replacement") {
				expect(replacement).not.toBeNull();
				replacement?.dispose();
			}
			expect(session.requests).toHaveLength(2);
			expect(creates).toEqual([]);
			expect(journal.snapshot().cursor).toBe(0);
			journal.close();
		},
	);

	it("keeps an immutable queued publication when a delayed receipt returns after pause", async () => {
		const session = new DelayedSession();
		const { vault, creates } = makeVault();
		const { journal, composition } = await makeComposition(session, vault);
		const payload = new TextEncoder().encode("local payload");
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/local.md", precondition: { kind: "absent" } },
			payload,
		);
		await journal.prepareSend(operation.key, operation.precondition);
		const controller = makeController(() => composition.publication.flush());
		const flushing = controller.syncNow();
		await session.mutationRequestStarted;
		controller.pause();
		composition.dispose();
		const hash = await hashText("local payload");
		session.resolveMutation?.({
			status: 201,
			headers: {},
			text: JSON.stringify({
				path: "notes/local.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash,
				size: payload.byteLength,
				deleted: false,
			}),
		} as OAuthTransportResponse);
		await expect(flushing).rejects.toThrow();
		await controller.waitForIdle();
		expect(session.requests).toHaveLength(1);
		expect(journal.snapshot().pending_ops).toMatchObject([
			{ key: operation.key, state: "sent", payload_hash: hash },
		]);
		await expect(
			journal.readPayload(operation.payload_ref, hash),
		).resolves.toEqual(payload);
		expect(creates).toEqual([]);
		journal.close();
	});

	it("keeps the sent operation and payload when publication confirms revocation", async () => {
		const session = new DelayedSession();
		const { vault } = makeVault();
		const journal = await DeviceJournal.open(new MemoryJournalStorage());
		await journal.resetEpoch(epoch);
		const payload = new TextEncoder().encode("queued payload");
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/local.md", precondition: { kind: "absent" } },
			payload,
		);
		await journal.prepareSend(operation.key, operation.precondition);
		let composition!: ReturnType<typeof createPublication>;
		let controller!: DesktopSyncController;
		composition = createPublication(
			"https://service.test",
			session as unknown as DeviceSession,
			journal,
			vault,
			"test device",
			{
				now: Date.now,
				onEventError: () => undefined,
				onRevoked: () => {
					controller.close();
					composition.dispose();
				},
			},
		);
		controller = makeController(() => composition.publication.flush());
		const flushing = controller.syncNow();
		await session.mutationRequestStarted;
		session.resolveMutation?.({
			status: 401,
			headers: {},
			text: JSON.stringify({
				error: "revoked",
				message: "The grant no longer allows access.",
			}),
		} as OAuthTransportResponse);
		await expect(flushing).rejects.toThrow();
		await controller.waitForIdle();
		expect(session.requests).toHaveLength(1);
		expect(journal.snapshot().pending_ops).toMatchObject([
			{
				key: operation.key,
				state: "sent",
				payload_hash: await hashText("queued payload"),
			},
		]);
		await expect(
			journal.readPayload(operation.payload_ref, operation.payload_hash),
		).resolves.toEqual(payload);
		journal.close();
	});

	it("fences feed effects when the real transport confirms revocation", async () => {
		const session = new DelayedSession();
		session.revokeChanges = true;
		const { vault, creates } = makeVault();
		let controller!: DesktopSyncController;
		const { journal, composition } = await makeComposition(
			session,
			vault,
			() => {
				controller.close();
				composition.dispose();
			},
		);
		controller = makeController(() => composition.reconciliation.replay());

		const cycle = controller.syncNow();
		await session.changesRequestStarted;
		session.resolveRevocation?.({
			status: 401,
			headers: {},
			text: JSON.stringify({
				error: "revoked",
				message: "The grant no longer allows access.",
			}),
		} as OAuthTransportResponse);
		await expect(cycle).rejects.toMatchObject({
			status: 401,
			code: "revoked",
		});
		await controller.waitForIdle();
		expect(session.requests).toHaveLength(1);
		expect(creates).toEqual([]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		journal.close();
	});
});
