import { beforeEach, describe, expect, it } from "vitest";
import { DeviceJournal } from "../src/sync/device-journal";
import {
	type PinnedTextProvider,
	TextApplyEngine,
	type TextApplyOptions,
	type TextVault,
} from "../src/sync/text-apply";

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
	refuseTrash: ((path: string) => boolean) | null = null;
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
		if (this.refuseTrash?.(path)) return false;
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

/** Builds an apply engine with a stable test device name unless a case overrides it. */
function makeEngine(
	journal: DeviceJournal,
	vault: TextVault,
	pinnedText: PinnedTextProvider,
	options: TextApplyOptions = { deviceName: "Test Device" },
): TextApplyEngine {
	return new TextApplyEngine(journal, vault, pinnedText, options);
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
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("user bytes");
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("keeps local bytes when a conflict copy changes during pinned fetch", async () => {
		const localText = "user bytes";
		vault.files.set(change.path, localText);
		engine = makeEngine(journal, vault, {
			read: async () => {
				const copyPath = [...vault.files.keys()].find((path) =>
					path.includes("(conflict "),
				);
				if (copyPath) vault.files.set(copyPath, "edited copy");
				return remoteText;
			},
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(localText);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Conflict copy changed during remote apply",
		});
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
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated crash before base commit",
		);
		expect(vault.files.get(change.path)).toBe(remoteText);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, {
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
		const conflictPath =
			journal.snapshot().pending_apply[0]?.conflict_copies?.[0]?.path;
		expect(conflictPath).toBeDefined();
		vault.files.set(conflictPath as string, "edited copy");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]?.rev).toBe(2);
	});

	it("applies a clean destination-only rename without a conflict copy", async () => {
		const destinationBaseText = "clean destination bytes";
		vault.files.set("notes/b.md", destinationBaseText);
		journal = await seedBase(
			"notes/b.md",
			await hash(destinationBaseText),
			storage,
			journal,
		);
		engine = makeEngine(
			journal,
			vault,
			{ read: async (_path, _epoch, rev) => (rev === 3 ? remoteText : null) },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/b.md")).toBe(remoteText);
		expect(
			[...vault.files.keys()].some((path) => path.includes("(conflict ")),
		).toBe(false);
		expect(journal.snapshot().base["notes/b.md"]).toEqual({
			deleted: false,
			rev: 3,
			hash: await hash(remoteText),
		});
	});

	it("does not commit a source tombstone when trash refuses a remote-equal destination rename", async () => {
		vault.files.set("notes/a.md", remoteText);
		vault.files.set("notes/b.md", remoteText);
		journal = await seedBase(
			"notes/a.md",
			await hash(remoteText),
			storage,
			journal,
		);
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(remoteText);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: false,
			rev: 1,
			hash: await hash(remoteText),
		});
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("does not commit a source tombstone when trash refuses after a rename destination write", async () => {
		vault.files.set("notes/a.md", remoteText);
		journal = await seedBase(
			"notes/a.md",
			await hash(remoteText),
			storage,
			journal,
		);
		vault.rename = async () => false;
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(remoteText);
		expect(vault.files.get("notes/b.md")).toBe(remoteText);
		expect(journal.snapshot().base["notes/a.md"]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("keeps a source visible and pending when trash refuses during rename recovery", async () => {
		const source = "dirty source bytes";
		vault.files.set("notes/a.md", source);
		journal = await seedBase(
			"notes/a.md",
			await hash("older source"),
			storage,
			journal,
		);
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(source);
		expect(journal.snapshot().base["notes/a.md"]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("keeps conflict naming metadata stable after restart and engine option changes", async () => {
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
			if (pending.step === "named")
				throw new Error("simulated stop after naming");
		};
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		vault.beforeProcess = () => {
			vault.files.set(change.path, "dirty local bytes");
			vault.beforeProcess = null;
		};
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated stop after naming",
		);
		const pending = journal.snapshot().pending_apply[0];
		expect(pending?.conflict_copies?.[0]?.device_name).toBe("Moises Mac");
		const conflictPath = pending?.conflict_copies?.[0]?.path;
		expect(conflictPath).toContain("(conflict Moises Mac ");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Other Name" },
		);
		await engine.resume();
		expect(
			[...vault.files.keys()].filter((path) => path === conflictPath),
		).toHaveLength(1);
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("fences pinned fetch completion and queued apply work after close", async () => {
		let markStarted: (() => void) | undefined;
		let release: ((text: string) => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetch = new Promise<string>((resolve) => {
			release = resolve;
		});
		engine = makeEngine(
			journal,
			vault,
			{
				read: async () => {
					markStarted?.();
					return fetch;
				},
			},
			{ deviceName: "Moises Mac" },
		);
		vault.files.set(change.path, remoteText);
		const first = engine.apply(change);
		await started;
		const second = engine.apply({ ...change, seq: 2, path: "notes/queued.md" });
		engine.close();
		release?.(remoteText);
		await expect(first).rejects.toThrow("closed");
		await expect(second).rejects.toThrow("closed");
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toBeUndefined();
		expect(journal.snapshot().pending_apply[0]?.step).toBe("prepared");
		expect(journal.snapshot().base["notes/queued.md"]).toBeUndefined();
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
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.apply(rename);
		expect(vault.files.get("notes/b.md")).toBe("newer destination");
		expect(vault.files.has("notes/a.md")).toBe(false);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base["notes/b.md"]?.rev).toBe(5);
	});

	it.each([
		{ op: "delete", step: "named" },
		{ op: "delete", step: "copied" },
		{ op: "rename", step: "named" },
		{ op: "rename", step: "copied" },
	] as const)(
		"recovers a local $op conflict at persisted $step after restart",
		async ({ op, step }) => {
			const source = "dirty local source";
			vault.files.set("notes/a.md", source);
			journal = await seedBase(
				"notes/a.md",
				await hash("old source"),
				storage,
				journal,
			);
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step) throw new Error(`stopped at ${step}`);
			};
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Moises Mac" },
			);
			const changeToApply =
				op === "delete"
					? { ...change, op: "delete" as const, hash: "" }
					: {
							...change,
							op: "rename" as const,
							path: "notes/b.md",
							from_path: "notes/a.md",
							from_etag: `"${epoch}.2"`,
						};
			await expect(engine.apply(changeToApply)).rejects.toThrow(
				`stopped at ${step}`,
			);
			expect(journal.snapshot().pending_apply[0]?.step).toBe(step);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(journal.snapshot().pending_apply).toEqual([]);
			if (op === "delete") {
				expect(journal.snapshot().base["notes/a.md"]).toEqual({
					deleted: true,
					rev: 2,
				});
			} else {
				expect(journal.snapshot().base["notes/a.md"]).toEqual({
					deleted: true,
					rev: 2,
				});
				expect(journal.snapshot().base["notes/b.md"]).toEqual({
					deleted: false,
					rev: 2,
					hash: await hash(remoteText),
				});
			}
		},
	);

	it.each(["named", "copied"] as const)(
		"recovers a persisted remote %s conflict step after restart",
		async (step) => {
			const collidingPath = "notes/CAFÉ.md";
			vault.files.set(collidingPath, "local collision bytes");
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step) throw new Error(`stopped at ${step}`);
			};
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Moises Mac" },
			);
			await expect(
				engine.apply({ ...change, path: "notes/café.md" }),
			).rejects.toThrow(`stopped at ${step}`);
			const pending = journal.snapshot().pending_apply[0];
			expect(pending?.step).toBe(step);
			expect(pending?.conflict_copies?.[0]?.device_name).toBe("Moises Mac");
			const conflictPath = pending?.conflict_copies?.[0]?.path;
			expect(conflictPath).toContain("(conflict Moises Mac ");
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Other Name" },
			);
			await engine.resume();
			expect(vault.files.get(conflictPath as string)).toBe(remoteText);
			expect(journal.snapshot().pending_apply).toEqual([]);
			expect(journal.snapshot().base["notes/café.md"]?.rev).toBe(2);
		},
	);

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

	it.each(["put", "delete"] as const)(
		"rechecks an obsolete %s after a crash before ignore",
		async (op) => {
			const newerText = "revision three bytes";
			vault.files.set(change.path, newerText);
			journal = await seedBase(
				change.path,
				await hash(newerText),
				storage,
				journal,
			);
			const state = journal.snapshot();
			state.base[change.path] = {
				deleted: false,
				rev: 3,
				hash: await hash(newerText),
			};
			journal.close();
			storage.state = state;
			journal = await DeviceJournal.open(storage);
			const ignore = journal.ignoreApply.bind(journal);
			journal.ignoreApply = async (..._args) => {
				throw new Error("simulated crash before ignore");
			};
			const obsolete = {
				...change,
				op,
				hash: op === "put" ? change.hash : "",
			};
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await expect(engine.apply(obsolete)).rejects.toThrow(
				"simulated crash before ignore",
			);
			expect(journal.snapshot().pending_apply[0]?.step).toBe("prepared");
			journal.ignoreApply = ignore;
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(vault.files.get(change.path)).toBe(newerText);
			expect(journal.snapshot().base[change.path]).toEqual({
				deleted: false,
				rev: 3,
				hash: await hash(newerText),
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it("keeps changed bytes visible when a copied delete resumes", async () => {
		const original = "dirty before delete";
		const changed = "edited after copied";
		vault.files.set(change.path, original);
		journal = await seedBase(
			change.path,
			await hash("older base"),
			storage,
			journal,
		);
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "copied") throw new Error("crash after copied");
		};
		engine = makeEngine(journal, vault, { read: async () => null });
		await expect(
			engine.apply({ ...change, op: "delete", hash: "" }),
		).rejects.toThrow("crash after copied");
		vault.files.set(change.path, changed);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(changed);
		expect(
			[...vault.files.entries()].some(
				([path, text]) => path.includes("(conflict ") && text === original,
			),
		).toBe(true);
		expect(journal.snapshot().base[change.path]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Local text changed after its conflict copy was saved",
		});
	});

	it("keeps recreated bytes visible after trash and before delete base commit", async () => {
		const original = "dirty before delete";
		const recreated = "recreated after trash";
		vault.files.set(change.path, original);
		journal = await seedBase(
			change.path,
			await hash("older base"),
			storage,
			journal,
		);
		journal.completeApply = async () => {
			throw new Error("crash after trash before base commit");
		};
		engine = makeEngine(journal, vault, { read: async () => null });
		await expect(
			engine.apply({ ...change, op: "delete", hash: "" }),
		).rejects.toThrow("crash after trash before base commit");
		expect(vault.files.has(change.path)).toBe(false);
		vault.files.set(change.path, recreated);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(recreated);
		expect(
			[...vault.files.entries()].some(
				([path, text]) => path.includes("(conflict ") && text === original,
			),
		).toBe(true);
		expect(journal.snapshot().base[change.path]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Local text changed after its conflict copy was saved",
		});
	});

	it("preserves distinct dirty rename sides and applies the pinned destination", async () => {
		const sourceText = "dirty source bytes";
		const destinationText = "dirty destination bytes";
		const sourcePath = "notes/a.md";
		const destinationPath = "notes/b.md";
		vault.files.set(sourcePath, sourceText);
		vault.files.set(destinationPath, destinationText);
		journal = await seedBase(
			sourcePath,
			await hash("source base"),
			storage,
			journal,
		);
		const state = journal.snapshot();
		state.base[destinationPath] = {
			deleted: false,
			rev: 1,
			hash: await hash("destination base"),
		};
		journal.close();
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		const rename = {
			...change,
			op: "rename" as const,
			path: destinationPath,
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: sourcePath,
			from_etag: `"${epoch}.2"`,
		};
		engine = makeEngine(journal, vault, { read: async () => remoteText });
		await engine.apply(rename);
		const conflictFiles = [...vault.files.entries()].filter(([path]) =>
			path.includes("(conflict "),
		);
		expect(conflictFiles).toHaveLength(2);
		expect(conflictFiles.map(([, text]) => text).sort()).toEqual(
			[sourceText, destinationText].sort(),
		);
		expect(vault.files.get(destinationPath)).toBe(remoteText);
		expect(vault.files.has(sourcePath)).toBe(false);
		expect(journal.snapshot().base[sourcePath]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base[destinationPath]).toEqual({
			deleted: false,
			rev: 3,
			hash: await hash(remoteText),
		});
	});

	it.each(["named", "source_copy", "destination_copy", "copied"] as const)(
		"resumes dual-dirty rename after the %s boundary",
		async (boundary) => {
			const sourceText = "dirty source bytes";
			const destinationText = "dirty destination bytes";
			const sourcePath = "notes/a.md";
			const destinationPath = "notes/b.md";
			vault.files.set(sourcePath, sourceText);
			vault.files.set(destinationPath, destinationText);
			journal = await seedBase(
				sourcePath,
				await hash("source base"),
				storage,
				journal,
			);
			const state = journal.snapshot();
			state.base[destinationPath] = {
				deleted: false,
				rev: 1,
				hash: await hash("destination base"),
			};
			journal.close();
			storage.state = state;
			journal = await DeviceJournal.open(storage);
			const rename = {
				...change,
				op: "rename" as const,
				path: destinationPath,
				hash: await hash(remoteText),
				etag: `"${epoch}.3"`,
				from_path: sourcePath,
				from_etag: `"${epoch}.2"`,
			};
			if (boundary === "named" || boundary === "copied") {
				const update = journal.updateApply.bind(journal);
				journal.updateApply = async (pending) => {
					await update(pending);
					if (pending.step === boundary)
						throw new Error(`stopped at ${boundary}`);
				};
			}
			const create = vault.create.bind(vault);
			let copiesCreated = 0;
			vault.create = async (path, text) => {
				const result = await create(path, text);
				if (result && path.includes("(conflict ")) {
					copiesCreated += 1;
					if (
						(boundary === "source_copy" && copiesCreated === 1) ||
						(boundary === "destination_copy" && copiesCreated === 2)
					)
						throw new Error(`stopped at ${boundary}`);
				}
				return result;
			};
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await expect(engine.apply(rename)).rejects.toThrow(
				`stopped at ${boundary}`,
			);
			const pending = journal.snapshot().pending_apply[0];
			expect(pending?.conflict_copies).toHaveLength(2);
			expect(pending?.conflict_copies?.[0]?.side).toBe("rename_source");
			expect(pending?.conflict_copies?.[1]?.side).toBe("rename_destination");
			expect(pending?.conflict_copies?.[0]?.source).toBe(sourcePath);
			expect(pending?.conflict_copies?.[1]?.source).toBe(destinationPath);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(vault.files.get(destinationPath)).toBe(remoteText);
			expect(vault.files.has(sourcePath)).toBe(false);
			expect(
				[...vault.files.values()].filter(
					(text) => text === sourceText || text === destinationText,
				),
			).toHaveLength(2);
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

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
		engine = makeEngine(journal, vault, {
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
		engine = makeEngine(journal, vault, { read: async () => null });
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
		engine = makeEngine(journal, vault, { read: async () => local });
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
		engine = makeEngine(journal, vault, {
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
