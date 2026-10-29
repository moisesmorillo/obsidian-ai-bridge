import { beforeEach, describe, expect, it } from "vitest";
import { DeviceJournal } from "../src/sync/device-journal";
import {
	type ReconciliationChangesPage,
	ReconciliationController,
	type ReconciliationRemote,
} from "../src/sync/reconciliation";
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
	writes = 0;
	/** Reads one current text path. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Lists every current text path. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Changes text only when the observed value still matches. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		this.writes += 1;
		return true;
	}
	/** Creates text only at an absent path. */
	async create(path: string, text: string): Promise<boolean> {
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
	feed: ReconciliationChangesPage[] = [];
	texts = new Map<string, string>();
	created: Array<{ path: string; text: string; epoch: string; key: string }> =
		[];
	createError: Error | null = null;
	onCreate: (() => void) | null = null;
	/** Captures the epoch and head at traversal start. */
	async vault(): Promise<{ epoch: string; head_seq: number }> {
		return { epoch, head_seq: 4 };
	}
	/** Returns the single test manifest page. */
	async manifest(): Promise<{
		epoch: string;
		head_seq: number;
		entries: RemoteTestEntry[];
		next_page: null;
	}> {
		return { epoch, head_seq: 4, entries: this.entries, next_page: null };
	}
	/** Returns an empty change page after the captured cursor. */
	async changes(
		_epoch: string,
		_since: number,
	): Promise<ReconciliationChangesPage> {
		return this.feed.shift() ?? { epoch, head_seq: 4, entries: [] };
	}
	/** Returns pinned text by exact revision identity. */
	async read(
		_path: string,
		_epoch: string,
		rev: number,
	): Promise<string | null> {
		return this.texts.get(String(rev)) ?? null;
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
		if (this.createError) throw this.createError;
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
	return { journal, vault, remote, controller };
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
