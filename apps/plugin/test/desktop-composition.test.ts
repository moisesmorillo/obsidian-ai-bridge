import type { DeviceState } from "@vaultwire/protocol";
import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/auth/device-session";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import { createPublication } from "../src/sync/create-publication";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import type { DeviceJournalStorage } from "../src/sync/device-journal";
import { DeviceJournal } from "../src/sync/device-journal";
import type { PublicationEvent } from "../src/sync/publication";

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
	async writeState(state: DeviceState): Promise<void> {
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

/** Serves a confirmed tombstone and records publication of one visible local copy. */
class Ac04DeleteSession {
	/** Stores safe synthetic publication paths and text for the test assertions. */
	readonly published: Array<{ path: string; text: string }> = [];

	/** Returns the fixed delete feed, its manifest row, or a validated put receipt. */
	async requestResponse(
		url: string,
		options: {
			method?: string;
			body?: string | ArrayBuffer;
			headers?: Record<string, string>;
		} = {},
	): Promise<OAuthTransportResponse> {
		const parsed = new URL(url);
		if (parsed.pathname === "/v1/changes") {
			const since = Number(parsed.searchParams.get("since"));
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					epoch,
					head_seq: 1,
					entries:
						since < 1
							? [
									{
										seq: 1,
										op: "delete",
										path: "notes/shared.md",
										etag: `"${epoch}.2"`,
										hash: "",
										origin: "other-device",
										at: 1,
									},
								]
							: [],
				}),
			};
		}
		if (parsed.pathname === "/v1/manifest") {
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({
					epoch,
					head_seq: 1,
					next_page: null,
					entries: [
						{
							path: "notes/shared.md",
							etag: `"${epoch}.2"`,
							seq: 1,
							hash: "",
							size: 0,
							kind: "text",
							deleted: true,
							large: false,
						},
					],
				}),
			};
		}
		if (parsed.pathname.startsWith("/v1/files/") && options.method === "PUT") {
			const path = parsed.pathname
				.slice("/v1/files/".length)
				.split("/")
				.map(decodeURIComponent)
				.join("/");
			const text = typeof options.body === "string" ? options.body : "";
			this.published.push({ path, text });
			const etag = `"${epoch}.1"`;
			return {
				status: 201,
				headers: { etag },
				text: JSON.stringify({
					path,
					etag,
					seq: 2,
					size: new TextEncoder().encode(text).byteLength,
					hash: await hashText(text),
					deleted: false,
				}),
			};
		}
		throw new Error("Unexpected synthetic service request");
	}
}

/** Creates a real text adapter host with current file objects and byte counts. */
function makeTextVault(initialFiles: Record<string, string> = {}) {
	const contents = new Map(Object.entries(initialFiles));
	const files = new Map<string, TFile>();
	const folders = new Map<string, { path: string }>();
	/** Returns one stable TFile for the current indexed text at a path. */
	const fileAt = (path: string): TFile | null => {
		const text = contents.get(path);
		if (text === undefined) return null;
		let file = files.get(path);
		if (!file) {
			file = Object.assign(new TFile(), {
				path,
				stat: { size: new TextEncoder().encode(text).byteLength },
			}) as TFile;
			files.set(path, file);
		} else {
			Object.assign(file, {
				stat: { size: new TextEncoder().encode(text).byteLength },
			});
		}
		return file;
	};
	const vault = {
		getAbstractFileByPath: (path: string) =>
			fileAt(path) ?? folders.get(path) ?? null,
		getFiles: () =>
			[...contents.keys()].flatMap((path) => {
				const file = fileAt(path);
				return file ? [file] : [];
			}),
		createFolder: async (path: string) => {
			const folder = { path };
			folders.set(path, folder);
			return folder;
		},
		create: async (path: string, text: string) => {
			if (contents.has(path)) throw new Error("Synthetic path already exists");
			contents.set(path, text);
			return fileAt(path);
		},
		read: async (file: TFile) => contents.get(file.path) ?? "",
		readBinary: async (file: TFile) =>
			new TextEncoder().encode(contents.get(file.path) ?? "").buffer,
		modifyBinary: async (file: TFile, bytes: ArrayBuffer) => {
			contents.set(file.path, new TextDecoder().decode(bytes));
		},
		modify: async (file: TFile, text: string) => {
			contents.set(file.path, text);
		},
		process: async (file: TFile, update: (text: string) => string) => {
			contents.set(file.path, update(contents.get(file.path) ?? ""));
		},
		trash: async (file: TFile) => {
			contents.delete(file.path);
			files.delete(file.path);
		},
		rename: async (file: TFile, path: string) => {
			const text = contents.get(file.path);
			if (text === undefined) return;
			contents.delete(file.path);
			files.delete(file.path);
			contents.set(path, text);
			Object.assign(file, { path });
			files.set(path, file);
		},
		adapter: {
			stat: async () => null,
			list: async () => ({ files: [], folders: [] }),
			readBinary: async () => new ArrayBuffer(0),
			writeBinary: async () => undefined,
			remove: async () => undefined,
		},
	};
	return { vault: vault as unknown as Vault, contents };
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

	it("recovers a pending apply before replay and retries the same sent request identity", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const recoveryText = "recovered remote bytes";
		const recoveryHash = await hashText(recoveryText);
		const payload = new TextEncoder().encode("immutable sent bytes");
		const payloadHash = await hashText(new TextDecoder().decode(payload));
		const storage = new MemoryJournalStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		await journal.setCursor(epoch, 0);
		await journal.beginApply(
			{
				seq: 1,
				op: "put",
				path: "notes/recovery.md",
				etag: `"${epoch}.1"`,
				hash: recoveryHash,
				origin: "other-device",
				at: 1,
			},
			"text",
		);
		const operation = await journal.enqueue(
			{ op: "put", path: "notes/sent.md", precondition: { kind: "absent" } },
			payload,
		);
		await journal.prepareSend(operation.key, operation.precondition);
		const errors: unknown[] = [];
		const requests: Array<{
			path: string;
			method: string;
			body: string | ArrayBuffer | undefined;
			headers: Record<string, string> | undefined;
		}> = [];
		let publicationAttempts = 0;
		const session = {
			/** Returns pending-apply, feed, and mutation responses while recording request identity. */
			async requestResponse(
				url: string,
				options: {
					method?: string;
					body?: string | ArrayBuffer;
					headers?: Record<string, string>;
				} = {},
			): Promise<OAuthTransportResponse> {
				const parsed = new URL(url);
				requests.push({
					path: parsed.pathname,
					method: options.method ?? "GET",
					body: options.body,
					headers: options.headers,
				});
				if (parsed.pathname === "/v1/changes")
					return {
						status: 200,
						headers: {},
						text: JSON.stringify({ epoch, head_seq: 0, entries: [] }),
					};
				if (parsed.pathname === "/v1/files/notes/recovery.md")
					return {
						status: 200,
						headers: { etag: `"${epoch}.1"` },
						text: JSON.stringify({
							path: "notes/recovery.md",
							etag: `"${epoch}.1"`,
							hash: recoveryHash,
							size: new TextEncoder().encode(recoveryText).byteLength,
							kind: "text",
							deleted: false,
							origin: "other-device",
							updated_at: 1,
							content: recoveryText,
							offset: 0,
							length: recoveryText.length,
							truncated: false,
						}),
					};
				if (parsed.pathname === "/v1/files/notes/sent.md") {
					publicationAttempts += 1;
					if (publicationAttempts === 1)
						return {
							status: 503,
							headers: {},
							text: JSON.stringify({ error: "temporarily_unavailable" }),
						};
					return {
						status: 201,
						headers: { etag: `"${epoch}.2"` },
						text: JSON.stringify({
							path: "notes/sent.md",
							etag: `"${epoch}.2"`,
							seq: 2,
							hash: payloadHash,
							size: payload.byteLength,
							deleted: false,
						}),
					};
				}
				throw new Error(`Unexpected recovery request: ${parsed.pathname}`);
			},
		};
		const { vault, contents } = makeTextVault();
		const composition = createPublication(
			"https://service.test",
			session as unknown as DeviceSession,
			journal,
			vault,
			"test device",
			{ now: Date.now, onEventError: () => undefined },
		);
		const controller = new DesktopSyncController({
			cycle: async () => {
				await composition.reconciliation.resume();
				await composition.publication.scan();
				await composition.publication.flush();
				await composition.reconciliation.replay();
			},
			onError: (error) => errors.push(error),
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});

		await controller.start();
		const sentAfterFailure = journal.snapshot().pending_ops[0];
		if (!sentAfterFailure?.retry_at)
			throw new Error("Expected a persisted sent-operation retry deadline");
		clock.mockReturnValue(sentAfterFailure.retry_at);
		await controller.syncNow();

		const recoveryRead = requests.findIndex(
			(request) => request.path === "/v1/files/notes/recovery.md",
		);
		const firstSent = requests.findIndex(
			(request) => request.path === "/v1/files/notes/sent.md",
		);
		const secondSent = requests.findIndex(
			(request, index) =>
				index > firstSent && request.path === "/v1/files/notes/sent.md",
		);
		expect(recoveryRead).toBeGreaterThanOrEqual(0);
		expect(recoveryRead).toBeLessThan(firstSent);
		expect(secondSent).toBeGreaterThan(firstSent);
		expect(requests[secondSent]).toEqual(requests[firstSent]);
		expect(contents.get("notes/recovery.md")).toBe(recoveryText);
		expect(journal.snapshot().pending_apply).toEqual([]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(errors).toEqual([]);

		controller.close();
		composition.dispose();
		journal.close();
		clock.mockRestore();
	});

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

	it.each([
		{
			name: "drops the obsolete queued edit after a confirmed delete preserves its bytes",
			removeSourceAfterEvent: false,
			keepsMissingPayloadInAttention: false,
		},
		{
			name: "keeps attention when a confirmed delete leaves no visible payload copy",
			removeSourceAfterEvent: true,
			keepsMissingPayloadInAttention: true,
		},
	])(
		"$name",
		async ({ removeSourceAfterEvent, keepsMissingPayloadInAttention }) => {
			const sourcePath = "notes/shared.md";
			const baseText = "confirmed base bytes";
			const offlineText = "queued offline edit";
			const offlineBytes = new TextEncoder().encode(offlineText);
			const session = new Ac04DeleteSession();
			const { vault, contents } = makeTextVault({ [sourcePath]: offlineText });
			const journal = await DeviceJournal.open(new MemoryJournalStorage());
			await journal.resetEpoch(epoch);
			await journal.setCursor(epoch, 0);
			await journal.setBase(sourcePath, {
				deleted: false,
				rev: 1,
				hash: await hashText(baseText),
			});
			const composition = createPublication(
				"https://service.test",
				session as unknown as DeviceSession,
				journal,
				vault,
				"test device",
				{ now: Date.now, onEventError: () => undefined },
			);
			const controller = new DesktopSyncController({
				cycle: async () => {
					await composition.reconciliation.resume();
					await composition.publication.scan();
					await composition.publication.flush();
					await composition.reconciliation.replay();
				},
				onEvent: async (event: PublicationEvent) => {
					await composition.publication.observe(event);
					if (removeSourceAfterEvent) {
						const source = vault.getAbstractFileByPath(sourcePath);
						if (source instanceof TFile) await vault.trash(source, false);
					}
				},
				host: {
					setTimeout: () => 1,
					clearTimeout: () => undefined,
					setInterval: () => 2,
					clearInterval: () => undefined,
				},
			});

			try {
				await controller.observe({ type: "modify", path: sourcePath });
				await controller.syncNow();

				const state = journal.snapshot();
				const visibleCopies = [...contents].filter(
					([path, text]) => path !== sourcePath && text === offlineText,
				);
				expect(contents.has(sourcePath)).toBe(false);
				expect(state.base[sourcePath]).toEqual({ deleted: true, rev: 2 });
				if (keepsMissingPayloadInAttention) {
					expect(state.pending_ops.length).toBe(0);
					expect(visibleCopies.length).toBe(0);
					expect(session.published.length).toBe(0);
					expect(state.attention.length).toBe(1);
					expect(state.attention[0]?.reason).toBe(
						"Queued file is absent from the local vault",
					);
					const retained = state.attention[0]?.operation;
					if (retained?.op !== "put")
						throw new Error("Expected retained queued payload evidence");
					expect(retained.payload_hash === (await hashText(offlineText))).toBe(
						true,
					);
					const saved = await journal.readPayload(
						retained.payload_ref,
						retained.payload_hash,
					);
					expect(
						saved.byteLength === offlineBytes.byteLength &&
							saved.every((byte, index) => byte === offlineBytes[index]),
					).toBe(true);
				} else {
					expect(
						state.attention.some(
							(item: DeviceState["attention"][number]) =>
								item.reason === "Queued file is absent from the local vault",
						),
					).toBe(false);
					expect(state.pending_ops.length).toBe(0);
					expect(visibleCopies.length).toBe(1);
					expect(session.published.length).toBe(1);
					expect(session.published[0]?.text === offlineText).toBe(true);
					expect(
						session.published.some((item) => item.path === sourcePath),
					).toBe(false);
					const copyPath = visibleCopies[0]?.[0];
					if (!copyPath) throw new Error("Expected one visible conflict copy");
					const copyBase = state.base[copyPath];
					if (!copyBase || copyBase.deleted)
						throw new Error("Expected a confirmed conflict-copy base");
					expect(copyBase.hash === (await hashText(offlineText))).toBe(true);
				}
			} finally {
				controller.close();
				composition.dispose();
				journal.close();
			}
		},
	);
});
