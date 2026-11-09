import {
	formatETag,
	ManifestPageSchema,
	type PendingConflictCopy,
	parseETag,
	pathKey,
} from "@vaultwire/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { OAuthTransportResponse } from "../src/infrastructure/oauth-transport";
import {
	SyncTransport,
	SyncTransportError,
} from "../src/infrastructure/sync-transport";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { DeviceJournal } from "../src/sync/device-journal";
import {
	type ReconciliationChangesPage,
	ReconciliationController,
	type ReconciliationRemote,
} from "../src/sync/reconciliation";
import { UnsupportedRemoteTextError } from "../src/sync/remote-text";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";
import {
	authorizedVaults,
	createAc13CaseScripts,
	createCaseScript,
	safeCaseResult,
} from "../tools/desktop-acceptance";

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

/** Provides guarded in-memory text and byte effects for apply tests. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();
	binaryFiles = new Map<string, Uint8Array>();
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
	/** Reads binary fixture bytes or the exact UTF-8 bytes of a text fixture. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const bytes = this.binaryFiles.get(path);
		if (bytes) return bytes.slice();
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
	}
	/** Returns stable test metadata for a current binary path. */
	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const bytes = this.binaryFiles.get(path);
		return bytes ? { mtime: 1, size: bytes.byteLength } : null;
	}
	/** Creates exact bytes at an absent path. */
	async createBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		if (
			[...this.files.keys(), ...this.binaryFiles.keys()].some(
				(current) => current === path || pathKey(current) === pathKey(path),
			)
		)
			return false;
		this.binaryFiles.set(path, bytes.slice());
		return true;
	}
	/** Moves text or binary file bytes to the test trash only when they still match. */
	async trashBinary(path: string, expected: Uint8Array): Promise<boolean> {
		const current = await this.readBinary(path);
		if (
			!current ||
			current.byteLength !== expected.byteLength ||
			!current.every((byte, index) => byte === expected[index])
		)
			return false;
		this.files.delete(path);
		this.binaryFiles.delete(path);
		return true;
	}
	/** Replaces exact bytes at an existing path. */
	async modifyBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		if (!this.binaryFiles.has(path) && !this.files.has(path)) return false;
		this.files.delete(path);
		this.binaryFiles.set(path, bytes.slice());
		return true;
	}
	/** Returns fixture bytes without decoding unsupported files. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return (
			this.fileSizes.get(path) ??
			(text === undefined
				? (this.binaryFiles.get(path)?.byteLength ?? null)
				: new TextEncoder().encode(text).length)
		);
	}
	/** Lists every current text path. */
	async list(): Promise<string[]> {
		if (this.listError) throw this.listError;
		return [...this.files.keys(), ...this.binaryFiles.keys()];
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
	blobs = new Map<number, Uint8Array>();
	created: Array<{ path: string; text: string; epoch: string; key: string }> =
		[];
	createdBlobs: Array<{
		path: string;
		bytes: Uint8Array;
		hash: string;
		epoch: string;
		key: string;
	}> = [];
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
	/** Returns one exact test blob revision with its server identity. */
	async readBlob(
		path: string,
		requestEpoch: string,
		rev: number,
		hashValue: string,
	) {
		if (!this.blobPaths.has(path)) throw new Error("Unexpected blob read");
		const bytes = this.blobs.get(rev);
		if (!bytes) throw new Error("Missing test blob revision");
		return { bytes: bytes.slice(), epoch: requestEpoch, rev, hash: hashValue };
	}
	/** Returns one verified test text revision without changing its identity. */
	async readResolved(path: string, epoch: string, rev: number) {
		const text = await this.read(path, epoch, rev);
		if (text === null) throw new Error("Pinned test text is missing");
		return { text, epoch, rev, hash: await hash(text) };
	}
	/** Creates exact binary bytes and returns their confirmed authority. */
	async createBlob(
		path: string,
		bytes: Uint8Array,
		hashValue: string,
		currentEpoch: string,
		key: string,
	) {
		this.createdBlobs.push({
			path,
			bytes: bytes.slice(),
			hash: hashValue,
			epoch: currentEpoch,
			key,
		});
		return {
			status: 201,
			path,
			etag: `"${currentEpoch}.5"`,
			seq: 5,
			size: bytes.byteLength,
			hash: hashValue,
			deleted: false,
		};
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

/** Checks length and every byte without deep object comparisons of large fixtures. */
function expectExactBytes(
	actual: Uint8Array | undefined,
	expected: Uint8Array,
): void {
	expect(actual?.byteLength).toBe(expected.byteLength);
	expect(actual?.every((byte, index) => byte === expected[index])).toBe(true);
}

/** Hashes exact fixture bytes without text conversion. */
async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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

/** Crosses local copy representation, durable step, current kind, rename effects, and interruption after authority or safeguard rebasing. */
const localRecoveryCases = [false, true].flatMap((byteCopies) =>
	(["named", "copied"] as const).flatMap((step) =>
		(["unchanged", "text", "blob", "deleted"] as const).flatMap((kind) =>
			(kind === "unchanged"
				? (["none"] as const)
				: !byteCopies && kind === "blob"
					? (["none", "authority", "safeguards"] as const)
					: (["none", "authority"] as const)
			).flatMap((restartAt) =>
				(!byteCopies && kind === "blob" ? [false, true] : [false]).map(
					(rename) => ({ byteCopies, step, kind, restartAt, rename }),
				),
			),
		),
	),
);

describe("ReconciliationController", () => {
	let context: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		context = await setup();
	});

	it("hydrates newly enabled settings from the manifest after the cursor passed its feed row", async () => {
		const path = ".obsidian/app.json";
		const bytes = new Uint8Array([0, 255, 7]);
		const hashValue = await hashBytes(bytes);
		context.remote.entries = [
			{
				path,
				etag: formatETag(epoch, 2),
				seq: 2,
				hash: hashValue,
				kind: "blob",
				deleted: false,
			},
		];
		context.remote.blobPaths.add(path);
		context.remote.blobs.set(2, bytes.slice());
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const policy = {
			enabled: true,
			appearance: false,
			core: true,
			communityPlugins: false,
		};
		const engine = new TextApplyEngine(
			context.journal,
			context.vault,
			context.remote,
			{ deviceName: "test", settingsPolicy: policy },
		);
		context.controller = new ReconciliationController(
			context.journal,
			engine,
			context.vault,
			context.remote,
			() => false,
			policy,
		);

		await context.controller.reconcile();

		expect(context.vault.binaryFiles.get(path)).toEqual(bytes);
		expect(context.journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: hashValue,
		});
		expect(context.journal.snapshot().cursor).toBe(4);
	});

	it("runs generated AC-13 recovery and reports real controller cleanup failure", async () => {
		const eligiblePaths = [
			"oab-8.8/controlled-one.md",
			"oab-8.8/controlled-two.md",
		];
		const excludedPath = "oab-8.8/ac-31-blob-stat-race-20261104-01.bin";
		const eligibleText = ["first authority", "second authority"];
		const entries = await Promise.all(
			eligiblePaths.map(async (path, index) => {
				const text = eligibleText[index] ?? "";
				const rev = index + 1;
				const contentHash = await hash(text);
				context.vault.files.set(path, text);
				await context.journal.setBase(path, {
					deleted: false,
					rev,
					hash: contentHash,
				});
				return {
					path,
					etag: formatETag(epoch, rev),
					seq: rev,
					hash: contentHash,
					size: new TextEncoder().encode(text).byteLength,
					kind: "text" as const,
					deleted: false,
					large: false,
				};
			}),
		);
		context.vault.binaryFiles.set(excludedPath, new Uint8Array(1_100_003));
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, entries.length);
		await context.journal.setClientId(crypto.randomUUID());
		const manifest = {
			epoch,
			head_seq: entries.length,
			entries,
			next_page: null,
		};
		let manifestReads = 0;
		let authorityReads = 0;
		const requestMethods: string[] = [];
		const transport = new SyncTransport("https://example.test", {
			requestResponse: async (url, options = {}) => {
				requestMethods.push(options.method ?? "GET");
				const parsed = new URL(url);
				if (parsed.pathname === "/v1/manifest") {
					manifestReads += 1;
					return {
						status: 200,
						headers: {},
						text: JSON.stringify(manifest),
					};
				}
				authorityReads += 1;
				return { status: 404, headers: {}, text: "{}" };
			},
		});
		const originalManifest = transport.manifest.bind(transport);
		let currentManifest: typeof originalManifest = originalManifest;
		const controlledPages: Array<ReturnType<typeof ManifestPageSchema.parse>> =
			[];
		Object.defineProperty(transport, "manifest", {
			configurable: true,
			get: () => currentManifest,
			set: (next: typeof originalManifest) => {
				if (next === originalManifest) {
					currentManifest = next;
					return;
				}
				currentManifest = async (token) => {
					const projected = await next.call(transport, token);
					const validated = ManifestPageSchema.parse(projected);
					controlledPages.push(validated);
					return validated;
				};
			},
		});
		const engine = new TextApplyEngine(
			context.journal,
			context.vault,
			transport,
			{ deviceName: "test" },
		);
		const reconciliation = new ReconciliationController(
			context.journal,
			engine,
			context.vault,
			transport,
		);
		let timerHandle = 0;
		const activeIntervals = new Set<number>();
		let controllerCycleFailures = 0;
		let controllerCycleCalls = 0;
		const controllerErrors: unknown[] = [];
		const desktopSync = new DesktopSyncController({
			cycle: async () => {
				controllerCycleCalls += 1;
				if (controllerCycleFailures > 0) {
					controllerCycleFailures -= 1;
					throw new Error("Injected controller cycle failure");
				}
				await reconciliation.reconcile();
			},
			host: {
				setTimeout: () => ++timerHandle,
				clearTimeout: () => undefined,
				setInterval: () => {
					const handle = ++timerHandle;
					activeIntervals.add(handle);
					return handle;
				},
				clearInterval: (handle) => {
					activeIntervals.delete(handle);
				},
			},
			onError: (error) => controllerErrors.push(error),
		});
		const plugin = {
			journal: context.journal,
			composition: {
				publication: { remote: transport },
				reconciliation,
			},
			desktopSync,
			sessionStatus: "connected",
			syncPaused: false,
		};
		const adapter = { getBasePath: () => authorizedVaults()["dev-2"] };
		const app = {
			vault: {
				adapter,
				getFiles: () =>
					[
						...context.vault.files.keys(),
						...context.vault.binaryFiles.keys(),
					].map((path) => ({ path })),
				readBinary: async (file: { path: string }) => {
					const bytes = await context.vault.readBinary(file.path);
					return bytes?.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength,
					);
				},
			},
			plugins: { plugins: { vaultwire: plugin } },
		};
		const scope = {
			excludedPaths: [excludedPath],
			excludedLocalFiles: [{ path: excludedPath, size: 1_100_003 }],
			localOnlyExcludedPaths: [excludedPath],
		};
		const scripts = createAc13CaseScripts(scope);
		const script = createCaseScript("AC-13", scripts.action, scripts.cleanup);
		const output = await (
			new Function("app", `return ${script}`) as (
				app: unknown,
			) => Promise<string>
		)(app);
		const result = JSON.parse(output.slice("OAB8CASE:".length));
		const controlledEpoch = (epoch[0] === "a" ? "b" : "a") + epoch.slice(1);
		expect(result).toMatchObject({
			status: "passed",
			failureReason: null,
			cleanupStatus: "passed",
		});
		expect(result.lastCompletedBoundary).toBe("AC13_READ_ACTUAL_MANIFEST");
		expect(result.caseEvidence.ac13Cleanup).toEqual({
			wrapperRestored: true,
			controllerResumed: true,
		});
		expect(safeCaseResult("AC-13", "controlled", result).ac13Cleanup).toEqual({
			wrapperRestored: true,
			controllerResumed: true,
		});
		expect(controlledPages).toHaveLength(1);
		expect(controlledPages[0]?.epoch).toBe(controlledEpoch);
		for (const [index, entry] of (
			controlledPages[0]?.entries ?? []
		).entries()) {
			const identity = parseETag(entry.etag);
			expect(identity).toEqual({ epoch: controlledEpoch, rev: index + 1 });
			expect(entry.etag).toBe(formatETag(controlledEpoch, index + 1));
		}
		expect(manifestReads).toBeGreaterThan(2);
		expect(authorityReads).toBe(1);
		expect(requestMethods.every((method) => method === "GET")).toBe(true);
		expect(context.journal.snapshot().epoch).toBe(epoch);
		expect(context.journal.snapshot().cursor).toBe(entries.length);
		expect(currentManifest).toBe(originalManifest);
		expect(desktopSync.resume).toBe(DesktopSyncController.prototype.resume);
		expect(desktopSync.isBusy).toBe(false);
		expect(controllerCycleCalls).toBe(1);
		expect(activeIntervals.size).toBe(1);
		expect(globalThis).not.toHaveProperty("__oab8Ac13Restore");
		expect(result.caseEvidence.ac13PrecaseFiles.eligible).toHaveLength(2);
		expect(result.caseEvidence.ac13PrecaseFiles.excluded).toHaveLength(1);
		controllerCycleFailures = 2;
		const resumeFailureOutput = await (
			new Function("app", `return ${script}`) as (
				app: unknown,
			) => Promise<string>
		)(app);
		const resumeFailure = JSON.parse(
			resumeFailureOutput.slice("OAB8CASE:".length),
		);
		expect(resumeFailure.status).toBe("failed");
		expect(resumeFailure.failureStage).toBe("action");
		expect(resumeFailure.cleanupStatus).toBe("failed");
		expect(resumeFailure.caseEvidence.ac13Cleanup).toEqual({
			wrapperRestored: true,
			controllerResumed: false,
		});
		const safeResumeFailure = safeCaseResult(
			"AC-13",
			"controlled",
			resumeFailure,
		);
		expect(safeResumeFailure.ac13Cleanup).toEqual({
			wrapperRestored: true,
			controllerResumed: false,
		});
		expect(safeResumeFailure).not.toHaveProperty("caseEvidence");
		expect(currentManifest).toBe(originalManifest);
		expect(globalThis).not.toHaveProperty("__oab8Ac13Restore");
		await desktopSync.waitForIdle();
		expect(desktopSync.isBusy).toBe(false);
		expect(controllerCycleCalls).toBe(3);
		expect(controllerCycleFailures).toBe(0);
		expect(controllerErrors).toHaveLength(2);
		expect(activeIntervals.size).toBe(1);
		await desktopSync.syncNow();
		expect(controllerCycleCalls).toBe(4);
		expect(desktopSync.isBusy).toBe(false);
		expect(activeIntervals.size).toBe(1);
		expect(context.journal.snapshot().epoch).toBe(epoch);
		expect(context.journal.snapshot().cursor).toBe(entries.length);
		expect(context.vault.writes).toBe(0);
		const originalState = context.journal.snapshot();
		const firstEntry = manifest.entries[0];
		if (!firstEntry) throw new Error("Manifest test row is missing");
		for (const invalidTag of [
			"not-an-etag",
			`W/${formatETag(epoch, 1)}`,
			`"${"b".repeat(32)}.1"`,
			`"${epoch}.0"`,
		]) {
			firstEntry.etag = invalidTag;
			const invalidOutput = await (
				new Function("app", `return ${script}`) as (
					app: unknown,
				) => Promise<string>
			)(app);
			const invalidResult = JSON.parse(invalidOutput.slice("OAB8CASE:".length));
			expect(invalidResult.status).toBe("failed");
			expect(invalidResult.cleanupStatus).toBe("passed");
			expect(plugin.syncPaused).toBe(false);
			expect(context.journal.snapshot()).toEqual(originalState);
			expect(context.vault.writes).toBe(0);
		}
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

	it("preserves pending identity and attention during same-epoch reconciliation", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const pending = await context.journal.enqueue(
			{
				op: "put",
				path: "same-epoch-pending.md",
				precondition: { kind: "absent" },
			},
			new TextEncoder().encode("pending payload"),
		);
		await context.journal.recordAttention("same-epoch-attention.md", "Keep me");
		const before = context.journal.snapshot();

		await context.controller.reconcile();

		const after = context.journal.snapshot();
		expect(after.epoch).toBe(before.epoch);
		expect(after.cursor).toBe(4);
		expect(after.pending_ops).toEqual([pending]);
		expect(after.attention).toEqual(before.attention);
		expect(after.pending_apply).toEqual(before.pending_apply);
	});

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

	it("classifies multiple deletes from one paginated manifest per replay", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const text = "inline text to delete";
		const bytes = new Uint8Array([0, 255, 128]);
		context.vault.files.set("delete-text.md", text);
		context.vault.binaryFiles.set("assets/delete-photo.png", bytes);
		context.vault.binaryFiles.set(
			"assets/oversized.png",
			new Uint8Array([1, 2, 3]),
		);
		context.vault.fileSizes.set("assets/oversized.png", 25_000_001);
		for (const [path, rev, hashValue] of [
			["delete-text.md", 5, await hash(text)],
			["assets/delete-photo.png", 6, await hashBytes(bytes)],
			["assets/oversized.png", 7, await hash("oversized remote base")],
		] as const) {
			await context.journal.setBase(path, {
				deleted: false,
				rev,
				hash: hashValue,
			});
		}
		context.remote.pages.set(null, {
			epoch,
			head_seq: 10,
			entries: [
				{
					path: "delete-text.md",
					etag: `"${epoch}.8"`,
					seq: 8,
					hash: "",
					kind: "text",
					deleted: true,
				},
			],
			next_page: "second",
		});
		context.remote.pages.set("second", {
			epoch,
			head_seq: 10,
			entries: [
				{
					path: "assets/delete-photo.png",
					etag: `"${epoch}.9"`,
					seq: 9,
					hash: "",
					kind: "blob",
					deleted: true,
				},
				{
					path: "assets/oversized.png",
					etag: `"${epoch}.10"`,
					seq: 10,
					hash: "",
					kind: "blob",
					deleted: true,
				},
			],
			next_page: null,
		});
		context.remote.feed.push({
			epoch,
			head_seq: 10,
			entries: [
				{
					seq: 8,
					op: "delete",
					path: "delete-text.md",
					etag: `"${epoch}.8"`,
					hash: "",
					origin: "remote",
					at: 8,
				},
				{
					seq: 9,
					op: "delete",
					path: "assets/delete-photo.png",
					etag: `"${epoch}.9"`,
					hash: "",
					origin: "remote",
					at: 9,
				},
				{
					seq: 10,
					op: "delete",
					path: "assets/oversized.png",
					etag: `"${epoch}.10"`,
					hash: "",
					origin: "remote",
					at: 10,
				},
			],
		});

		await context.controller.replay();

		expect(context.remote.manifestCalls).toEqual([null, "second"]);
		expect(context.vault.files.has("delete-text.md")).toBe(false);
		expect(context.vault.binaryFiles.has("assets/delete-photo.png")).toBe(
			false,
		);
		expect(context.vault.binaryFiles.get("assets/oversized.png")).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(context.journal.snapshot().base["assets/delete-photo.png"]).toEqual({
			deleted: true,
			rev: 9,
		});
		expect(context.journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path: "assets/oversized.png" }),
		);
		expect(context.journal.snapshot().cursor).toBe(10);
	});

	it("ignores obsolete deletes before reading manifest authority", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const newer = "newer confirmed version";
		context.vault.files.set("recreated.md", newer);
		await context.journal.setBase("recreated.md", {
			deleted: false,
			rev: 9,
			hash: await hash(newer),
		});
		context.remote.feed.push({
			epoch,
			head_seq: 8,
			entries: [
				{
					seq: 8,
					op: "delete",
					path: "recreated.md",
					etag: `"${epoch}.8"`,
					hash: "",
					origin: "remote",
					at: 8,
				},
			],
		});

		await context.controller.replay();

		expect(context.remote.manifestCalls).toEqual([]);
		expect(context.vault.files.get("recreated.md")).toBe(newer);
		expect(context.journal.snapshot().base.recreated).toBeUndefined();
		expect(context.journal.snapshot().base["recreated.md"]?.rev).toBe(9);
		expect(context.journal.snapshot().attention).toEqual([]);
		expect(context.journal.snapshot().cursor).toBe(8);
	});

	it("does not apply an older delete after the manifest confirms a recreate", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const recreated = "new confirmed content";
		context.vault.files.set("recreate-after-delete.md", recreated);
		await context.journal.setBase("recreate-after-delete.md", {
			deleted: false,
			rev: 5,
			hash: await hash(recreated),
		});
		context.remote.pages.set(null, {
			epoch,
			head_seq: 7,
			entries: [
				{
					path: "recreate-after-delete.md",
					etag: `"${epoch}.7"`,
					seq: 7,
					hash: await hash(recreated),
					kind: "text",
					deleted: false,
				},
			],
			next_page: null,
		});
		const recreatedHash = await hash(recreated);
		context.remote.texts.set("7", recreated);
		context.remote.feed.push({
			epoch,
			head_seq: 7,
			entries: [
				{
					seq: 6,
					op: "delete",
					path: "recreate-after-delete.md",
					etag: `"${epoch}.6"`,
					hash: "",
					origin: "remote",
					at: 6,
				},
				{
					seq: 7,
					op: "put",
					path: "recreate-after-delete.md",
					etag: `"${epoch}.7"`,
					hash: recreatedHash,
					origin: "remote",
					at: 7,
				},
			],
		});

		await context.controller.replay();

		expect(context.vault.files.get("recreate-after-delete.md")).toBe(recreated);
		expect(context.journal.snapshot().base["recreate-after-delete.md"]).toEqual(
			{
				deleted: false,
				rev: 7,
				hash: recreatedHash,
			},
		);
		expect(context.journal.snapshot().attention).toEqual([]);
		expect(context.journal.snapshot().cursor).toBe(7);
	});

	it("does not reuse manifest classification across replay calls", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		const text = "first confirmed delete";
		context.vault.files.set("replayed.md", text);
		await context.journal.setBase("replayed.md", {
			deleted: false,
			rev: 5,
			hash: await hash(text),
		});
		const firstRow = {
			path: "replayed.md",
			etag: `"${epoch}.6"`,
			seq: 6,
			hash: "",
			kind: "text" as const,
			deleted: true,
		};
		context.remote.pages.set(null, {
			epoch,
			head_seq: 6,
			entries: [firstRow],
			next_page: null,
		});
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 6,
					op: "delete",
					path: "replayed.md",
					etag: firstRow.etag,
					hash: "",
					origin: "remote",
					at: 6,
				},
			],
		});
		await context.controller.replay();

		await context.journal.setCursor(epoch, 6);
		const secondRow = { ...firstRow, etag: `"${epoch}.7"`, seq: 7 };
		context.remote.pages.set(null, {
			epoch,
			head_seq: 7,
			entries: [secondRow],
			next_page: null,
		});
		context.remote.feed.push({
			epoch,
			head_seq: 7,
			entries: [
				{
					seq: 7,
					op: "delete",
					path: "replayed.md",
					etag: secondRow.etag,
					hash: "",
					origin: "remote",
					at: 7,
				},
			],
		});
		await context.controller.replay();

		expect(context.remote.manifestCalls).toEqual([null, null]);
		expect(context.journal.snapshot().base["replayed.md"]).toEqual({
			deleted: true,
			rev: 7,
		});
	});

	it("keeps a local file when manifest authority is missing for a delete", async () => {
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 4);
		context.vault.files.set("unconfirmed-delete.md", "keep until confirmed");
		await context.journal.setBase("unconfirmed-delete.md", {
			deleted: false,
			rev: 5,
			hash: await hash("keep until confirmed"),
		});
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 6,
					op: "delete",
					path: "unconfirmed-delete.md",
					etag: `"${epoch}.6"`,
					hash: "",
					origin: "remote",
					at: 6,
				},
			],
		});

		await context.controller.replay();

		expect(context.remote.manifestCalls).toEqual([null]);
		expect(context.vault.files.get("unconfirmed-delete.md")).toBe(
			"keep until confirmed",
		);
		expect(context.journal.snapshot().base["unconfirmed-delete.md"]?.rev).toBe(
			5,
		);
		expect(context.journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path: "unconfirmed-delete.md" }),
		);
		expect(context.journal.snapshot().cursor).toBe(6);
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

	it("publishes exact local attachment bytes during enrollment", async () => {
		const bytes = new Uint8Array([0, 255, 128]);
		context.vault.binaryFiles.set("assets/local.png", bytes.slice());

		await context.controller.enroll();

		expect(context.remote.createdBlobs).toHaveLength(1);
		expect(context.remote.createdBlobs[0]?.bytes).toEqual(bytes);
		expect(context.journal.snapshot().base["assets/local.png"]).toEqual({
			deleted: false,
			rev: 5,
			hash: await hashBytes(bytes),
		});
		expect(context.journal.snapshot().pending_ops).toEqual([]);
	});

	it("uses one durable observation time for a hydration conflict across restart", async () => {
		const path = "notes/hydration-conflict.md";
		const localText = "local edits";
		const remoteText = "confirmed remote bytes";
		const remoteHash = await hash(remoteText);
		const observedAt = Date.UTC(2026, 10, 4, 12, 34);
		let now = observedAt;
		context.vault.files.set(path, localText);
		context.remote.entries = [
			{
				path,
				etag: formatETag(epoch, 2),
				seq: 2,
				hash: remoteHash,
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", remoteText);
		const stopAfterCopy = context.journal.updateApply.bind(context.journal);
		context.journal.updateApply = async (pending) => {
			await stopAfterCopy(pending);
			if (pending.step === "copied")
				throw new Error("stop after conflict copy");
		};
		const engine = new TextApplyEngine(
			context.journal,
			context.vault,
			context.remote,
			{ deviceName: "test", now: () => now },
		);
		context.controller = new ReconciliationController(
			context.journal,
			engine,
			context.vault,
			context.remote,
		);

		await expect(context.controller.enroll()).rejects.toThrow(
			"stop after conflict copy",
		);

		const pending = context.journal.snapshot().pending_apply[0];
		if (!pending) throw new Error("Expected durable conflict recovery");
		const namedPath = pending.conflict_copies?.[0]?.path;
		expect(pending.change.at).toBe(observedAt);
		expect(namedPath).toContain("2026-11-04 1234");
		expect(namedPath).not.toContain("1970");
		expect(context.vault.files.get(namedPath ?? "")).toBe(localText);

		engine.close();
		context.journal.close();
		now = Date.UTC(2030, 0, 1);
		context.journal = await DeviceJournal.open(context.storage);
		const restartedEngine = new TextApplyEngine(
			context.journal,
			context.vault,
			context.remote,
			{ deviceName: "test", now: () => now },
		);
		context.controller = new ReconciliationController(
			context.journal,
			restartedEngine,
			context.vault,
			context.remote,
		);

		await context.controller.resume();

		expect(context.vault.files.get(path)).toBe(remoteText);
		expect(context.vault.files.get(namedPath ?? "")).toBe(localText);
		expect(
			(await context.vault.list()).filter((file) => file.includes("(conflict")),
		).toEqual([namedPath]);
		expect(context.journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
		expect(context.journal.snapshot().pending_apply).toEqual([]);
	});

	it("hydrates exact binary bytes from a manifest blob row", async () => {
		const bytes = new Uint8Array([0, 255, 128]);
		const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
		const hashValue = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		context.remote.entries = [
			{
				path: "assets/photo.png",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: hashValue,
				kind: "blob",
				deleted: false,
			},
		];
		context.remote.blobPaths.add("assets/photo.png");
		context.remote.blobs.set(2, bytes);

		await context.controller.reconcile();

		expect(context.vault.binaryFiles.get("assets/photo.png")).toEqual(bytes);
		expect(context.journal.snapshot().base["assets/photo.png"]).toEqual({
			deleted: false,
			rev: 2,
			hash: hashValue,
		});
		expect(context.journal.snapshot().attention).not.toContainEqual(
			expect.objectContaining({ path: "assets/photo.png" }),
		);
	});

	it("hydrates inline manifest authority after exact invalid-byte Markdown preservation", async () => {
		const path = "notes/invalid-manifest.md";
		const local = new Uint8Array(1_000_001).fill(0x61);
		local.set([0xc3, 0x28]);
		const localHash = await hashBytes(local);
		const remoteText = "manifest inline text";
		const remoteHash = await hash(remoteText);
		context.vault.binaryFiles.set(path, local.slice());
		context.vault.read = async (source) => {
			context.vault.reads.push(source);
			const bytes = context.vault.binaryFiles.get(source);
			return bytes
				? new TextDecoder().decode(bytes)
				: (context.vault.files.get(source) ?? null);
		};
		context.remote.entries = [
			{
				path,
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: remoteHash,
				kind: "text",
				deleted: false,
			},
		];
		context.remote.texts.set("2", remoteText);

		await context.controller.reconcile();

		const conflicts = [...context.vault.binaryFiles.entries()].filter(
			([copyPath]) => copyPath.includes("(conflict test"),
		);
		expect(conflicts).toHaveLength(1);
		expectExactBytes(conflicts[0]?.[1], local);
		expectExactBytes(
			context.vault.binaryFiles.get(`.ai-bridge/pre-apply/${localHash}`),
			local,
		);
		expect(context.vault.binaryFiles.has(path)).toBe(false);
		expect(context.vault.files.get(path)).toBe(remoteText);
		expect(context.journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
		expect(context.journal.snapshot().pending_apply).toEqual([]);
		expect(context.journal.snapshot().cursor).toBe(4);
	});

	it.each([false, true])(
		"resumes copied blob-to-inline work after pruning and continues the feed (restart after rebase=%s)",
		async (restartAfterRebase) => {
			const path = "notes/pruned-inline.md";
			const local = new Uint8Array(1_000_001).fill(0x61);
			local.set([0xff, 0x00]);
			const localHash = await hashBytes(local);
			const oldText = "old inline authority";
			const currentText = "newer inline authority";
			const oldHash = await hash(oldText);
			const currentHash = await hash(currentText);
			const following = "feed continues after inline recovery";
			const row = {
				seq: 5,
				op: "put" as const,
				path,
				etag: `"${epoch}.2"`,
				hash: oldHash,
				origin: "remote",
				at: 5,
			};
			await context.journal.resetEpoch(epoch);
			await context.journal.setCursor(epoch, 4);
			await context.journal.setBase(path, {
				deleted: false,
				rev: 1,
				hash: localHash,
			});
			context.vault.binaryFiles.set(path, local.slice());
			Object.assign(context.remote, {
				readResolvedBlob: async () => ({
					kind: "text" as const,
					text: oldText,
					epoch,
					rev: 2,
					hash: oldHash,
				}),
			});
			context.remote.texts.set("2", oldText);
			context.remote.feed.push({ epoch, head_seq: 5, entries: [row] });
			const updateApply = context.journal.updateApply.bind(context.journal);
			context.journal.updateApply = async (pending) => {
				await updateApply(pending);
				if (pending.step === "copied")
					throw new Error("stop after durable copies");
			};

			await expect(context.controller.replay()).rejects.toThrow(
				"stop after durable copies",
			);
			const copied = context.journal.snapshot().pending_apply[0];
			expect(copied).toMatchObject({ step: "copied", content_kind: "text" });
			const copies = copied?.conflict_copies;
			expect(copies).toHaveLength(2);
			for (const copy of copies ?? [])
				expectExactBytes(context.vault.binaryFiles.get(copy.path), local);
			expect(context.journal.snapshot().base[path]?.rev).toBe(1);
			expect(context.journal.snapshot().cursor).toBe(4);

			context = await reopen(context);
			context.remote.readResolved = async (source, requestEpoch, rev) => {
				if (source === path)
					return {
						text: currentText,
						epoch: requestEpoch,
						rev: 3,
						hash: currentHash,
					};
				const text = context.remote.texts.get(String(rev));
				if (text === undefined) throw new Error("Missing following text");
				return { text, epoch: requestEpoch, rev, hash: await hash(text) };
			};
			Object.assign(context.remote, {
				readResolvedBlob: async () => ({
					kind: "text" as const,
					text: currentText,
					epoch,
					rev: 3,
					hash: currentHash,
				}),
			});
			if (restartAfterRebase) {
				const rebase = context.journal.rebasePendingApply.bind(context.journal);
				context.journal.rebasePendingApply = async (change, plans) => {
					await rebase(change, plans);
					throw new Error("stop after durable rebase");
				};
				await expect(context.controller.resume()).rejects.toThrow(
					"stop after durable rebase",
				);
				expect(context.journal.snapshot().pending_apply[0]).toMatchObject({
					content_kind: "text",
					conflict_copies: copies,
					change: { etag: `"${epoch}.3"`, hash: currentHash },
				});
				context = await reopen(context);
			}
			context.remote.texts.set("6", following);
			context.remote.feed.push({
				epoch,
				head_seq: 6,
				entries: [
					row,
					{
						seq: 6,
						op: "put",
						path: "after-inline-recovery.md",
						etag: `"${epoch}.6"`,
						hash: await hash(following),
						origin: "remote",
						at: 6,
					},
				],
			});
			await context.controller.resume();
			await context.controller.resume();

			for (const copy of copies ?? [])
				expectExactBytes(context.vault.binaryFiles.get(copy.path), local);
			expect(
				[...context.vault.binaryFiles.keys()].filter((name) =>
					name.includes("conflict"),
				),
			).toHaveLength(1);
			expect(context.vault.binaryFiles.has(path)).toBe(false);
			expect(context.vault.files.get(path)).toBe(currentText);
			expect(context.vault.files.get("after-inline-recovery.md")).toBe(
				following,
			);
			expect(context.journal.snapshot().base[path]).toEqual({
				deleted: false,
				rev: 3,
				hash: currentHash,
			});
			expect(context.journal.snapshot().cursor).toBe(6);
			expect(context.journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it.each(localRecoveryCases)(
		"resumes local recovery bytes=$byteCopies step=$step kind=$kind restart=$restartAt rename=$rename",
		async ({ byteCopies, step, kind, restartAt, rename }) => {
			const path = "notes/local-recovery-matrix.md";
			const source = "notes/local-recovery-source.md";
			const sourceText = "dirty local rename source";
			const oldText = "original inline authority";
			const oldHash = await hash(oldText);
			const localText = "\uFEFFdirty local\r\ntext";
			const local = byteCopies
				? new Uint8Array(1_000_001).fill(0x61)
				: new TextEncoder().encode(localText);
			if (byteCopies) local.set([0xff, 0x28]);
			const localHash = await hashBytes(local);
			const currentText =
				kind === "unchanged" ? oldText : "newer inline authority";
			const currentBlob = new Uint8Array(1_000_002).fill(0x62);
			currentBlob.set([0xc3, 0x28]);
			const currentHash =
				kind === "deleted"
					? ""
					: kind === "blob"
						? await hashBytes(currentBlob)
						: await hash(currentText);
			const revision = kind === "unchanged" ? 2 : 3;
			const followingPath = "after-local-recovery.md";
			const following = "later feed content";
			const followingHash = await hash(following);
			let restarted = false;
			const transport = new SyncTransport("https://service.test", {
				requestResponse: async (url): Promise<OAuthTransportResponse> => {
					const request = new URL(url);
					const isFollowing = request.pathname.endsWith(followingPath);
					if (
						restarted &&
						!isFollowing &&
						kind !== "unchanged" &&
						request.searchParams.get("rev") === "2"
					) {
						return {
							status: 410,
							headers: {},
							text: JSON.stringify({
								error: "revision_pruned",
								message: "This revision is no longer available.",
							}),
						};
					}
					if (restarted && !isFollowing && kind === "blob")
						return {
							status: 200,
							headers: {
								etag: `"${epoch}.3"`,
								"content-type": "application/octet-stream",
								"content-length": String(currentBlob.byteLength),
							},
							text: "",
							arrayBuffer: currentBlob.slice().buffer,
						};
					const deleted = restarted && !isFollowing && kind === "deleted";
					const text = isFollowing
						? following
						: restarted
							? currentText
							: oldText;
					const etag = `"${epoch}.${isFollowing ? 6 : restarted ? revision : 2}"`;
					return {
						status: 200,
						headers: { etag, "content-type": "application/json" },
						text: JSON.stringify({
							path: isFollowing ? followingPath : path,
							etag,
							hash: deleted
								? ""
								: isFollowing
									? followingHash
									: restarted
										? currentHash
										: oldHash,
							size: deleted ? 0 : new TextEncoder().encode(text).byteLength,
							kind: "text",
							deleted,
							origin: "remote",
							updated_at: 5,
							content: deleted ? null : text,
							offset: 0,
							length: deleted ? 0 : text.length,
							truncated: false,
						}),
					};
				},
			});
			await context.journal.resetEpoch(epoch);
			await context.journal.setCursor(epoch, 4);
			await context.journal.setBase(path, {
				deleted: false,
				rev: 1,
				hash: await hash("confirmed base"),
			});
			if (byteCopies) context.vault.binaryFiles.set(path, local.slice());
			else context.vault.files.set(path, localText);
			if (rename) {
				context.vault.files.set(source, sourceText);
				await context.journal.setBase(source, {
					deleted: false,
					rev: 1,
					hash: await hash("confirmed source"),
				});
			}
			const update = context.journal.updateApply.bind(context.journal);
			context.journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step)
					throw new Error("stop at local recovery step");
			};
			let engine = new TextApplyEngine(
				context.journal,
				context.vault,
				transport,
				{ deviceName: "test" },
			);
			const row = {
				seq: 5,
				...(rename
					? {
							op: "rename" as const,
							from_path: source,
							from_etag: `"${epoch}.2"`,
						}
					: { op: "put" as const }),
				path,
				etag: `"${epoch}.2"`,
				hash: oldHash,
				origin: "remote",
				at: 5,
			};
			await expect(engine.apply(row)).rejects.toThrow(
				"stop at local recovery step",
			);
			expectExactBytes(
				(await context.vault.readBinary(path)) ?? undefined,
				local,
			);
			expect(context.journal.snapshot().base[path]?.rev).toBe(1);
			expect(context.journal.snapshot().cursor).toBe(4);
			const copies: PendingConflictCopy[] =
				context.journal.snapshot().pending_apply[0]?.conflict_copies ?? [];
			const visibleCopies = copies.filter(
				(copy) => copy.purpose !== "pre_apply",
			);
			const visible = visibleCopies.find((copy) => copy.source === path);
			if (!visible) throw new Error("Missing visible local copy plan");
			expect(visible.hash).toBe(localHash);
			engine.close();
			context.journal.close();
			restarted = true;
			context = {
				...context,
				journal: await DeviceJournal.open(context.storage),
			};
			engine = new TextApplyEngine(context.journal, context.vault, transport, {
				deviceName: "test",
			});
			if (restartAt !== "none") {
				const rebase = context.journal.rebasePendingApply.bind(context.journal);
				context.journal.rebasePendingApply = async (change, plans) => {
					await rebase(change, plans);
					if (
						restartAt === "authority" ||
						plans?.some((copy) => copy.purpose === "pre_apply")
					)
						throw new Error("stop after durable local rebase");
				};
				await expect(engine.resume()).rejects.toThrow(
					"stop after durable local rebase",
				);
				const saved = context.journal.snapshot().pending_apply[0];
				if (restartAt === "authority")
					expect(saved?.conflict_copies).toEqual(copies);
				else {
					expect(saved?.step).toBe("named");
					expect(saved?.conflict_copies).toContainEqual(
						expect.objectContaining(visible),
					);
					expect(saved?.conflict_copies).toContainEqual(
						expect.objectContaining({
							path: `.ai-bridge/pre-apply/${localHash}`,
							hash: localHash,
							kind: "blob",
							purpose: "pre_apply",
						}),
					);
				}
				expect(context.journal.snapshot().base[path]?.rev).toBe(1);
				engine.close();
				context.journal.close();
				context = {
					...context,
					journal: await DeviceJournal.open(context.storage),
				};
				engine = new TextApplyEngine(
					context.journal,
					context.vault,
					transport,
					{ deviceName: "test" },
				);
			}
			const events: string[] = [];
			let readbackBeforeBase = false;
			const read = context.vault.readBinary.bind(context.vault);
			context.vault.readBinary = async (source) => {
				const bytes = await read(source);
				if (source === path) {
					events.push("read");
					if (events.includes("write") && !readbackBeforeBase) {
						expect(context.journal.snapshot().base[path]?.rev).toBe(1);
						expectExactBytes(bytes ?? undefined, currentBlob);
						readbackBeforeBase = true;
					}
				}
				return bytes;
			};
			context.vault.stat = async (source) => {
				if (source === path) events.push("stat");
				const bytes = await context.vault.readBinary(source);
				return bytes ? { mtime: 1, size: bytes.byteLength } : null;
			};
			const modify = context.vault.modifyBinary.bind(context.vault);
			context.vault.modifyBinary = async (source, bytes) => {
				if (source === path) {
					expectExactBytes(
						(await context.vault.readBinary(visible.path)) ?? undefined,
						local,
					);
					expectExactBytes(
						(await context.vault.readBinary(
							`.ai-bridge/pre-apply/${localHash}`,
						)) ?? undefined,
						local,
					);
					expect(
						events.filter((event) => event === "stat").length,
					).toBeGreaterThanOrEqual(2);
					expect(
						context.journal.snapshot().pending_apply[0]?.conflict_copies,
					).toContainEqual(expect.objectContaining(visible));
					expect(context.journal.snapshot().base[path]?.rev).toBe(1);
					events.push("write");
				}
				return modify(source, bytes);
			};
			context.controller = new ReconciliationController(
				context.journal,
				engine,
				context.vault,
				context.remote,
			);
			context.remote.feed.push({
				epoch,
				head_seq: 6,
				entries: [
					row,
					{
						seq: 6,
						op: "put",
						path: followingPath,
						etag: `"${epoch}.6"`,
						hash: followingHash,
						origin: "remote",
						at: 6,
					},
				],
			});
			await context.controller.resume();
			await engine.resume();
			await context.controller.resume();

			expectExactBytes(
				(await context.vault.readBinary(visible.path)) ?? undefined,
				local,
			);
			expect(
				(await context.vault.list()).filter((source) =>
					source.includes("conflict"),
				),
			).toHaveLength(visibleCopies.length);
			for (const copy of visibleCopies) {
				expectExactBytes(
					(await context.vault.readBinary(copy.path)) ?? undefined,
					copy.source === path ? local : new TextEncoder().encode(sourceText),
				);
			}
			if (rename) {
				expect(await context.vault.readBinary(source)).toBeNull();
				expect(context.journal.snapshot().base[source]).toEqual({
					deleted: true,
					rev: 2,
				});
			}
			if (kind === "deleted") {
				expect(await context.vault.readBinary(path)).toBeNull();
				expect(context.journal.snapshot().base[path]).toEqual({
					deleted: true,
					rev: revision,
				});
			} else {
				expectExactBytes(
					(await context.vault.readBinary(path)) ?? undefined,
					kind === "blob" ? currentBlob : new TextEncoder().encode(currentText),
				);
				expect(context.journal.snapshot().base[path]).toEqual({
					deleted: false,
					rev: revision,
					hash: currentHash,
				});
			}
			if (kind === "blob") {
				expect(readbackBeforeBase).toBe(true);
				expect(events).toContain("write");
				expect(events.slice(events.indexOf("write") + 1)).toContain("read");
				expectExactBytes(
					(await context.vault.readBinary(
						`.ai-bridge/pre-apply/${localHash}`,
					)) ?? undefined,
					local,
				);
			}
			expect(context.vault.files.get(followingPath)).toBe(following);
			expect(context.journal.snapshot().pending_apply).toEqual([]);
			expect(context.journal.snapshot().cursor).toBe(6);
			expect(
				context.journal
					.snapshot()
					.attention.some((item: { reason: string }) =>
						item.reason.includes("not available"),
					),
			).toBe(false);
		},
	);

	it.each([false, true])(
		"keeps copied recovery through pruned inline authority becoming a blob (restart after rebase=%s)",
		async (restartAfterRebase) => {
			const path = "notes/inline-to-blob-recovery.md";
			const local = new Uint8Array(1_000_001).fill(0x61);
			local.set([0xff, 0x28]);
			const localHash = await hashBytes(local);
			const oldText = "old inline target";
			const oldHash = await hash(oldText);
			const current = new Uint8Array(1_000_002).fill(0x62);
			current.set([0xc3, 0x28]);
			const currentHash = await hashBytes(current);
			const following = "later feed text";
			const followingPath = "after-kind-recovery.md";
			const followingHash = await hash(following);
			let pruned = false;
			const transport = new SyncTransport("https://service.test", {
				requestResponse: async (url): Promise<OAuthTransportResponse> => {
					const request = new URL(url);
					if (pruned && request.pathname.endsWith(path)) {
						if (request.searchParams.get("rev") === "2")
							return {
								status: 410,
								headers: {},
								text: JSON.stringify({
									error: "revision_pruned",
									message: "This revision is no longer available.",
								}),
							};
						return {
							status: 200,
							headers: {
								etag: `"${epoch}.3"`,
								"content-type": "application/octet-stream",
								"content-length": String(current.byteLength),
							},
							text: "",
							arrayBuffer: current.slice().buffer,
						};
					}
					const isFollowing = request.pathname.endsWith(followingPath);
					const text = isFollowing ? following : oldText;
					const etag = `"${epoch}.${isFollowing ? 6 : 2}"`;
					return {
						status: 200,
						headers: { etag, "content-type": "application/json" },
						text: JSON.stringify({
							path: isFollowing ? followingPath : path,
							etag,
							hash: isFollowing ? followingHash : oldHash,
							size: new TextEncoder().encode(text).byteLength,
							kind: "text",
							deleted: false,
							origin: "remote",
							updated_at: 5,
							content: text,
							offset: 0,
							length: text.length,
							truncated: false,
						}),
					};
				},
			});
			await context.journal.resetEpoch(epoch);
			await context.journal.setCursor(epoch, 4);
			await context.journal.setBase(path, {
				deleted: false,
				rev: 1,
				hash: localHash,
			});
			context.vault.binaryFiles.set(path, local.slice());
			const update = context.journal.updateApply.bind(context.journal);
			context.journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === "copied")
					throw new Error("stop after kind-change copies");
			};
			const engine = new TextApplyEngine(
				context.journal,
				context.vault,
				transport,
				{ deviceName: "test" },
			);
			const row = {
				seq: 5,
				op: "put" as const,
				path,
				etag: `"${epoch}.2"`,
				hash: oldHash,
				origin: "remote",
				at: 5,
			};
			await expect(engine.apply(row)).rejects.toThrow(
				"stop after kind-change copies",
			);
			const copies =
				context.journal.snapshot().pending_apply[0]?.conflict_copies;
			expect(copies).toHaveLength(2);
			engine.close();
			context.journal.close();
			pruned = true;
			context = {
				...context,
				journal: await DeviceJournal.open(context.storage),
			};
			let resumed = new TextApplyEngine(
				context.journal,
				context.vault,
				transport,
				{ deviceName: "test" },
			);
			if (restartAfterRebase) {
				const rebase = context.journal.rebasePendingApply.bind(context.journal);
				context.journal.rebasePendingApply = async (change, plans) => {
					await rebase(change, plans);
					throw new Error("stop after blob authority rebase");
				};
				await expect(resumed.resume()).rejects.toThrow(
					"stop after blob authority rebase",
				);
				expect(
					context.journal.snapshot().pending_apply[0]?.conflict_copies,
				).toEqual(copies);
				resumed.close();
				context.journal.close();
				context = {
					...context,
					journal: await DeviceJournal.open(context.storage),
				};
				resumed = new TextApplyEngine(
					context.journal,
					context.vault,
					transport,
					{ deviceName: "test" },
				);
			}
			context.controller = new ReconciliationController(
				context.journal,
				resumed,
				context.vault,
				context.remote,
			);
			context.remote.feed.push({
				epoch,
				head_seq: 6,
				entries: [
					row,
					{
						seq: 6,
						op: "put",
						path: followingPath,
						etag: `"${epoch}.6"`,
						hash: followingHash,
						origin: "remote",
						at: 6,
					},
				],
			});
			await context.controller.resume();
			await resumed.resume();
			await context.controller.resume();

			for (const copy of copies ?? [])
				expectExactBytes(context.vault.binaryFiles.get(copy.path), local);
			expect(
				[...context.vault.binaryFiles.keys()].filter((copyPath) =>
					copyPath.includes("conflict"),
				),
			).toHaveLength(1);
			expectExactBytes(context.vault.binaryFiles.get(path), current);
			expect(context.vault.files.get(followingPath)).toBe(following);
			expect(context.journal.snapshot().base[path]).toEqual({
				deleted: false,
				rev: 3,
				hash: currentHash,
			});
			expect(context.journal.snapshot().pending_apply).toEqual([]);
			expect(context.journal.snapshot().cursor).toBe(6);
			expect(
				context.journal
					.snapshot()
					.attention.some((item: { reason: string }) =>
						item.reason.includes("not available"),
					),
			).toBe(false);
		},
	);

	it("preserves dirty binary bytes and applies a manifest tombstone", async () => {
		const localBytes = new Uint8Array([0, 255, 3]);
		context.vault.binaryFiles.set("assets/old.pdf", localBytes);
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
		expect(context.vault.binaryFiles.has("assets/old.pdf")).toBe(false);
		expect(
			[...context.vault.binaryFiles.entries()].some(
				([path, bytes]) =>
					path.includes("conflict") &&
					bytes.every((byte, index) => byte === localBytes[index]),
			),
		).toBe(true);
		expect(context.journal.snapshot().base["assets/old.pdf"]).toMatchObject({
			deleted: true,
			rev: 2,
		});
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "assets/old.pdf",
			reason: "Local binary bytes were preserved as a conflict copy",
		});
	});

	it("preserves dirty binary bytes and applies an authoritative feed tombstone", async () => {
		const localBytes = new Uint8Array([1, 2, 255]);
		context.vault.binaryFiles.set("assets/file.pdf", localBytes);
		await context.controller.enroll();
		const editedBytes = new Uint8Array([7, 8, 9]);
		context.vault.binaryFiles.set("assets/file.pdf", editedBytes);
		context.remote.entries = [
			{
				path: "assets/file.pdf",
				etag: `"${epoch}.6"`,
				seq: 6,
				hash: "",
				kind: "blob",
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
					path: "assets/file.pdf",
					etag: `"${epoch}.6"`,
					hash: "",
					origin: "remote",
					at: 5,
				},
			],
		});
		await context.controller.replay();
		expect(context.vault.reads).not.toContain("assets/file.pdf");
		expect(context.vault.binaryFiles.has("assets/file.pdf")).toBe(false);
		expect(
			[...context.vault.binaryFiles.entries()].some(
				([path, bytes]) =>
					path.includes("conflict") &&
					bytes.every((byte, index) => byte === editedBytes[index]),
			),
		).toBe(true);
		expect(context.journal.snapshot().cursor).toBe(6);
		expect(context.journal.snapshot().base["assets/file.pdf"]).toMatchObject({
			deleted: true,
			rev: 6,
		});
		expect(context.journal.snapshot().attention).toContainEqual({
			path: "assets/file.pdf",
			reason: "Local binary bytes were preserved as a conflict copy",
		});
	});

	it("applies exact current blob authority during a rejected rename recovery", async () => {
		const path = "assets/rename-source.png";
		const bytes = new Uint8Array([81, 82, 255]);
		const currentHash = await hashBytes(bytes);
		const oldHash = await hashBytes(new Uint8Array([83, 84]));
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 0);
		await context.journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: oldHash,
		});
		context.remote.blobPaths.add(path);
		context.remote.blobs.set(5, bytes);
		const remote = context.remote as typeof context.remote & {
			readCurrentAuthority: (source: string) => Promise<never>;
			readCurrentBlobAuthority: (source: string) => Promise<{
				kind: "blob";
				bytes: Uint8Array;
				epoch: string;
				rev: number;
				hash: string;
			}>;
		};
		remote.readCurrentAuthority = async () => {
			throw new UnsupportedRemoteTextError(path);
		};
		remote.readCurrentBlobAuthority = async () => ({
			kind: "blob",
			bytes: bytes.slice(),
			epoch,
			rev: 5,
			hash: currentHash,
		});
		await context.journal.enqueue(
			{
				op: "rename",
				path,
				to: "assets/rename-target.png",
				precondition: { kind: "match", epoch, rev: 1 },
				source_hash: oldHash,
			},
			new Uint8Array(),
		);
		const operation = context.journal.snapshot().pending_ops[0];
		if (!operation) throw new Error("Missing binary rename fixture");

		await context.controller.recoverPrecondition(operation);

		expect(context.vault.binaryFiles.get(path)).toEqual(bytes);
		expect(context.journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 5,
			hash: currentHash,
		});
	});

	it("preserves a colliding feed blob and continues to later feed entries", async () => {
		const path = "assets/photo.png";
		const localPath = "assets/PHOTO.png";
		const localBytes = new Uint8Array([61, 62]);
		const remoteBytes = new Uint8Array([63, 64]);
		const remoteHash = await hashBytes(remoteBytes);
		const following = "feed continued after the binary collision";
		context.vault.binaryFiles.set(localPath, localBytes);
		await context.journal.resetEpoch(epoch);
		await context.journal.setCursor(epoch, 0);
		context.remote.blobPaths.add(path);
		context.remote.blobs.set(5, remoteBytes);
		context.remote.texts.set("6", following);
		context.remote.feed.push({
			epoch,
			head_seq: 6,
			entries: [
				{
					seq: 5,
					op: "put",
					path,
					etag: `"${epoch}.5"`,
					hash: remoteHash,
					origin: "remote",
					at: 5,
				},
				{
					seq: 6,
					op: "put",
					path: "after-binary-collision.md",
					etag: `"${epoch}.6"`,
					hash: await hash(following),
					origin: "remote",
					at: 6,
				},
			],
		});

		await context.controller.replay();

		expect(context.vault.binaryFiles.get(localPath)).toEqual(localBytes);
		const visibleRemoteCopies = [...context.vault.binaryFiles.entries()].filter(
			([copyPath]) => copyPath.includes("conflict"),
		);
		expect(visibleRemoteCopies).toHaveLength(1);
		expect(visibleRemoteCopies[0]?.[1]).toEqual(remoteBytes);
		expect(context.vault.files.get("after-binary-collision.md")).toBe(
			following,
		);
		expect(context.journal.snapshot().cursor).toBe(6);
		expect(context.journal.snapshot().pending_apply).toEqual([]);
		expect(context.journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path }),
		);
	});

	it("applies authoritative feed blobs without decoding them as local text", async () => {
		await context.controller.enroll();
		context.remote.blobPaths.add("assets/photo.png");
		const blobBytes = new Uint8Array([0, 254, 5]);
		const blobHash = await hashBytes(blobBytes);
		context.remote.blobs.set(5, blobBytes);
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
					hash: blobHash,
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
		expect(context.vault.binaryFiles.get("assets/photo.png")).toEqual(
			blobBytes,
		);
		expect(context.vault.files.get("after-blob.md")).toBe(following);
		expect(context.journal.snapshot().cursor).toBe(6);
		expect(context.journal.snapshot().pending_apply).toEqual([]);
		expect(context.journal.snapshot().attention).not.toContainEqual(
			expect.objectContaining({ path: "assets/photo.png" }),
		);
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

	it("applies a source-only rename after hydration confirms its destination", async () => {
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
			rev: 3,
			hash: await hash(destinationText),
		});
		context.vault.files.set(destination, destinationText);
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
		expect(context.vault.files.get(destination)).toBe(destinationText);
		expect(
			[...context.vault.files.keys()].filter((path) => path === destination),
		).toHaveLength(1);
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

	it("publishes inline text and reconciles oversized Markdown as exact blob bytes", async () => {
		context.vault.files.set("note.md", "inline");
		context.vault.files.set("drawing.canvas", '{"nodes":[]}');
		context.vault.binaryFiles.set("image.png", new Uint8Array([0, 255]));
		const localLarge = new TextEncoder().encode("do not decode");
		const remoteLarge = new Uint8Array([9, 8, 7]);
		context.vault.files.set("large.md", "do not decode");
		context.vault.fileSizes.set("large.md", 1_000_001);
		context.remote.entries = [
			{
				path: "large.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				hash: await hashBytes(remoteLarge),
				kind: "blob",
				deleted: false,
			},
		];
		context.remote.blobPaths.add("large.md");
		context.remote.blobs.set(2, remoteLarge);
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
		expect(context.remote.createdBlobs.map((item) => item.path)).toEqual([
			"image.png",
		]);
		expect(context.vault.reads).not.toContain("image.png");
		expect(context.vault.reads).not.toContain("large.md");
		expect(context.vault.binaryFiles.get("large.md")).toEqual(remoteLarge);
		expect(context.vault.binaryFiles.get("large.md")).not.toEqual(localLarge);
		expect(context.journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path: "large.md" }),
		);
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
		const successor = "later local edit";
		context.vault.files.set("lost.md", successor);
		await context.controller.resume();
		expect(context.remote.created).toHaveLength(1);
		expect(context.vault.files.get("lost.md")).toBe(successor);
		expect(
			[...context.vault.files.keys()].filter((path) =>
				path.includes("conflict"),
			),
		).toEqual([]);
		expect(context.journal.snapshot().base["lost.md"]).toEqual({
			deleted: false,
			rev: 2,
			hash: hashValue,
		});
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
