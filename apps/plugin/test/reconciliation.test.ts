import { beforeEach, describe, expect, it } from "vitest";
import { SyncTransportError } from "../src/infrastructure/sync-transport";
import { DeviceJournal } from "../src/sync/device-journal";
import {
	type ReconciliationChangesPage,
	ReconciliationController,
	type ReconciliationRemote,
} from "../src/sync/reconciliation";
import { UnsupportedRemoteTextError } from "../src/sync/remote-text";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";

const epoch = "a".repeat(32);

/** Stores verified state and immutable payloads for reconciliation tests. */
class MemoryStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Reads the persisted state document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Writes a defensive state copy. */
	async writeState(value: unknown): Promise<void> {
		this.state = structuredClone(value);
	}
	/** Reads payload bytes by exact path. */
	async readPayload(path: string): Promise<Uint8Array> {
		return this.payloads.get(path)?.slice() ?? new Uint8Array();
	}
	/** Stores immutable payload bytes. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Provides guarded in-memory text effects for apply tests. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();
	fileSizes = new Map<string, number>();
	reads: string[] = [];
	writes = 0;
	processGate: { started: () => void; wait: Promise<void> } | null = null;
	createGate: { started: () => void; wait: Promise<void> } | null = null;
	listError: Error | null = null;
	/** Reads one current text path. */
	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.files.get(path) ?? null;
	}
	/** Returns fixture bytes without decoding unsupported files. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return (
			this.fileSizes.get(path) ??
			(text === undefined ? null : new TextEncoder().encode(text).length)
		);
	}
	/** Lists every current text path. */
	async list(): Promise<string[]> {
		if (this.listError) throw this.listError;
		return [...this.files.keys()];
	}
	/** Changes text only when the observed value still matches. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if (this.processGate) {
			this.processGate.started();
			await this.processGate.wait;
		}
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		this.writes += 1;
		return true;
	}
	/** Creates text only at an absent path. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.createGate) {
			this.createGate.started();
			await this.createGate.wait;
		}
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		this.writes += 1;
		return true;
	}
	/** Removes a matching text path from the fake vault. */
	async trash(path: string, expected: string): Promise<boolean> {
		if (this.files.get(path) !== expected) return false;
		this.files.delete(path);
		return true;
	}
	/** Renames without replacing a destination. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		if (this.files.get(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, expected);
		this.files.delete(from);
		return true;
	}
}

/** One synthetic canonical manifest row used by the controller tests. */
type RemoteTestEntry = {
	path: string;
	etag: string;
	seq: number;
	hash: string;
	kind: "text" | "blob";
	deleted: boolean;
};

/** Serves stable manifest pages and records create-only enrollment requests. */
class MemoryRemote implements ReconciliationRemote {
	entries: RemoteTestEntry[] = [];
	pages = new Map<
		string | null,
		{
			epoch: string;
			head_seq: number;
			entries: RemoteTestEntry[];
			next_page: string | null;
		}
	>();
	manifestCalls: Array<string | null> = [];
	vaultCalls = 0;
	readCalls: Array<{ path: string; rev: number }> = [];
	feed: ReconciliationChangesPage[] = [];
	texts = new Map<string, string>();
	blobPaths = new Set<string>();
	created: Array<{ path: string; text: string; epoch: string; key: string }> =
		[];
	createError: Error | null = null;
	createErrors: Error[] = [];
	changeError: Error | null = null;
	onCreate: (() => void) | null = null;
	/** Captures the epoch and head at traversal start. */
	async vault(): Promise<{ epoch: string; head_seq: number }> {
		this.vaultCalls += 1;
		return { epoch: "c".repeat(32), head_seq: 1 };
	}
	/** Returns one configured snapshot page or the default single-page fixture. */
	async manifest(pageToken: string | null = null): Promise<{
		epoch: string;
		head_seq: number;
		entries: RemoteTestEntry[];
		next_page: string | null;
	}> {
		this.manifestCalls.push(pageToken);
		const page = this.pages.get(pageToken);
		return (
			page ?? { epoch, head_seq: 4, entries: this.entries, next_page: null }
		);
	}
	/** Returns an empty change page after the captured cursor. */
	async changes(
		_epoch: string,
		_since: number,
	): Promise<ReconciliationChangesPage> {
		if (this.changeError) throw this.changeError;
		return this.feed.shift() ?? { epoch, head_seq: 4, entries: [] };
	}
	/** Returns pinned text by exact revision identity. */
	async read(
		path: string,
		_epoch: string,
		rev: number,
	): Promise<string | null> {
		this.readCalls.push({ path, rev });
		if (this.blobPaths.has(path)) throw new UnsupportedRemoteTextError(path);
		return this.texts.get(String(rev)) ?? null;
	}
	/** Returns one verified test text revision without changing its identity. */
	async readResolved(path: string, epoch: string, rev: number) {
		const text = await this.read(path, epoch, rev);
		if (text === null) throw new Error("Pinned test text is missing");
		return { text, epoch, rev, hash: await hash(text) };
	}
	/** Creates text and returns its confirmed epoch-bound revision. */
	async createText(
		path: string,
		text: string,
		currentEpoch: string,
		key: string,
	) {
		this.created.push({ path, text, epoch: currentEpoch, key });
		this.onCreate?.();
		const nextError = this.createErrors.shift() ?? this.createError;
		if (nextError) throw nextError;
		return { status: 201, headers: { etag: `"${epoch}.5"` }, text: "" };
	}
}

/** Builds one real journal, apply engine, and reconciliation controller. */
async function setup() {
	const storage = new MemoryStorage();
	const journal = await DeviceJournal.open(storage);
	const vault = new MemoryVault();
	const remote = new MemoryRemote();
	const engine = new TextApplyEngine(journal, vault, remote, {
		deviceName: "test",
	});
	const controller = new ReconciliationController(
		journal,
		engine,
		vault,
		remote,
	);
	return { storage, journal, vault, remote, controller };
}

/** Reopens only journal and controllers while preserving fake durable storage and vault state. */
async function reopen(context: Awaited<ReturnType<typeof setup>>) {
	context.journal.close();
	const journal = await DeviceJournal.open(context.storage);
	const engine = new TextApplyEngine(journal, context.vault, context.remote, {
		deviceName: "test",
	});
	const controller = new ReconciliationController(
		journal,
		engine,
		context.vault,
		context.remote,
	);
	return { ...context, journal, controller };
}

/** Hashes test fixture text with the production-compatible UTF-8 algorithm. */
async function hash(text: string): Promise<string> {
	const result = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(result)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("ReconciliationController", () => {
	let context: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		context = await setup();
	});

	it.each(["vault list", "checkpoint save"] as const)(
		"resumes after epoch reset when the first %s step fails",
		async (failurePoint) => {
			const text = "recovered after initial checkpoint failure";
			context.remote.entries = [
				{
					path: "recovered-initial.md",
					etag: `"${epoch}.2"`,
					seq: 2,
					hash: await hash(text),
					kind: "text",
					deleted: false,
				},
			];
			context.remote.texts.set("2", text);
			if (failurePoint === "vault list") {
				context.vault.listError = new Error("vault list failed");
			} else {
				const setCheckpoint = context.journal.setReconciliationCheckpoint.bind(
					context.journal,
				);
				context.journal.setReconciliationCheckpoint = async (checkpoint) => {
					if (checkpoint) throw new Error("checkpoint save failed");
					await setCheckpoint(checkpoint);
				};
			}

			await expect(context.controller.enroll()).rejects.toThrow(
				failurePoint === "vault list"
					? "vault list failed"
					: "checkpoint save failed",
			);
			expect(context.journal.snapshot()).toMatchObject({
				epoch,
				cursor: null,
				reconciliation: null,
			});
			context.vault.listError = null;
			context = await reopen(context);

			await context.controller.resume();

			expect(context.vault.files.get("recovered-initial.md")).toBe(text);
			expect(context.journal.snapshot().cursor).toBe(4);
			expect(context.journal.snapshot().reconciliation).toBeNull();
		},
	);

	it("does not enroll a fresh disconnected journal during resume", async () => {
		await context.controller.resume();
		expect(context.remote.manifestCalls).toEqual([]);
		expect(context.journal.snapshot().epoch).toBeUndefined();
		expect(context.journal.snapshot().cursor).toBeNull();
	});

	it("fences a pending apply effect when the controller closes", async () => {
		const remoteText = "close while processing";
		await context.controller.enroll();
		context.remote.feed.push({
			epoch,
			head_seq: 5,
			entries: [
				{
					seq: 5,
					op: "put",
					path: "closing.md",
					etag: `"${epoch}.5"`,
					hash: await hash(remoteText),
					origin: "remote",
					at: 5,
				},
			],
		});
		context.remote.texts.set("5", remoteText);
		let release: (() => void) | undefined;
		let signalStart: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			signalStart = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		context.vault.createGate = { started: () => signalStart?.(), wait };
		const replay = context.controller.replay();
		await started;
		context.controller.close();
		release?.();
		await expect(replay).rejects.toThrow("Text apply engine is closed");
		expect(context.vault.files.get("closing.md")).toBe(remoteText);
		expect(context.journal.snapshot().cursor).toBe(4);
	});

	it("applies a delete only when the manifest confirms its exact text revision", async () => {
		const text = "confirmed text delete";
		context.vault.files.set("deleted.md", text);
		await context.controller.enroll();
		context.remote.entries = [
			{
				path: "deleted.md",
				etag: `"${epoch}.6"`,
				seq: 6,
				hash: "",
				kind: "text",
				deleted: true,
			},
		];
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 6,
					op: "delete",
					path: "deleted.md",
					etag: `"${epoch}.6"`,
					hash: "",
					origin: "remote",
					at: 6,
				},
			],
		});
		await context.controller.replay();
		expect(context.vault.files.has("deleted.md")).toBe(false);
		expect(context.journal.snapshot().cursor).toBe(6);
	});

	it("does not decode or apply a manifest blob tombstone", async () => {
		context.vault.files.set("assets/old.pdf", "binary placeholder");
		context.remote.entries = [
			{
				path: "assets/old.pdf",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: "",
				kind: "blob",
				deleted: true,
			},
		];
		await context.controller.enroll();
		expect(context.vault.reads).not.toContain("assets/old.pdf");
		expect(context.vault.files.get("assets/old.pdf")).toBe(
			"binary placeholder",
		);
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "assets/old.pdf",
			reason: "Blob synchronization is not available yet",
		});
	});

	it("records blob tombstones without decoding or deleting local binary bytes", async () => {
		context.vault.files.set("assets/file.pdf", "binary placeholder");
		await context.controller.enroll();
		context.remote.entries = [
			{
				path: "assets/file.pdf",
				etag: `"${epoch}.5"`,
				seq: 5,
				hash: "",
				kind: "blob",
				deleted: true,
			},
		];
		context.remote.feed.push({
			epoch,
			head_seq: 5,
			entries: [
				{
					seq: 5,
					op: "delete",
					path: "assets/file.pdf",
					etag: `"${epoch}.5"`,
					hash: "",
					origin: "remote",
					at: 5,
				},
			],
		});
		await context.controller.replay();
		expect(context.vault.reads).not.toContain("assets/file.pdf");
		expect(context.vault.files.get("assets/file.pdf")).toBe(
			"binary placeholder",
		);
		expect(context.journal.snapshot().cursor).toBe(5);
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "assets/file.pdf",
			reason: "Delete row is not a confirmed inline-text revision",
		});
	});

	it("records authoritative feed blobs without reading them as local text", async () => {
		await context.controller.enroll();
		context.remote.blobPaths.add("assets/photo.png");
		const following = "after the blob";
		context.remote.texts.set("6", following);
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 5,
					op: "put",
					path: "assets/photo.png",
					etag: `"${epoch}.5"`,
					hash: "b".repeat(64),
					origin: "remote",
					at: 5,
				},
				{
					seq: 6,
					op: "put",
					path: "after-blob.md",
					etag: `"${epoch}.6"`,
					hash: await hash(following),
					origin: "remote",
					at: 6,
				},
			],
		});
		await context.controller.replay();
		expect(context.vault.reads).not.toContain("assets/photo.png");
		expect(context.vault.files.get("after-blob.md")).toBe(following);
		expect(context.journal.snapshot().cursor).toBe(6);
		expect(context.journal.snapshot().pending_apply).toEqual([]);
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "assets/photo.png",
			reason: "Blob synchronization is not available yet",
		});
	});

	it("skips an obsolete put before an unavailable historical read", async () => {
		const path = "already-current.md";
		const text = "newer confirmed bytes";
		await context.controller.enroll();
		await context.journal.setBase(path, {
			deleted: false,
			rev: 8,
			hash: await hash(text),
		});
		context.vault.files.set(path, text);
		context.remote.feed.push({
			epoch,
			head_seq: 5,
			entries: [
				{
					seq: 5,
					op: "put",
					path,
					etag: `"${epoch}.7"`,
					hash: "b".repeat(64),
					origin: "remote",
					at: 5,
				},
			],
		});

		await expect(context.controller.replay()).resolves.toBeUndefined();
		expect(context.remote.readCalls).toEqual([]);
		expect(context.vault.files.get(path)).toBe(text);
		expect(context.journal.snapshot().cursor).toBe(5);
	});

	it("applies a source-only rename without reading its unavailable destination", async () => {
		const source = "rename-source.md";
		const destination = "rename-destination.md";
		const sourceText = "source content";
		const destinationText = "already confirmed destination";
		await context.controller.enroll();
		context.vault.files.set(source, sourceText);
		await context.journal.setBase(source, {
			deleted: false,
			rev: 1,
			hash: await hash(sourceText),
		});
		await context.journal.setBase(destination, {
			deleted: false,
			rev: 10,
			hash: await hash(destinationText),
		});
		context.remote.feed.push({
			epoch,
			head_seq: 5,
			entries: [
				{
					seq: 5,
					op: "rename",
					path: destination,
					etag: `"${epoch}.3"`,
					hash: await hash(destinationText),
					origin: "remote",
					at: 5,
					from_path: source,
					from_etag: `"${epoch}.2"`,
				},
			],
		});

		await expect(context.controller.replay()).resolves.toBeUndefined();
		expect(context.remote.readCalls).toEqual([]);
		expect(context.vault.files.has(source)).toBe(false);
		expect(context.journal.snapshot().base[source]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(context.journal.snapshot().cursor).toBe(5);
	});

	it("applies ascending feed rows and persists each latest sequence", async () => {
		const first = "feed one";
		const second = "feed two";
		await context.controller.enroll();
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 5,
					op: "put",
					path: "feed.md",
					etag: `"${epoch}.5"`,
					hash: await hash(first),
					origin: "remote",
					at: 5,
				},
				{
					seq: 6,
					op: "put",
					path: "feed.md",
					etag: `"${epoch}.6"`,
					hash: await hash(second),
					origin: "remote",
					at: 6,
				},
			],
		});
		context.remote.texts.set("5", first);
		context.remote.texts.set("6", second);
		await context.controller.replay();
		expect(context.vault.files.get("feed.md")).toBe(second);
		expect(context.journal.snapshot().cursor).toBe(6);
	});

	it.each([
		[409, "epoch_mismatch"],
		[410, "cursor_expired"],
	] as const)("reconciles after HTTP %s %s", async (status, code) => {
		await context.controller.enroll();
		const text = `recovered after ${code}`;
		context.remote.entries = [
			{
				path: "recovered.md",
				etag: `"${epoch}.3"`,
				seq: 3,
				hash: await hash(text),
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("3", text);
		context.remote.changeError = Object.assign(new Error("safe failure"), {
			status,
			code,
		});
		await context.controller.replay();
		expect(context.vault.files.get("recovered.md")).toBe(text);
		expect(context.journal.snapshot().cursor).toBe(4);
		expect(context.journal.snapshot().reconciliation).toBeNull();
	});

	it.each([
		[409, "epoch_mismatch"],
		[410, "cursor_expired"],
	] as const)(
		"recovers from HTTP %s %s when resuming",
		async (status, code) => {
			await context.controller.enroll();
			const text = `resumed after ${code}`;
			context.remote.entries = [
				{
					path: "resumed-recovery.md",
					etag: `"${epoch}.3"`,
					seq: 3,
					hash: await hash(text),
					kind: "text",
					deleted: false,
				},
			];
			context.remote.texts.set("3", text);
			context.remote.changeError = Object.assign(new Error("safe failure"), {
				status,
				code,
			});
			await expect(context.controller.resume()).resolves.toBeUndefined();
			expect(context.vault.files.get("resumed-recovery.md")).toBe(text);
			expect(context.journal.snapshot().cursor).toBe(4);
			expect(context.journal.snapshot().reconciliation).toBeNull();
		},
	);

	it("records an equal path base without rewriting local text", async () => {
		const text = "same\r\n";
		context.vault.files.set("same.md", text);
		context.remote.entries = [
			{
				path: "same.md",
				etag: `"${epoch}.3"`,
				seq: 3,
				hash: await hash(text),
				kind: "text",
				deleted: false,
			},
		];
		await context.controller.enroll();
		expect(context.vault.files.get("same.md")).toBe(text);
		expect(context.vault.writes).toBe(0);
		expect(context.journal.snapshot().base["same.md"]).toEqual({
			deleted: false,
			rev: 3,
			hash: await hash(text),
		});
	});

	it("does not start an enrollment request after close during payload admission", async () => {
		context.vault.files.set("closed-before-send.md", "local text");
		const prepareSend = context.journal.prepareSend.bind(context.journal);
		context.journal.prepareSend = async (...args) => {
			const saved = await prepareSend(...args);
			context.controller.close();
			return saved;
		};

		await expect(context.controller.enroll()).rejects.toThrow(
			"Reconciliation controller is closed",
		);
		expect(context.remote.created).toEqual([]);
		expect(context.journal.snapshot().pending_ops[0]?.state).toBe("sent");
	});

	it("keeps a sent enrollment uncertain when close races its response", async () => {
		context.vault.files.set("closed-in-flight.md", "local text");
		context.remote.onCreate = () => context.controller.close();

		await expect(context.controller.enroll()).rejects.toThrow(
			"Reconciliation controller is closed",
		);
		expect(context.remote.created).toHaveLength(1);
		expect(context.journal.snapshot().pending_ops[0]?.state).toBe("sent");
		expect(
			context.journal.snapshot().base["closed-in-flight.md"],
		).toBeUndefined();
	});

	it.each([
		[409, "path_collision"],
		[409, "operation_expired"],
		[422, "idempotency_mismatch"],
		[413, "text_too_large"],
	] as const)(
		"records terminal enrollment failure HTTP %s %s and continues",
		async (status, code) => {
			context.vault.files.set("a-rejected.md", "first local text");
			context.vault.files.set("b-created.md", "second local text");
			const existingPath = code === "path_collision" ? "a-existing.md" : null;
			const error = new SyncTransportError(status, code, existingPath);
			context.remote.createErrors.push(error);
			await context.controller.enroll();

			expect(context.remote.created.map((item) => item.path)).toEqual([
				"a-rejected.md",
				"b-created.md",
			]);
			expect(context.journal.snapshot().pending_ops).toEqual([]);
			expect(context.journal.snapshot().cursor).toBe(4);
			expect(context.journal.snapshot().attention).toContainEqual({
				path: existingPath ?? "a-rejected.md",
				reason: `Enrollment create rejected (${code}) for a-rejected.md`,
			});
			await context.controller.resume();
			expect(context.remote.created).toHaveLength(2);
		},
	);

	it("does not retry a terminal create after a crash before local index advance", async () => {
		context.vault.files.set("terminal.md", "local text");
		context.remote.createErrors.push(
			new SyncTransportError(409, "operation_expired"),
		);
		const setCheckpoint = context.journal.setReconciliationCheckpoint.bind(
			context.journal,
		);
		let failLocalProgress = true;
		context.journal.setReconciliationCheckpoint = async (checkpoint) => {
			if (
				failLocalProgress &&
				checkpoint?.stage === "local" &&
				checkpoint.local_index === 1
			) {
				failLocalProgress = false;
				throw new Error("local progress failed");
			}
			await setCheckpoint(checkpoint);
		};

		await expect(context.controller.enroll()).rejects.toThrow(
			"local progress failed",
		);
		expect(context.remote.created).toHaveLength(1);
		expect(context.journal.snapshot().pending_ops).toEqual([]);
		context = await reopen(context);

		await context.controller.resume();

		expect(context.remote.created).toHaveLength(1);
		expect(context.journal.snapshot().cursor).toBe(4);
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "terminal.md",
			reason: "Enrollment create rejected (operation_expired) for terminal.md",
		});
	});

	it.each([
		[401, "unauthorized"],
		[429, "admission_limited"],
	] as const)(
		"keeps HTTP %s %s enrollment outcome uncertain",
		async (status, code) => {
			context.vault.files.set("uncertain.md", "local text");
			context.remote.createErrors.push(new SyncTransportError(status, code));

			await expect(context.controller.enroll()).rejects.toMatchObject({
				status,
				code,
			});
			expect(context.remote.created).toHaveLength(1);
			expect(context.journal.snapshot().pending_ops[0]?.state).toBe("sent");
			expect(context.journal.snapshot().attention).toEqual([]);
		},
	);

	it("uploads a local UTF-8 BOM without changing the immutable bytes", async () => {
		const text = "\ufeff# heading\r\nUnicode: café\n";
		context.vault.files.set("bom.md", text);
		await context.controller.enroll();
		expect(context.remote.created[0]?.text).toBe(text);
		expect(context.journal.snapshot().base["bom.md"]).toMatchObject({
			deleted: false,
			hash: await hash(text),
		});
	});

	it("admits only inline enrollment files and records local blobs without reading them", async () => {
		context.vault.files.set("note.md", "inline");
		context.vault.files.set("drawing.canvas", '{"nodes":[]}');
		context.vault.files.set("image.png", "binary placeholder");
		context.vault.files.set("large.md", "do not decode");
		context.vault.fileSizes.set("large.md", 1_000_001);
		context.remote.entries = [
			{
				path: "large.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hash("server inline text"),
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", "server inline text");
		for (const path of [
			".obsidian/config.md",
			".trash/old.md",
			".ai-bridge/pending/journal",
			"notes/.DS_Store",
			"notes/photo.icloud",
			"notes/unknown.exe",
		])
			context.vault.files.set(path, "excluded");
		await context.controller.enroll();
		expect(context.remote.created.map((item) => item.path)).toEqual([
			"note.md",
			"drawing.canvas",
		]);
		expect(context.vault.reads).not.toContain("image.png");
		expect(context.vault.reads).not.toContain("large.md");
		for (const path of ["image.png", "large.md"])
			expect(
				context.journal
					.snapshot()
					.attention.some((item: { path: string }) => item.path === path),
			).toBe(true);
		for (const path of [".ai-bridge/pending/journal", ".obsidian/config.md"])
			expect(context.vault.reads).not.toContain(path);
	});

	it("publishes local-only text with a create-only immutable operation", async () => {
		context.vault.files.set("local.md", "local only");
		await context.controller.enroll();
		expect(context.remote.created).toHaveLength(1);
		expect(context.remote.created[0]).toMatchObject({
			path: "local.md",
			text: "local only",
			epoch,
		});
		expect(context.journal.snapshot().cursor).toBe(4);
		expect(context.journal.snapshot().pending_ops).toEqual([]);
	});

	it("resumes saved manifest rows without replaying completed paths or restarting page one", async () => {
		/** Builds one canonical fixture row with an epoch-bound revision and exact hash. */
		const row = async (
			path: string,
			rev: number,
			text: string,
		): Promise<RemoteTestEntry> => ({
			path,
			etag: `"${epoch}.${rev}"`,
			seq: rev,
			hash: await hash(text),
			kind: "text",
			deleted: false,
		});
		const first = await row("first.md", 5, "first");
		const second = await row("second.md", 6, "second");
		const third = await row("third.md", 7, "third");
		context.remote.pages.set(null, {
			epoch,
			head_seq: 7,
			entries: [first, second],
			next_page: "page-2",
		});
		context.remote.pages.set("page-2", {
			epoch,
			head_seq: 7,
			entries: [third],
			next_page: null,
		});
		context.remote.texts.set("5", "first");
		context.remote.texts.set("6", "second");
		context.remote.texts.set("7", "third");
		const writeCheckpoint = context.journal.setReconciliationCheckpoint.bind(
			context.journal,
		);
		let crash = true;
		context.journal.setReconciliationCheckpoint = async (checkpoint) => {
			await writeCheckpoint(checkpoint);
			if (crash && checkpoint?.pending_paths.length === 1) {
				crash = false;
				throw new Error("simulated restart after row checkpoint");
			}
		};
		await expect(context.controller.enroll()).rejects.toThrow(
			"simulated restart",
		);
		const firstReads = context.vault.reads.filter(
			(path) => path === "first.md",
		).length;
		context = await reopen(context);
		await context.controller.resume();
		expect(
			context.vault.reads.filter((path) => path === "first.md"),
		).toHaveLength(firstReads);
		expect(context.remote.manifestCalls).toEqual([null, null, "page-2"]);
		expect(context.journal.snapshot().cursor).toBe(7);
		expect(context.journal.snapshot().reconciliation).toBeNull();
	});

	it("restarts manifest traversal when live continuation membership displaces saved work", async () => {
		const first = "already captured";
		const inserted = "concurrent insert";
		const pending = "displaced row";
		/** Builds one exact manifest row for restart traversal fixtures. */
		const row = async (path: string, rev: number, text: string) => ({
			path,
			etag: `"${epoch}.${rev}"`,
			seq: rev,
			hash: await hash(text),
			kind: "text" as const,
			deleted: false,
		});
		await context.journal.resetEpoch(epoch);
		await context.journal.setReconciliationCheckpoint({
			epoch,
			head_seq: 7,
			stage: "manifest",
			page_token: "page-2",
			page_number: 1,
			local_paths: [],
			local_index: 0,
			pending_paths: ["displaced.md"],
			remote_paths: ["first.md", "displaced.md"],
		});
		context.remote.pages.set(null, {
			epoch,
			head_seq: 7,
			entries: [await row("first.md", 5, first)],
			next_page: "page-2",
		});
		context.remote.pages.set("page-2", {
			epoch,
			head_seq: 7,
			entries: [
				await row("inserted.md", 6, inserted),
				await row("first.md", 5, first),
			],
			next_page: "page-3",
		});
		context.remote.pages.set("page-3", {
			epoch,
			head_seq: 7,
			entries: [await row("displaced.md", 7, pending)],
			next_page: null,
		});
		context.remote.texts.set("5", first);
		context.remote.texts.set("6", inserted);
		context.remote.texts.set("7", pending);

		await expect(context.controller.resume()).resolves.toBeUndefined();
		expect(context.vault.files.get("inserted.md")).toBe(inserted);
		expect(context.vault.files.get("displaced.md")).toBe(pending);
		expect(context.journal.snapshot().cursor).toBe(7);
		expect(context.journal.snapshot().reconciliation).toBeNull();
		expect(context.remote.manifestCalls[0]).toBe("page-2");
		expect(context.remote.manifestCalls).toContain(null);
	});

	it("restarts after a fetched page before its first row effect", async () => {
		const text = "page fetch saved";
		context.remote.pages.set(null, {
			epoch,
			head_seq: 5,
			entries: [
				{
					path: "fetched.md",
					etag: `"${epoch}.5"`,
					seq: 5,
					hash: await hash(text),
					kind: "text",
					deleted: false,
				},
			],
			next_page: null,
		});
		context.remote.texts.set("5", text);
		const saveCheckpoint = context.journal.setReconciliationCheckpoint.bind(
			context.journal,
		);
		let crash = true;
		context.journal.setReconciliationCheckpoint = async (checkpoint) => {
			await saveCheckpoint(checkpoint);
			if (
				crash &&
				checkpoint?.stage === "manifest" &&
				checkpoint.pending_paths.length === 1
			) {
				crash = false;
				throw new Error("simulated restart after page fetch");
			}
		};
		await expect(context.controller.enroll()).rejects.toThrow(
			"simulated restart",
		);
		expect(context.vault.files.has("fetched.md")).toBe(false);
		context = await reopen(context);
		await context.controller.resume();
		expect(context.vault.files.get("fetched.md")).toBe(text);
		expect(context.journal.snapshot().cursor).toBe(5);
	});

	it("restarts after a saved page boundary at the next token", async () => {
		const first = "page one applied";
		const second = "page two applied";
		context.remote.pages.set(null, {
			epoch,
			head_seq: 6,
			entries: [
				{
					path: "page-one.md",
					etag: `"${epoch}.5"`,
					seq: 5,
					hash: await hash(first),
					kind: "text",
					deleted: false,
				},
			],
			next_page: "p2",
		});
		context.remote.pages.set("p2", {
			epoch,
			head_seq: 6,
			entries: [
				{
					path: "page-two.md",
					etag: `"${epoch}.6"`,
					seq: 6,
					hash: await hash(second),
					kind: "text",
					deleted: false,
				},
			],
			next_page: null,
		});
		context.remote.texts.set("5", first);
		context.remote.texts.set("6", second);
		const saveCheckpoint = context.journal.setReconciliationCheckpoint.bind(
			context.journal,
		);
		let crash = true;
		context.journal.setReconciliationCheckpoint = async (checkpoint) => {
			await saveCheckpoint(checkpoint);
			if (
				crash &&
				checkpoint?.stage === "manifest" &&
				checkpoint.page_number === 1 &&
				checkpoint.pending_paths.length === 0
			) {
				crash = false;
				throw new Error("simulated restart after page boundary");
			}
		};
		await expect(context.controller.enroll()).rejects.toThrow(
			"simulated restart",
		);
		context = await reopen(context);
		await context.controller.resume();
		expect(context.vault.files.get("page-one.md")).toBe(first);
		expect(context.vault.files.get("page-two.md")).toBe(second);
		expect(context.remote.manifestCalls).toEqual([null, "p2"]);
	});

	it("resumes after the final cursor write without fetching page one again", async () => {
		const saveCursor = context.journal.setCursor.bind(context.journal);
		let crash = true;
		context.journal.setCursor = async (currentEpoch, cursor) => {
			await saveCursor(currentEpoch, cursor);
			if (crash) {
				crash = false;
				throw new Error("simulated restart after cursor commit");
			}
		};
		await expect(context.controller.enroll()).rejects.toThrow(
			"simulated restart",
		);
		expect(context.journal.snapshot().reconciliation?.stage).toBe("cursor");
		context = await reopen(context);
		await context.controller.resume();
		expect(context.remote.manifestCalls).toEqual([null]);
		expect(context.journal.snapshot().cursor).toBe(4);
		expect(context.journal.snapshot().reconciliation).toBeNull();
	});

	it("uses page one as snapshot authority and ignores a revisited newer row", async () => {
		const first = "first page";
		const newer = "ahead of captured head";
		context.remote.pages.set(null, {
			epoch,
			head_seq: 10,
			entries: [
				{
					path: "first.md",
					etag: `"${epoch}.8"`,
					seq: 8,
					hash: await hash(first),
					kind: "text",
					deleted: false,
				},
			],
			next_page: "next",
		});
		context.remote.pages.set("next", {
			epoch,
			head_seq: 10,
			entries: [
				{
					path: "newer.md",
					etag: `"${epoch}.12"`,
					seq: 12,
					hash: await hash(newer),
					kind: "text",
					deleted: false,
				},
			],
			next_page: null,
		});
		context.remote.texts.set("8", first);
		context.remote.texts.set("12", newer);
		await context.controller.enroll();
		expect(context.remote.vaultCalls).toBe(0);
		expect(context.remote.manifestCalls).toEqual([null, "next"]);
		expect(context.journal.snapshot().cursor).toBe(10);
		const writes = context.vault.writes;
		context.remote.feed.push({
			epoch,
			head_seq: 12,
			entries: [
				{
					seq: 12,
					op: "put",
					path: "newer.md",
					etag: `"${epoch}.12"`,
					hash: await hash(newer),
					origin: "other-device",
					at: 12,
				},
			],
		});
		await context.controller.replay();
		expect(context.vault.writes).toBe(writes);
		expect(context.journal.snapshot().cursor).toBe(12);
	});

	it("recognizes a committed create after its response is lost", async () => {
		const text = "upload committed";
		const hashValue = await hash(text);
		context.vault.files.set("lost.md", text);
		context.remote.createError = new Error("connection lost after commit");
		context.remote.onCreate = () => {
			context.remote.entries = [
				{
					path: "lost.md",
					etag: `"${epoch}.2"`,
					seq: 2,
					hash: hashValue,
					kind: "text",
					deleted: false,
				},
			];
		};
		await expect(context.controller.enroll()).rejects.toThrow();
		expect(context.journal.snapshot().pending_ops[0]?.state).toBe("sent");
		context = await reopen(context);
		context.remote.createError = null;
		await context.controller.resume();
		expect(context.remote.created).toHaveLength(1);
		expect(context.journal.snapshot().pending_ops).toEqual([]);
	});

	it("hydrates a remote-only text path through the guarded apply engine", async () => {
		const text = "from remote";
		context.remote.entries = [
			{
				path: "remote.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hash(text),
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", text);
		await context.controller.enroll();
		expect(context.vault.files.get("remote.md")).toBe(text);
		expect(context.journal.snapshot().base["remote.md"]).toEqual({
			deleted: false,
			rev: 2,
			hash: await hash(text),
		});
	});

	it("rewrites clean restored bases and preserves dirty conflicts and old operations", async () => {
		const oldEpoch = "c".repeat(32);
		const cleanText = "clean unchanged";
		const oldBase = "old confirmed base";
		const localDirty = "local unsent edit";
		const remoteDirty = "remote new edit";
		context.vault.files.set("clean.md", cleanText);
		context.vault.files.set("dirty.md", localDirty);
		await context.journal.resetEpoch(oldEpoch);
		await context.journal.setBase("clean.md", {
			deleted: false,
			rev: 80,
			hash: await hash(cleanText),
		});
		await context.journal.setBase("dirty.md", {
			deleted: false,
			rev: 81,
			hash: await hash(oldBase),
		});
		const queued = await context.journal.enqueue(
			{ op: "put", path: "queued.md", precondition: { kind: "absent" } },
			new TextEncoder().encode("queued payload"),
		);
		const sent = await context.journal.enqueue(
			{ op: "put", path: "sent.md", precondition: { kind: "absent" } },
			new TextEncoder().encode("sent payload"),
		);
		await context.journal.prepareSend(sent.key, { kind: "absent" });
		context.remote.entries.push(
			{
				path: "clean.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hash(cleanText),
				kind: "text",
				deleted: false,
			},
			{
				path: "dirty.md",
				etag: `"${epoch}.3"`,
				seq: 3,
				hash: await hash(remoteDirty),
				kind: "text",
				deleted: false,
			},
		);
		context.remote.texts.set("3", remoteDirty);
		await context.controller.reconcile();
		expect(context.journal.snapshot().base["clean.md"]).toEqual({
			deleted: false,
			rev: 2,
			hash: await hash(cleanText),
		});
		expect(context.vault.files.get("clean.md")).toBe(cleanText);
		expect(context.vault.files.get("dirty.md")).toBe(remoteDirty);
		expect([...context.vault.files.values()]).toContain(localDirty);
		expect(context.journal.snapshot().pending_ops).toEqual([]);
		const preserved: Array<{ key: string; state: string }> = [];
		for (const item of context.journal.snapshot().attention as Array<{
			operation?: { key: string; state: string };
		}>)
			if (item.operation) preserved.push(item.operation);
		expect(
			preserved.map((operation: { state: string }) => operation.state).sort(),
		).toEqual(["queued", "sent"]);
		expect(context.storage.payloads.has(queued.payload_ref)).toBe(true);
		expect(context.storage.payloads.has(sent.payload_ref)).toBe(true);
	});

	it("uses hashes rather than old revision numbers after epoch restore", async () => {
		const oldEpoch = "c".repeat(32);
		const oldText = "confirmed before restore";
		const remoteText = "restored remote version";
		context.vault.files.set("restored.md", oldText);
		await context.journal.resetEpoch(oldEpoch);
		await context.journal.setBase("restored.md", {
			deleted: false,
			rev: 90,
			hash: await hash(oldText),
		});
		context.remote.entries = [
			{
				path: "restored.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hash(remoteText),
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", remoteText);
		await context.controller.reconcile();
		expect(context.vault.files.get("restored.md")).toBe(remoteText);
		expect(context.journal.snapshot().base["restored.md"]?.rev).toBe(2);
	});

	it("preserves local bytes and hydrates the remote winner after a create race", async () => {
		const localText = "local first-device copy";
		const remoteText = "remote competing copy";
		context.vault.files.set("race.md", localText);
		context.remote.createError = Object.assign(
			new Error("precondition failed"),
			{ status: 412 },
		);
		const remoteHash = await hash(remoteText);
		context.remote.onCreate = () => {
			context.remote.entries = [
				{
					path: "race.md",
					etag: `"${epoch}.2"`,
					seq: 2,
					hash: remoteHash,
					kind: "text",
					deleted: false,
				},
			];
		};
		context.remote.texts.set("2", remoteText);
		await expect(context.controller.enroll()).resolves.toBeUndefined();
		expect(context.vault.files.get("race.md")).toBe(remoteText);
		expect([...context.vault.files.values()]).toContain(localText);
		expect(context.journal.snapshot().pending_ops).toEqual([]);
		expect(context.journal.snapshot().reconciliation).toBeNull();
	});

	it("replaces a clean local version when the remote hash differs", async () => {
		const oldText = "old";
		const remoteText = "new";
		context.vault.files.set("note.md", oldText);
		await context.journal.resetEpoch(epoch);
		await context.journal.setBase("note.md", {
			deleted: false,
			rev: 1,
			hash: await hash(oldText),
		});
		context.remote.entries = [
			{
				path: "note.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hash(remoteText),
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", remoteText);
		await context.controller.reconcile();
		expect(context.vault.files.get("note.md")).toBe(remoteText);
	});
});
