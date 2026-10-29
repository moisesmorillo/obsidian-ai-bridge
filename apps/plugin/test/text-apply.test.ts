import { beforeEach, describe, expect, it } from "vitest";
import { DeviceJournal } from "../src/sync/device-journal";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";

/** Stores device state and note text for isolated apply tests. */
class MemoryStorage {
	state: unknown = null;
	/** Reads the raw persisted journal document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Replaces the test journal document with a defensive copy. */
	async writeState(value: unknown): Promise<void> {
		this.state = structuredClone(value);
	}
	/** Rejects payload access because these apply tests do not enqueue operations. */
	async readPayload(): Promise<Uint8Array> {
		throw new Error("unused");
	}
	/** Rejects payload writes because these apply tests do not enqueue operations. */
	async writePayload(): Promise<void> {
		throw new Error("unused");
	}
}

/** Emulates exact-string process guards and visible path collisions. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();
	beforeProcess: (() => void) | null = null;
	/** Reads current text or reports an absent exact path. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Lists every visible fake path. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Applies text only when the exact observed value remains unchanged. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		this.beforeProcess?.();
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}
	/** Creates one absent path without replacing existing bytes. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}
	/** Removes a path to emulate an accepted local-trash operation. */
	async trash(path: string, _expected: string): Promise<boolean> {
		if (!this.files.has(path)) return false;
		this.files.delete(path);
		return true;
	}
	/** Moves one exact file to an absent destination. */
	async rename(from: string, to: string, _expected: string): Promise<boolean> {
		const text = this.files.get(from);
		if (text === undefined || this.files.has(to)) return false;
		this.files.set(to, text);
		this.files.delete(from);
		return true;
	}
}

const epoch = "b".repeat(32);
const change = {
	seq: 1,
	op: "put" as const,
	path: "notes/a.md",
	etag: `"${epoch}.2"`,
	hash: "",
	origin: "remote",
	at: 1,
};

/** Seeds a confirmed base through a validated journal restart. */
async function seedBase(
	path: string,
	hashValue: string,
	storage: MemoryStorage,
	journal: DeviceJournal,
): Promise<DeviceJournal> {
	const state = journal.snapshot();
	state.base[path] = { deleted: false, rev: 1, hash: hashValue };
	journal.close();
	storage.state = state;
	return DeviceJournal.open(storage);
}

/** Hashes UTF-8 test text with the same Web Crypto digest as the engine. */
async function hash(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("TextApplyEngine", () => {
	let storage: MemoryStorage;
	let journal: DeviceJournal;
	let vault: MemoryVault;
	let engine: TextApplyEngine;
	const remoteText = "remote bytes";

	beforeEach(async () => {
		storage = new MemoryStorage();
		journal = await DeviceJournal.open(storage);
		vault = new MemoryVault();
		const remoteChange = { ...change, hash: await hash(remoteText) };
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		Object.assign(change, remoteChange);
	});

	it("applies pinned text only when current bytes match the confirmed base", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 2,
			hash: change.hash,
		});
	});

	it("resumes a copied conflict after a crash before the remote effect", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "copied")
				throw new Error("simulated crash after copied");
		};
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated crash after copied",
		);
		expect(journal.snapshot().pending_apply[0]?.step).toBe("copied");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("user bytes");
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("recovers a confirmed file effect before its base commit", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		journal.completeApply = async () => {
			throw new Error("simulated crash before base commit");
		};
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated crash before base commit",
		);
		expect(vault.files.get(change.path)).toBe(remoteText);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(journal.snapshot().base[change.path]?.rev).toBe(2);
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("does not overwrite an edited conflict copy after restart", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		const create = vault.create.bind(vault);
		vault.create = async (path, text) => {
			await create(path, text);
			throw new Error("simulated crash after conflict create");
		};
		await expect(engine.apply(change)).rejects.toThrow("simulated crash");
		const conflictPath = journal.snapshot().pending_apply[0]?.conflict_path;
		expect(conflictPath).toBeDefined();
		vault.files.set(conflictPath as string, "edited copy");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(conflictPath as string)).toBe("edited copy");
		expect(vault.files.get(change.path)).toBe("user bytes");
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Conflict copy was edited before the apply finished",
		});
	});

	it("does not commit stale apply state after lifecycle close during a host effect", async () => {
		let markStarted: (() => void) | undefined;
		let release: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vault.create = async (path, text) => {
			markStarted?.();
			await gate;
			vault.files.set(path, text);
			return true;
		};
		const applying = engine.apply(change);
		await started;
		engine.close();
		release?.();
		await expect(applying).rejects.toThrow("closed");
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toBeUndefined();
		expect(journal.snapshot().pending_apply).toHaveLength(1);
	});

	it("resumes a prepared entry after a restart", async () => {
		await journal.beginApply(change);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]?.rev).toBe(2);
	});

	it("keeps a newer rename destination base while applying only the dirty source side", async () => {
		const oldHash = await hash("base source");
		vault.files.set("notes/a.md", "edited source");
		journal = await seedBase("notes/a.md", oldHash, storage, journal);
		const state = journal.snapshot();
		state.base["notes/b.md"] = {
			deleted: false,
			rev: 5,
			hash: await hash("newer destination"),
		};
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		const rename = {
			...change,
			op: "rename" as const,
			path: "notes/b.md",
			hash: await hash("renamed remote"),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		};
		vault.files.set(rename.path, "newer destination");
		engine = new TextApplyEngine(journal, vault, { read: async () => null });
		await engine.apply(rename);
		expect(vault.files.get("notes/b.md")).toBe("newer destination");
		expect(vault.files.has("notes/a.md")).toBe(false);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base["notes/b.md"]?.rev).toBe(5);
	});

	it("preserves a case-folded path collision and stores pinned remote text as a conflict copy", async () => {
		const collidingPath = "notes/CAFÉ.md";
		vault.files.set(collidingPath, "local collision bytes");
		await engine.apply({ ...change, path: "notes/café.md" });
		expect(vault.files.get(collidingPath)).toBe("local collision bytes");
		const copies = [...vault.files.entries()].filter(([path]) =>
			path.includes("(conflict "),
		);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.[1]).toBe(remoteText);
		expect(journal.snapshot().attention).toContainEqual({
			path: "notes/café.md",
			reason:
				"Remote path collides with a local case-folded or Unicode-equivalent path",
		});
	});

	it("preserves text that races an absent-path create", async () => {
		const create = vault.create.bind(vault);
		let raced = false;
		vault.create = async (path, text) => {
			if (!raced && path === change.path) {
				raced = true;
				vault.files.set(path, "raced local text");
				return false;
			}
			return create(path, text);
		};
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("raced local text");
		expect(
			[...vault.files.keys()].filter((path) => path.includes("(conflict ")),
		).toHaveLength(1);
	});

	it("updates the base for identical bytes without a conflict copy", async () => {
		vault.files.set(change.path, remoteText);
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 2,
			hash: change.hash,
		});
		expect(vault.files.size).toBe(1);
	});

	it("ignores an obsolete put revision without changing local bytes", async () => {
		vault.files.set(change.path, "newer local bytes");
		journal = await seedBase(
			change.path,
			await hash("newer local bytes"),
			storage,
			journal,
		);
		const state = journal.snapshot();
		state.base[change.path] = {
			deleted: false,
			rev: 3,
			hash: await hash("newer local bytes"),
		};
		journal.close();
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		engine = new TextApplyEngine(journal, vault, {
			read: async () => remoteText,
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe("newer local bytes");
		expect(journal.snapshot().base[change.path]?.rev).toBe(3);
	});

	it("trashes an explicit remote delete", async () => {
		const local = "base bytes";
		vault.files.set(change.path, local);
		journal = await seedBase(change.path, await hash(local), storage, journal);
		engine = new TextApplyEngine(journal, vault, { read: async () => null });
		await engine.apply({
			...change,
			op: "delete",
			hash: "",
			etag: `"${epoch}.2"`,
		});
		expect(vault.files.has(change.path)).toBe(false);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: true,
			rev: 2,
		});
	});

	it("moves a clean rename source and commits both bases", async () => {
		const local = "renamed text";
		const remoteHash = await hash(local);
		vault.files.set("notes/a.md", local);
		journal = await seedBase("notes/a.md", remoteHash, storage, journal);
		engine = new TextApplyEngine(journal, vault, { read: async () => local });
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: remoteHash,
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBeUndefined();
		expect(vault.files.get("notes/b.md")).toBe(local);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base["notes/b.md"]).toEqual({
			deleted: false,
			rev: 3,
			hash: remoteHash,
		});
	});

	it("preserves bytes changed before the atomic process callback", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = new TextApplyEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("user bytes");
		expect(
			[...vault.files.keys()].filter((path) => path.includes("(conflict ")),
		).toHaveLength(1);
	});
});
