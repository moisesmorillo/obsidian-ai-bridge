import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type DevicePrecondition,
	DevicePreconditionSchema,
	formatETag,
	type PendingOperation,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import {
	DeviceJournal,
	type DeviceJournalStorage,
} from "../src/sync/device-journal";
import { classifyEnrollmentPath } from "../src/sync/enrollment-scope";
import {
	PublicationController,
	type PublicationReceipt,
	type PublicationRemote,
} from "../src/sync/publication";
import { ReconciliationController } from "../src/sync/reconciliation";
import { SyncTransportError } from "../src/sync/remote-text";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";
import {
	assertAuthorizedVault,
	authorizedVaults,
	classifyAc13PreflightFiles,
	createAc04BaselineScript,
	createAc13CaseScripts,
	createAc19CaptureReloadScripts,
	createAc19CaseScripts,
	createAc19FixturePaths,
	createAc20FixtureScript,
	createAc30CaseScripts,
	createAc31CaseScripts,
	createAc33CaseScripts,
	createAc1032CaseScripts,
	createCaseScript,
	createInstallScript,
	dispatchCapturedCallback,
	hasCapturedCallback,
	inspectAc02ServiceRevision,
	parseAc13PrivateHashSnapshot,
	parseInstalledPluginArtifact,
	parseSafeCaseResult,
	runHostCase,
	runScopedObsidian,
	safeAc02ServiceRevision,
	safeAc04BaselineInspection,
	safeAc20Inspection,
	safeCaseResult,
	submitConsentAndDispatch,
	validateAuthorizationUrl,
	validateCallbackUrl,
} from "../tools/desktop-acceptance";

const vaults = {
	"dev-1": "/Users/test/vaults/obsidian-ai-bridge-dev",
	"dev-2": "/Users/test/vaults/obsidian-ai-bridge-dev-2",
};
const epoch = "a".repeat(32);

/** Keeps exact journal state and immutable payload bytes for the AC-30 harness. */
class MemoryStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Returns the saved state for journal initialization. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Stores a detached copy so journal mutations cannot alter saved state. */
	async writeState(
		state: Parameters<DeviceJournalStorage["writeState"]>[0],
	): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Returns a detached copy of one immutable journal payload. */
	async readPayload(path: string): Promise<Uint8Array> {
		const bytes = this.payloads.get(path);
		if (!bytes) throw new Error("Missing synthetic payload");
		return bytes.slice();
	}
	/** Stores a detached copy under the journal-provided payload reference. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Models exact text-path effects for real publication and reconciliation controllers. */
class AcceptanceMemoryVault implements TextVault {
	files = new Map<string, string>();
	/** Reads exact fixture text, or null when the path has no file. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Reads exact UTF-8 bytes for queued publication validation. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
	}
	/** Lists every synthetic vault path without changing its contents. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Returns UTF-8 byte length, or null when the path has no file. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return text === undefined
			? null
			: new TextEncoder().encode(text).byteLength;
	}
	/** Changes text only when the current value matches the expected value. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}
	/** Creates a path only when no file already exists. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}
	/** Removes a file only when its current text matches the expected value. */
	async trash(path: string, expected: string): Promise<boolean> {
		if (this.files.get(path) !== expected) return false;
		this.files.delete(path);
		return true;
	}
	/** Moves exact text only when the source matches and destination is absent. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		if (this.files.get(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, expected);
		this.files.delete(from);
		return true;
	}
}

/** Hashes exact UTF-8 fixture text using the production publication digest. */
async function hashAcceptanceText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("desktop acceptance safety", () => {
	it("confines AC-19 fixtures to a fresh isolated namespace per authorized vault", () => {
		const first = createAc19FixturePaths("dev-1");
		const second = createAc19FixturePaths("dev-2");
		expect(first.root).toBe("oab-10.1/dev-1");
		expect(second.root).toBe("oab-10.1/dev-2");
		expect(first.source).not.toBe(second.source);
		expect(first.placeholder).toBe(`${first.source}.icloud`);
		expect(classifyEnrollmentPath(first.source, 0)).not.toBe("excluded");
		expect(classifyEnrollmentPath(first.placeholder, 0)).toBe("excluded");
		expect(() => createAc19FixturePaths("dev-1", [first.source])).toThrow(
			"AC-19 fixture path already exists",
		);
		const scripts = createAc19CaseScripts(
			"dev-2",
			vaults["dev-2"],
			"/Users/test",
		);
		expect(scripts.action).toContain(
			'getBasePath() !== "/Users/test/vaults/obsidian-ai-bridge-dev-2"',
		);
		expect(scripts.action).toContain('"oab-10.1/dev-2/simulated-eviction.md"');
		expect(scripts.action).toContain("initialAttentionCount");
		expect(scripts.cleanup).toContain("keepServerState");
		expect(scripts.cleanup).toContain("settingsTab.syncActions.pause()");
		expect(scripts.cleanup).toContain("settingsTab.syncActions.resume()");
		expect(() =>
			createAc19CaseScripts("dev-1", vaults["dev-1"], "/Users/test"),
		).toThrow("AC-19 service case requires dev-2");
		expect(() =>
			createAc19CaseScripts(
				"dev-2",
				"/Users/test/vaults/owner-personal",
				"/Users/test",
			),
		).toThrow("Unauthorized vault target");
		const captureReload = createAc19CaptureReloadScripts(
			vaults["dev-1"],
			"/Users/test",
		);
		expect(captureReload.capture).toContain(
			'getBasePath() !== "/Users/test/vaults/obsidian-ai-bridge-dev"',
		);
		expect(captureReload.capture).toContain('deviceName !== "oab-10.1 dev-1"');
		expect(captureReload.capture).not.toContain("disablePlugin");
		expect(captureReload.capture).not.toContain("resume()");
		expect(captureReload.reloadVerification).toContain(
			'deviceName !== "oab-10.1 dev-1"',
		);
		expect(captureReload.reloadVerification).toContain(
			"AC19_RELOAD_ASSERT_PAUSED",
		);
		expect(captureReload.reloadVerification).toContain(
			'syncStatus?.().state !== "paused"',
		);
		expect(captureReload.reloadVerification).toContain("pendingApplyDelta");
		expect(captureReload.capture).not.toContain("resume()");
		expect(captureReload.reloadVerification).not.toContain("resume()");
		expect(
			() =>
				new Function(
					createCaseScript("AC-19", scripts.action, scripts.cleanup),
				),
		).not.toThrow();
		expect(
			() => new Function(createCaseScript("AC-19", captureReload.capture, "")),
		).not.toThrow();
		expect(
			() =>
				new Function(
					createCaseScript("AC-19", captureReload.reloadVerification, ""),
				),
		).not.toThrow();
		expect(
			safeCaseResult("AC-19", "service", {
				status: "passed",
				cleanupStatus: "passed",
				caseEvidence: {
					ac19: {
						captureReload: false,
						attentionUnchanged: true,
						baselineSynced: true,
						confirmationVisible: true,
						placeholderExcluded: true,
						serviceSourceLive: true,
						deleteOrRenameOperationCount: 0,
						initialPendingOperationCount: 0,
						initialPendingApplyCount: 0,
						initialAttentionCount: 4,
						initialConfirmationCount: 0,
						pendingOperationDelta: 0,
						pendingApplyDelta: 0,
						attentionDelta: 0,
						confirmationDelta: 1,
						clientId: "private-client-id",
					},
				},
				clientId: "client-result",
			}),
		).toMatchObject({
			caseId: "AC-19",
			status: "passed",
			evidence: "service",
			ac19Evidence: {
				captureReload: false,
				attentionUnchanged: true,
				baselineSynced: true,
				confirmationVisible: true,
				placeholderExcluded: true,
				serviceSourceLive: true,
				deleteOrRenameOperationCount: 0,
			},
		});
	});

	it("projects AC-19 baseline counts with nonzero historical attention", () => {
		const scripts = createAc19CaseScripts(
			"dev-2",
			vaults["dev-2"],
			"/Users/test",
		);
		expect(scripts.action).toContain("initialAttentionCount");
		expect(scripts.action).toContain("attentionDelta");
		expect(scripts.action).toContain("readCurrentAuthority");
		expect(scripts.action).toContain("JSON.stringify(settled.attention)");
		expect(scripts.action).not.toContain('syncStatus?.().state !== "settled"');
		expect(scripts.action).not.toContain("initial.attention?.length");
		expect(scripts.action).not.toContain("serviceAfter.head_seq");
		const result = safeCaseResult("AC-19", "service", {
			status: "passed",
			cleanupStatus: "passed",
			caseEvidence: {
				ac19: {
					captureReload: false,
					attentionUnchanged: true,
					baselineSynced: true,
					confirmationVisible: true,
					placeholderExcluded: true,
					serviceSourceLive: true,
					deleteOrRenameOperationCount: 0,
					initialPendingOperationCount: 0,
					initialPendingApplyCount: 0,
					initialAttentionCount: 4,
					initialConfirmationCount: 0,
					pendingOperationDelta: 0,
					pendingApplyDelta: 0,
					attentionDelta: 0,
					confirmationDelta: 1,
				},
			},
		});
		expect(result).toMatchObject({
			status: "passed",
			ac19Evidence: {
				initialPendingOperationCount: 0,
				initialPendingApplyCount: 0,
				initialAttentionCount: 4,
				initialConfirmationCount: 0,
				pendingOperationDelta: 0,
				pendingApplyDelta: 0,
				attentionDelta: 0,
				confirmationDelta: 1,
			},
		});
		const captureReloadResult = safeCaseResult("AC-19", "local", {
			status: "passed",
			cleanupStatus: "passed",
			caseEvidence: {
				ac19: {
					captureReload: true,
					attentionUnchanged: true,
					baselineSynced: false,
					confirmationVisible: true,
					placeholderExcluded: true,
					serviceSourceLive: null,
					deleteOrRenameOperationCount: 0,
					initialPendingOperationCount: 1,
					initialPendingApplyCount: 1,
					initialAttentionCount: 2,
					initialConfirmationCount: 0,
					pendingOperationDelta: 0,
					pendingApplyDelta: 0,
					attentionDelta: 0,
					confirmationDelta: 1,
				},
			},
		});
		expect(captureReloadResult).toMatchObject({
			status: "passed",
			evidence: "local",
			ac19Evidence: {
				captureReload: true,
				attentionUnchanged: true,
				serviceSourceLive: null,
				initialPendingOperationCount: 1,
				initialPendingApplyCount: 1,
				initialAttentionCount: 2,
			},
		});
	});

	it("projects only safe AC-04 revision comparison fields", () => {
		expect(
			safeAc04BaselineInspection({
				statusClass: "2xx",
				pathMatches: true,
				baselineRevisionChanged: false,
				deleted: false,
				strongResponseETag: true,
				content: "private note body",
				etag: "private etag",
				operationKey: "private key",
			}),
		).toEqual({
			statusClass: "2xx",
			pathMatches: true,
			baselineRevisionChanged: false,
			deleted: false,
			strongResponseETag: true,
		});
		expect(() =>
			safeAc04BaselineInspection({
				statusClass: "200",
				pathMatches: true,
				baselineRevisionChanged: false,
				deleted: false,
				strongResponseETag: true,
			}),
		).toThrow("Invalid AC-04 baseline result");
	});

	it("builds a fixed-path current GET without response content output", () => {
		const script = createAc04BaselineScript(vaults["dev-1"], "/Users/test");
		expect(script).toContain('const path = "oab-8.8/ac-04/shared.md"');
		expect(script).toContain('method: "GET"');
		expect(script).toContain("baselineRevisionChanged");
		expect(script).not.toContain('method: "DELETE"');
		expect(script).not.toContain("JSON.stringify(body)");
	});

	it("accepts only the exact authorized vault path", () => {
		expect(assertAuthorizedVault("dev-1", vaults["dev-1"], "/Users/test")).toBe(
			vaults["dev-1"],
		);
		expect(() =>
			assertAuthorizedVault(
				"dev-1",
				"/Users/test/vaults/Personal",
				"/Users/test",
			),
		).toThrow("Unauthorized vault target");
		expect(() =>
			assertAuthorizedVault("dev-3", "/Users/test/vaults/other", "/Users/test"),
		).toThrow("Unauthorized vault target");
	});

	it("rejects an invalid vault name before it can run a host command", () => {
		expect(() =>
			runScopedObsidian("dev-1", "dev=2", "eval", ["code=0"], {
				executable: "/not-run",
			}),
		).toThrow("Invalid Obsidian vault name");
	});

	it("checks the exact vault and preserves differing plugin files", () => {
		const script = createInstallScript(
			"dev-1",
			"/Users/test/vaults/obsidian-ai-bridge-dev",
			'{"id":"ai-bridge","version":"0.1.0"}',
			"synthetic bundle",
			"/Users/test",
		);
		expect(script).toContain(
			'adapter.getBasePath() !== "/Users/test/vaults/obsidian-ai-bridge-dev"',
		);
		expect(script.indexOf("Vault path mismatch")).toBeLessThan(
			script.indexOf("adapter.mkdir(directory)"),
		);
		expect(script).toContain('path + ".oab-8.8-backup"');
		expect(script).toContain('path + ".oab-8.8-backup-" + await hash(old)');
		expect(script).toContain("await adapter.write(backup, old)");
		expect(script.indexOf("await adapter.write(backup, old)")).toBeLessThan(
			script.indexOf("await adapter.write(path, content)"),
		);
		expect(script).toContain("new TextDecoder().decode");
		expect(script).toContain("manifest.dir = directory");
		expect(script).toContain("app.plugins.manifests[id] = manifest");
		expect(script).toContain("await app.plugins.loadPlugin(id)");
		expect(script).toContain('app.plugins.manifests[id]?.version !== "0.1.0"');
	});

	it("requires a canonical strong ETag for successful service revision evidence", () => {
		const strongETag = formatETag("a".repeat(32), 8);
		const valid = safeAc02ServiceRevision({
			statusClass: "2xx",
			pathMatches: true,
			etag: strongETag,
		});
		expect(valid).toEqual({
			statusClass: "2xx",
			pathMatches: true,
			serviceRevision: 8,
			strongResponseETag: true,
		});
		expect(JSON.stringify(valid)).not.toContain(strongETag);
		for (const etag of [
			undefined,
			null,
			`W/${strongETag}`,
			strongETag.replace(".8", ".0"),
		])
			expect(() =>
				safeAc02ServiceRevision({
					statusClass: "2xx",
					pathMatches: true,
					etag,
				}),
			).toThrow("Invalid AC-02 service revision evidence");
		expect(() =>
			safeAc02ServiceRevision({
				statusClass: "2xx",
				pathMatches: false,
				etag: strongETag,
			}),
		).toThrow("Invalid AC-02 service revision evidence");
		expect(
			safeAc02ServiceRevision({
				statusClass: "4xx",
				pathMatches: false,
				etag: null,
			}),
		).toEqual({
			statusClass: "4xx",
			pathMatches: false,
			serviceRevision: null,
			strongResponseETag: false,
		});
	});

	it("limits AC-02 service reads to the named fixture path family", () => {
		expect(() =>
			inspectAc02ServiceRevision("dev-1", "unused", "oab-8.8/other.md"),
		).toThrow("Unauthorized AC-02 service path");
	});

	it("returns installed artifact hashes after host read-back", () => {
		const script = createInstallScript(
			"dev-1",
			"/Users/test/vaults/obsidian-ai-bridge-dev",
			'{"id":"ai-bridge","version":"0.1.0"}',
			"synthetic bundle",
			"/Users/test",
		);
		expect(script).toContain("OAB8INSTALL:");
		expect(script).toContain("await adapter.read(mainFile)");
		expect(script.indexOf("app.plugins.enablePlugin(id)")).toBeLessThan(
			script.indexOf("OAB8INSTALL:"),
		);
	});

	it("accepts only the expected installed artifact fingerprints", () => {
		const expected = {
			version: "0.1.0",
			mainSha256: "a".repeat(64),
			manifestSha256: "b".repeat(64),
		};
		const result = { status: "passed", ...expected };
		expect(
			parseInstalledPluginArtifact(
				`OAB8INSTALL:${JSON.stringify(result)}`,
				expected,
			),
		).toEqual(expected);
		expect(() => parseInstalledPluginArtifact("eval failed", expected)).toThrow(
			"Plugin artifact verification was unavailable",
		);
		expect(() =>
			parseInstalledPluginArtifact(
				`OAB8INSTALL:${JSON.stringify({ ...result, mainSha256: "c".repeat(64) })}`,
				expected,
			),
		).toThrow("Installed plugin artifact does not match the checked bundle");
	});

	it("keeps every differing plugin file before it writes the checked bundle", async () => {
		const basePath = vaults["dev-1"];
		const mainPath = ".obsidian/plugins/ai-bridge/main.js";
		const manifestPath = ".obsidian/plugins/ai-bridge/manifest.json";
		const firstBackup = `${mainPath}.oab-8.8-backup`;
		const manifestText = '{"id":"ai-bridge","version":"0.1.0"}';
		const oldBundle = "current altered bundle";
		const checkedBundle = "checked bundle";
		const files = new Map<string, string>([
			[mainPath, oldBundle],
			[firstBackup, "earlier bundle"],
			[manifestPath, manifestText],
		]);
		const folders = new Set([".obsidian/plugins/ai-bridge"]);
		const enabled = new Set(["ai-bridge"]);
		const app = {
			vault: {
				adapter: {
					getBasePath: () => basePath,
					exists: async (path: string) => files.has(path) || folders.has(path),
					mkdir: async (path: string) => {
						folders.add(path);
					},
					read: async (path: string) => {
						const value = files.get(path);
						if (value === undefined) throw new Error("missing plugin file");
						return value;
					},
					write: async (path: string, content: string) => {
						files.set(path, content);
					},
				},
			},
			plugins: {
				manifests: {} as Record<string, { version?: string }>,
				enabledPlugins: enabled,
				loadPlugin: async () => undefined,
				disablePlugin: async (id: string) => {
					enabled.delete(id);
				},
				enablePlugin: async (id: string) => {
					enabled.add(id);
				},
			},
		};
		const script = createInstallScript(
			"dev-1",
			basePath,
			manifestText,
			checkedBundle,
			"/Users/test",
		);
		const execute = new Function("app", `return ${script}`) as (
			app: unknown,
		) => Promise<string>;
		const output = await execute(app);
		const expected = {
			version: "0.1.0",
			mainSha256: createHash("sha256").update(checkedBundle).digest("hex"),
			manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
		};
		expect(parseInstalledPluginArtifact(output, expected)).toEqual(expected);
		expect(files.get(firstBackup)).toBe("earlier bundle");
		const preservedCurrentPath = `${mainPath}.oab-8.8-backup-${createHash("sha256").update(oldBundle).digest("hex")}`;
		expect(files.get(preservedCurrentPath)).toBe(oldBundle);
		expect(files.get(mainPath)).toBe(checkedBundle);
	});

	it("accepts only a canonical authorization URL without callback credentials", () => {
		const url =
			"https://obsidian-bridge.mmorillo.dev/authorize?response_type=code&client_id=public-client&state=random-state&code_challenge=challenge&code_challenge_method=S256";
		expect(validateAuthorizationUrl(url)).toBe(url);
		expect(() =>
			validateAuthorizationUrl(
				"https://obsidian-bridge.mmorillo.dev/authorize?code=callback-code",
			),
		).toThrow("Invalid authorization URL");
		expect(() =>
			validateAuthorizationUrl(
				"https://other.example/authorize?response_type=code&client_id=id&state=state&code_challenge=challenge",
			),
		).toThrow("Invalid authorization URL");
	});

	it("accepts only a complete Obsidian callback without duplicate parameters", () => {
		expect(
			validateCallbackUrl(
				"obsidian://ai-bridge/callback?code=private-code&state=private-state",
			),
		).toBeUndefined();
		for (const url of [
			"https://example.test/callback?code=c&state=s",
			"obsidian://other/callback?code=c&state=s",
			"obsidian://ai-bridge/callback?state=s",
			"obsidian://ai-bridge/callback?code=c&state=s&state=other",
			"obsidian://ai-bridge/callback?code=c&code=other&state=s",
		])
			expect(() => validateCallbackUrl(url)).toThrow("Invalid device callback");
	});

	it("projects AC-20 inspection counts without returning file data", () => {
		expect(
			safeAc20Inspection({
				sessionStatus: "connected",
				syncState: "settled",
				storageFailureStage: "payload_read",
				deleteResponseDiagnostic: {
					statusClass: "4xx",
					errorKind: "invalid_request",
					responseETagClass: "strong",
					responseBody: "private response body",
				},
				localFixtureCount: 3,
				liveBaseCount: 3,
				localBaseFileCount: 3,
				ac20LiveBaseCount: 3,
				serviceLiveCount: 3,
				displayedLiveCount: 0,
				hasEpoch: true,
				hasCursor: true,
				pendingOperationCount: 0,
				pendingApplyCount: 0,
				noteBody: "private note body",
			}),
		).toEqual({
			sessionStatus: "connected",
			syncState: "settled",
			storageFailureStage: "payload_read",
			deleteResponseDiagnostic: {
				statusClass: "4xx",
				errorKind: "invalid_request",
				responseETagClass: "strong",
			},
			localFixtureCount: 3,
			liveBaseCount: 3,
			localBaseFileCount: 3,
			ac20LiveBaseCount: 3,
			serviceLiveCount: 3,
			displayedLiveCount: 0,
			hasEpoch: true,
			hasCursor: true,
			pendingOperationCount: 0,
			pendingApplyCount: 0,
		});
		expect(() =>
			safeAc20Inspection({
				sessionStatus: "connected",
				syncState: "attention",
				storageFailureStage: "private failure text",
				localFixtureCount: 0,
				liveBaseCount: 0,
				localBaseFileCount: 0,
				ac20LiveBaseCount: 0,
				serviceLiveCount: null,
				displayedLiveCount: null,
				hasEpoch: false,
				hasCursor: false,
				pendingOperationCount: 0,
				pendingApplyCount: 0,
			}),
		).toThrow("Invalid AC-20 inspection result");
		expect(() =>
			safeAc20Inspection({
				sessionStatus: "connected",
				syncState: "paused",
				deleteResponseDiagnostic: {
					statusClass: "4xx",
					errorKind: "private token",
					responseETagClass: "strong",
				},
			}),
		).toThrow("Invalid AC-20 inspection result");
		expect(() => safeAc20Inspection({ serviceLiveCount: -1 })).toThrow(
			"Invalid AC-20 inspection result",
		);
	});

	it("prepares dev-2 enrollment fixtures only before its first hydration", async () => {
		const script = createAc20FixtureScript(
			"dev-2",
			"prepare-dev2",
			vaults["dev-2"],
			"/Users/test",
		);
		const files = new Map<string, string>();
		const folders = new Set<string>();
		const app = {
			vault: {
				adapter: {
					getBasePath: () => vaults["dev-2"],
					exists: async (path: string) => files.has(path) || folders.has(path),
					read: async (path: string) => {
						const value = files.get(path);
						if (value === undefined) throw new Error("missing fixture");
						return value;
					},
				},
				createFolder: async (path: string) => {
					folders.add(path);
				},
				create: async (path: string, content: string) => {
					if (files.has(path)) throw new Error("fixture path exists");
					files.set(path, content);
					return { path };
				},
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						sessionStatus: "disconnected",
						session: { pending: null },
						journal: {
							snapshot: () => ({
								epoch: undefined,
								cursor: null,
								base: {},
								pending_ops: [],
								pending_apply: [],
								attention: [],
							}),
						},
					},
				},
			},
		};
		const execute = new Function("app", `return ${script}`) as (
			app: unknown,
		) => Promise<string>;
		expect(await execute(app)).toBe("OAB8AC20:local-fixtures-ready");
		expect([...files.keys()].sort()).toEqual([
			"oab-8.8/ac-20/different.md",
			"oab-8.8/ac-20/equal.md",
			"oab-8.8/ac-20/local-only.md",
		]);
		expect(files.has("oab-8.8/ac-20/remote-only.md")).toBe(false);
	});

	it("seeds only dev-1 local AC-20 remote candidates", async () => {
		const script = createAc20FixtureScript(
			"dev-1",
			"seed-dev1",
			vaults["dev-1"],
			"/Users/test",
		);
		const files = new Map<string, string>();
		const folders = new Set<string>();
		const app = {
			vault: {
				adapter: {
					getBasePath: () => vaults["dev-1"],
					exists: async (path: string) => files.has(path) || folders.has(path),
					read: async (path: string) => {
						const value = files.get(path);
						if (value === undefined) throw new Error("missing fixture");
						return value;
					},
				},
				createFolder: async (path: string) => {
					folders.add(path);
				},
				create: async (path: string, content: string) => {
					if (files.has(path)) throw new Error("fixture path exists");
					files.set(path, content);
					return { path };
				},
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						sessionStatus: "connected",
						syncStatus: () => ({ state: "settled" }),
						journal: {
							snapshot: () => ({
								epoch: "epoch",
								pending_ops: [],
								pending_apply: [],
								attention: [],
							}),
						},
					},
				},
			},
		};
		const execute = new Function("app", `return ${script}`) as (
			app: unknown,
		) => Promise<string>;
		expect(await execute(app)).toBe("OAB8AC20:remote-fixtures-local");
		expect([...files.keys()].sort()).toEqual([
			"oab-8.8/ac-20/different.md",
			"oab-8.8/ac-20/equal.md",
			"oab-8.8/ac-20/remote-only.md",
		]);
		expect(files.has("oab-8.8/ac-20/local-only.md")).toBe(false);
	});

	it("rejects AC-20 fixture phases for the wrong vault", () => {
		expect(() =>
			createAc20FixtureScript(
				"dev-1",
				"prepare-dev2",
				vaults["dev-1"],
				"/Users/test",
			),
		).toThrow("AC-20 fixture phase does not match the vault");
	});

	it("checks captured callback metadata without returning private values", () => {
		const callback =
			"obsidian://ai-bridge/callback?code=private-code&state=private-state";
		expect(
			hasCapturedCallback(
				JSON.stringify({ result: { effects: { url: callback } } }),
				"page-one",
				"page-one",
			),
		).toBe(true);
		expect(
			hasCapturedCallback(
				{ result: { effects: { url: callback } } },
				"page-two",
				"page-one",
			),
		).toBe(false);
		expect(
			hasCapturedCallback(
				{ result: { effects: { url: "https://example.test/callback" } } },
				"page-one",
				"page-one",
			),
		).toBe(false);
		expect(
			hasCapturedCallback(
				[callback, "obsidian://ai-bridge/callback?code=other&state=other"],
				"page-one",
				"page-one",
			),
		).toBe(false);
	});

	it("rejects a callback from another browser page before host effects", () => {
		expect(() =>
			dispatchCapturedCallback(
				"dev-1",
				"obsidian-ai-bridge-dev",
				"page-two",
				"page-one",
				"obsidian://ai-bridge/callback?code=c&state=s",
				{ executable: "/not-run" },
			),
		).toThrow("Callback page mismatch");
		expect(() =>
			submitConsentAndDispatch(
				"dev-1",
				"obsidian-ai-bridge-dev",
				"page-two",
				"page-one",
				"approve",
				{ browserExecutable: "/not-run" },
			),
		).toThrow("Callback page mismatch");
		expect(() =>
			dispatchCapturedCallback(
				"dev-3" as never,
				"obsidian-ai-bridge-dev",
				"page-one",
				"page-one",
				"obsidian://ai-bridge/callback?code=c&state=s",
				{ executable: "/not-run" },
			),
		).toThrow("Unauthorized vault target");
	});

	it("rejects unknown acceptance case IDs before host effects", () => {
		expect(() =>
			runHostCase(
				"dev-1",
				"obsidian-ai-bridge-dev",
				"AC-2",
				"controlled",
				"",
				"",
			),
		).toThrow("Invalid acceptance case ID");
	});

	it("runs cleanup after a controlled case throws", async () => {
		Reflect.deleteProperty(globalThis, "oab88CleanupRan");
		const script = createCaseScript(
			"AC-02",
			"throw Error('synthetic failure')",
			"globalThis.oab88CleanupRan = true",
		);
		const result = (
			new Function(`return ${script}`) as () => Promise<string>
		)();
		expect(JSON.parse((await result).slice("OAB8CASE:".length))).toEqual({
			caseId: "AC-02",
			status: "failed",
			failureStage: "action",
			failureReason: "unknown-error",
			failureClass: "Error",
			cleanupStatus: "passed",
		});
		expect(globalThis).toHaveProperty("oab88CleanupRan", true);
		Reflect.deleteProperty(globalThis, "oab88CleanupRan");
	});

	it("returns a safe allowlisted failure reason and cleanup status", async () => {
		const script = createCaseScript(
			"AC-30",
			"throw Error('AC30_FIRST_BOUNDARY_FAILED')",
			"globalThis.oab88CleanupRan = true",
		);
		const result = (
			new Function(`return ${script}`) as () => Promise<string>
		)();
		expect(JSON.parse((await result).slice("OAB8CASE:".length))).toEqual({
			caseId: "AC-30",
			status: "failed",
			failureStage: "action",
			failureReason: "AC30_FIRST_BOUNDARY_FAILED",
			failureClass: "Error",
			cleanupStatus: "passed",
		});
		expect(globalThis).toHaveProperty("oab88CleanupRan", true);
		Reflect.deleteProperty(globalThis, "oab88CleanupRan");
	});

	it("reports validated transport details at read and mutation boundaries", async () => {
		const cases = [
			{
				boundary: "AC31_READ_BASE_AUTHORITY",
				error: new SyncTransportError(410, "revision_pruned"),
				status: 410,
				code: "revision_pruned",
			},
			{
				boundary: "AC31_MUTATE_REMOTE_BLOB",
				error: new SyncTransportError(
					412,
					"precondition_failed",
					"private/path.md",
				),
				status: 412,
				code: "precondition_failed",
			},
		] as const;

		for (const testCase of cases) {
			const script = createCaseScript(
				"AC-31",
				`await withCaseBoundary("AC31_READ_SERVICE_ABSENCE", async () => true); await withCaseBoundary(${JSON.stringify(testCase.boundary)}, async () => { throw errorUnderTest; });`,
				"",
			);
			const execute = new Function("errorUnderTest", `return ${script}`) as (
				errorUnderTest: SyncTransportError,
			) => Promise<string>;
			const result = await execute(testCase.error);
			const summary = JSON.parse(result.slice("OAB8CASE:".length));

			expect(summary).toMatchObject({
				caseId: "AC-31",
				status: "failed",
				failureStage: "action",
				failureReason: `SYNC_TRANSPORT_${Math.floor(testCase.status / 100)}XX`,
				failureClass: "SyncTransportError",
				lastCompletedBoundary: "AC31_READ_SERVICE_ABSENCE",
				failureDetails: {
					boundary: testCase.boundary,
					errorClass: "SyncTransportError",
					status: testCase.status,
					code: testCase.code,
				},
				cleanupStatus: "passed",
			});
			expect(result).not.toContain("private/path.md");
		}
	});

	it("parses nested host failure details before safe projection", () => {
		const output =
			'CLI result OAB8CASE:{"caseId":"AC-13","status":"failed","failureStage":"action","failureReason":"SYNC_TRANSPORT_4XX","failureDetails":{"boundary":"AC13_READ_ACTUAL_MANIFEST","errorClass":"SyncTransportError","status":410,"code":"revision_pruned"},"failureClass":"SyncTransportError","lastCompletedBoundary":"AC13_CONTROLLED_RECONCILE","cleanupStatus":"passed"} trailing output';

		expect(parseSafeCaseResult(output, "AC-13", "controlled")).toEqual({
			caseId: "AC-13",
			evidence: "controlled",
			status: "failed",
			failureStage: "action",
			failureReason: "SYNC_TRANSPORT_4XX",
			failureDetails: {
				boundary: "AC13_READ_ACTUAL_MANIFEST",
				errorClass: "SyncTransportError",
				status: 410,
				code: "revision_pruned",
			},
			failureClass: "SyncTransportError",
			lastCompletedBoundary: "AC13_CONTROLLED_RECONCILE",
			cleanupStatus: "passed",
		});
	});

	it("retains only canonical successful mutation receipt statuses", () => {
		expect(
			Reflect.get(
				safeCaseResult("AC-33", "controlled", {
					status: "passed",
					caseEvidence: { renameReceiptStatus: 200 },
					cleanupStatus: "passed",
				}),
				"receiptStatus",
			),
		).toBe(200);
		expect(
			Reflect.get(
				safeCaseResult("AC-33", "controlled", {
					status: "passed",
					caseEvidence: { renameReceiptStatus: 201 },
					cleanupStatus: "passed",
				}),
				"receiptStatus",
			),
		).toBe(201);
		expect(
			Reflect.get(
				safeCaseResult("AC-33", "controlled", {
					status: "passed",
					caseEvidence: { renameReceiptStatus: 202 },
					cleanupStatus: "passed",
				}),
				"receiptStatus",
			),
		).toBeUndefined();
	});

	it("drops invalid case transport status and error codes", () => {
		const summary = safeCaseResult("AC-31", "service", {
			status: "failed",
			failureStage: "action",
			failureReason: "SYNC_TRANSPORT_4XX",
			failureDetails: {
				boundary: "AC31_READ_BASE_AUTHORITY",
				errorClass: "SyncTransportError",
				status: 999,
				code: "private-code",
			},
			cleanupStatus: "passed",
		});

		expect(summary.failureDetails).toEqual({
			boundary: "AC31_READ_BASE_AUTHORITY",
			errorClass: "SyncTransportError",
			status: null,
			code: null,
		});
	});

	it("builds an AC-10/32 process-race case with restored interception", () => {
		const scripts = createAc1032CaseScripts(
			"oab-8.8/ac-10-32-process-race-20261104-01.md",
		);
		expect(scripts.action).toContain("AC1032_ASSERT_TARGET_VAULT");
		expect(scripts.action).toContain('"AC1032_APPLY_REMOTE_CHANGE"');
		expect(scripts.action).toContain("callbackSawUserEdit");
		expect(scripts.action).toContain("callbackBaseAfterRefusal");
		const snapshotIndex = scripts.action.indexOf(
			"callbackBaseAfterRefusal=plugin.journal.snapshot().base[path]??null",
		);
		const callbackReturnIndex = scripts.action.indexOf(
			"return next;",
			snapshotIndex,
		);
		expect(snapshotIndex).toBeGreaterThan(-1);
		expect(callbackReturnIndex).toBeGreaterThan(snapshotIndex);
		expect(scripts.action).toContain("AC1032_ASSERT_BASE_UNCHANGED_AT_REFUSAL");
		expect(scripts.action).toContain(
			"remote.readCurrentAuthority(localConflictCopy.path)",
		);
		expect(scripts.action).toContain("globalThis.__oab8Ac1032Restore");
		expect(scripts.action).not.toContain("finalState.attention");
		expect(scripts.cleanup).toContain("AC1032_CLEANUP_RESTORE_FAILED");
		expect(
			() =>
				new Function(
					createCaseScript("AC-32", scripts.action, scripts.cleanup),
				),
		).not.toThrow();
		expect(() => createAc1032CaseScripts("oab-8.8/unrelated.md")).toThrow(
			"Unauthorized AC-10/32 fixture path",
		);
	});

	it("saves AC-13 before-case hashes in private scratch", () => {
		const temp = mkdtempSync(join(tmpdir(), "oab8-case-tool-"));
		const privateDirectory = resolve(
			process.cwd(),
			".superpowers/sdd/oab-8.8-desktop-gate",
		);
		const snapshotPrefix = "ac13-precase-hashes-";
		mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
		chmodSync(privateDirectory, 0o700);
		const before = readdirSync(privateDirectory, { withFileTypes: true })
			.filter(
				(entry) => entry.isFile() && entry.name.startsWith(snapshotPrefix),
			)
			.map((entry) => entry.name);
		const record = {
			caseId: "AC-13",
			status: "passed",
			failureStage: null,
			failureReason: null,
			cleanupStatus: "passed",
			caseEvidence: {
				ac13PrecaseFiles: {
					eligible: [
						{
							path: "oab-8.8/ac-13-clean.md",
							size: 32,
							hash: "a".repeat(64),
						},
					],
					excluded: [
						{
							path: "oab-8.8/ac-31-blob-stat-race-20261104-01.bin",
							size: 1_100_003,
							hash: "b".repeat(64),
						},
					],
				},
			},
		};
		const output = `OAB8CASE:${JSON.stringify(record)}`;
		const executable = join(temp, "obsidian");
		writeFileSync(
			executable,
			`#!/bin/sh\nif [ "$2" = "vault" ]; then printf '%s\\n' '${authorizedVaults()["dev-2"]}'; else printf '%s\\n' '${output}'; fi\n`,
			{ mode: 0o700 },
		);
		try {
			const summary = runHostCase(
				"dev-2",
				"dev-2",
				"AC-13",
				"controlled",
				"",
				"",
				{ executable },
			);
			expect(summary.privateSnapshotStatus).toBe("saved");
			const saved = readdirSync(privateDirectory).filter(
				(name) => name.startsWith(snapshotPrefix) && !before.includes(name),
			);
			expect(saved).toHaveLength(1);
			const savedPath = join(privateDirectory, saved[0]);
			expect(statSync(savedPath).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(savedPath, "utf8"))).toEqual(
				record.caseEvidence.ac13PrecaseFiles,
			);
		} finally {
			for (const name of readdirSync(privateDirectory)) {
				if (name.startsWith(snapshotPrefix) && !before.includes(name))
					rmSync(join(privateDirectory, name));
			}
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("validates private AC-13 before-case hash snapshots by classification", () => {
		const snapshot = parseAc13PrivateHashSnapshot({
			eligible: [
				{
					path: "oab-8.8/ac-13-clean.md",
					size: 32,
					hash: "a".repeat(64),
				},
			],
			excluded: [
				{
					path: "oab-8.8/ac-31-blob-stat-race-20261104-01.bin",
					size: 1_100_003,
					hash: "b".repeat(64),
				},
			],
		});
		expect(snapshot.eligible).toHaveLength(1);
		expect(snapshot.excluded).toHaveLength(1);
		expect(() =>
			parseAc13PrivateHashSnapshot({
				eligible: [
					{
						path: "oab-8.8/ac-31-blob-stat-race-20261104-01.bin",
						size: 1_100_003,
						hash: "b".repeat(64),
					},
				],
				excluded: [],
			}),
		).toThrow("Invalid AC-13 private hash snapshot");
	});

	it("does not block AC-13 preflight on canonically excluded local files", () => {
		const excluded = {
			path: "oab-8.8/ac-31-blob-stat-race-20261104-01.bin",
			size: 1_100_003,
			baseMatches: false,
			serviceMatches: false,
		};
		const eligible = {
			path: "oab-8.8/ac-13-clean.md",
			size: 32,
			baseMatches: true,
			serviceMatches: true,
		};
		expect(classifyAc13PreflightFiles([excluded, eligible])).toEqual({
			eligible: [eligible],
			excluded: [excluded],
			blockers: [],
		});
		expect(
			classifyAc13PreflightFiles([{ ...eligible, baseMatches: false }])
				.blockers,
		).toEqual([{ ...eligible, baseMatches: false }]);
	});

	it("separates AC-13 wrapper restoration from resume settlement", async () => {
		const path = "oab-8.8/ac-31-blob-stat-race-20261104-01.bin";
		const scripts = createAc13CaseScripts({
			excludedPaths: [path],
			excludedLocalFiles: [{ path, size: 1_100_003 }],
			localOnlyExcludedPaths: [path],
		});
		/** Captures the original transport method for cleanup identity checks. */
		const originalManifest = async (): Promise<{ controlled: boolean }> => ({
			controlled: false,
		});
		const remote = { manifest: async () => ({ controlled: true }) };
		Reflect.set(globalThis, "__oab8Ac13Restore", async () => {
			remote.manifest = originalManifest;
			return {
				wrapperRestored: remote.manifest === originalManifest,
				controllerResumed: false,
			};
		});
		const failedResumeScript = createCaseScript("AC-13", "", scripts.cleanup);
		const failedResume = (
			new Function(`return ${failedResumeScript}`) as () => Promise<string>
		)();
		expect(
			JSON.parse((await failedResume).slice("OAB8CASE:".length)),
		).toMatchObject({
			status: "failed",
			failureStage: "cleanup",
			failureReason: "AC13_CLEANUP_RESTORE_FAILED",
			cleanupStatus: "failed",
		});
		expect(globalThis).not.toHaveProperty("__oab8Ac13Restore");
		expect(remote.manifest).toBe(originalManifest);

		Reflect.set(globalThis, "__oab8Ac13Restore", async () => ({
			wrapperRestored: false,
			controllerResumed: false,
		}));
		const failedWrapperScript = createCaseScript("AC-13", "", scripts.cleanup);
		const failedWrapper = (
			new Function(`return ${failedWrapperScript}`) as () => Promise<string>
		)();
		expect(
			JSON.parse((await failedWrapper).slice("OAB8CASE:".length)),
		).toMatchObject({
			status: "failed",
			failureStage: "cleanup",
			failureReason: "AC13_CLEANUP_RESTORE_FAILED",
			cleanupStatus: "failed",
		});
		expect(globalThis).toHaveProperty("__oab8Ac13Restore");
		Reflect.deleteProperty(globalThis, "__oab8Ac13Restore");
	});

	it("builds controlled AC-13 epoch recovery with excluded-file preservation", () => {
		const path = "oab-8.8/ac-31-blob-stat-race-20261104-01.bin";
		const scripts = createAc13CaseScripts({
			excludedPaths: [path],
			excludedLocalFiles: [{ path, size: 1_100_003 }],
			localOnlyExcludedPaths: [path],
		});
		expect(scripts.action).toContain("AC13_ASSERT_TARGET_VAULT");
		expect(scripts.action).toContain("reconciliation.reconcile()");
		expect(scripts.action).toContain(
			"sameSnapshot(filesBefore,filesAfterControlled)",
		);
		expect(scripts.action).toContain("controlledState.epoch!==controlledEpoch");
		expect(scripts.action).toContain("restoredState.epoch!==observedEpoch");
		expect(scripts.action).toContain("caseEvidence.ac13PrecaseFiles");
		expect(scripts.action).toContain("localOnlyExcludedPaths.some");
		expect(scripts.cleanup).toContain("AC13_CLEANUP_RESTORE_FAILED");
		expect(
			() =>
				new Function(
					createCaseScript("AC-13", scripts.action, scripts.cleanup),
				),
		).not.toThrow();
		expect(() =>
			createAc13CaseScripts({
				excludedPaths: ["oab-8.8/not-excluded.md"],
				excludedLocalFiles: [],
				localOnlyExcludedPaths: [],
			}),
		).toThrow("Unauthorized AC-13 excluded file scope");
	});

	it("provides a read-only AC-10/32 preflight for local and service collisions", async () => {
		const fixturePath = "oab-8.8/ac-10-32-process-race-20261104-02.md";
		const scripts = createAc1032CaseScripts(fixturePath);
		expect(scripts.preflight).toBeTypeOf("string");
		expect(scripts.preflight).toContain("AC1032_ASSERT_FIXTURE_ABSENT");
		expect(scripts.preflight).not.toContain("create(");
		expect(scripts.preflight).not.toContain("syncNow(");
		/** Runs the generated check against one local/service path state. */
		const runPreflight = async (
			localExists: boolean,
			serviceExists: boolean,
		) => {
			let serviceReads = 0;
			let mutations = 0;
			const remote = {
				readCurrentAuthority: async () => {
					serviceReads += 1;
					if (!serviceExists) throw new SyncTransportError(404, "not_found");
					return { deleted: false };
				},
			};
			const app = {
				vault: {
					adapter: { getBasePath: () => authorizedVaults()["dev-2"] },
					getAbstractFileByPath: () =>
						localExists ? { path: fixturePath } : null,
					create: async () => {
						mutations += 1;
					},
				},
				plugins: {
					plugins: {
						"ai-bridge": { composition: { publication: { remote } } },
					},
				},
			};
			const script = createCaseScript("AC-32", scripts.preflight ?? "", "");
			const output = await (
				new Function("app", `return ${script}`) as (
					app: unknown,
				) => Promise<string>
			)(app);
			return {
				summary: JSON.parse(output.slice("OAB8CASE:".length)),
				serviceReads,
				mutations,
			};
		};
		for (const [localExists, serviceExists] of [
			[true, false],
			[false, true],
		] as const) {
			const result = await runPreflight(localExists, serviceExists);
			expect(result.summary).toMatchObject({
				status: "failed",
				failureReason: "AC1032_ASSERT_FIXTURE_ABSENT",
				cleanupStatus: "passed",
			});
			expect(result.serviceReads).toBe(1);
			expect(result.mutations).toBe(0);
		}
		const available = await runPreflight(false, false);
		expect(available.summary.status).toBe("passed");
		expect(available.serviceReads).toBe(1);
		expect(available.mutations).toBe(0);
		const temp = mkdtempSync(join(tmpdir(), "oab-8.8-ac1032-preflight-"));
		const invocationLog = join(temp, "eval-calls");
		const blockedRecord = `OAB8CASE:${JSON.stringify({
			caseId: "AC-32",
			status: "failed",
			failureStage: "action",
			failureReason: "AC1032_ASSERT_FIXTURE_ABSENT",
			cleanupStatus: "passed",
		})}`;
		const executable = join(temp, "obsidian");
		writeFileSync(
			executable,
			`#!/bin/sh\nif [ "$2" = "vault" ]; then printf '%s\\n' '${authorizedVaults()["dev-2"]}'; else printf 'eval\\n' >> '${invocationLog}'; printf '%s\\n' '${blockedRecord}'; fi\n`,
			{ mode: 0o700 },
		);
		try {
			expect(() =>
				runHostCase(
					"dev-2",
					"dev-2",
					"AC-32",
					"controlled",
					"throw Error('action must not run')",
					"",
					{ executable, preflightScript: scripts.preflight },
				),
			).toThrow("AC1032_FIXTURE_PREFLIGHT_BLOCKED");
			expect(
				readFileSync(invocationLog, "utf8").trim().split("\\n"),
			).toHaveLength(1);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
		expect(() =>
			runHostCase("dev-2", "dev-2", "AC-32", "controlled", "", "", {
				executable: "/not-run",
			}),
		).toThrow("AC1032_PREFLIGHT_REQUIRED");
	});

	it("builds the controlled AC-33 hydration and feed replay case", () => {
		const scripts = createAc33CaseScripts();
		expect(scripts.action).toContain("AC33_ASSERT_TARGET_VAULT");
		expect(scripts.action).toContain("reconciliation.reconcile()");
		expect(scripts.action).toContain(
			'remote.put(source,sourceText,{kind:"absent"}',
		);
		expect(scripts.action).toContain("reconciliation.replay()");
		expect(scripts.action).toContain("caseEvidence.renameReceiptStatus");
		expect(scripts.action).toContain("AC33_CONTROLLED_HYDRATION_STOP");
		expect(scripts.action).toContain("destinationAbsence");
		expect(scripts.action).toContain("crypto.randomUUID()");
		expect(scripts.action).toContain(
			'remote.rename(source,destination,{kind:"match",epoch:observedEpoch,rev:sourceBefore.rev}',
		);
		expect(scripts.action).toContain(
			"caseEvidence.renameReceiptStatus=renameReceipt.status",
		);
		expect(scripts.action).not.toContain(
			"renameReceipt.status!==200&&renameReceipt.status!==201",
		);
		expect(scripts.action).toContain("firstPage.epoch!==observedEpoch");
		expect(scripts.action).toContain("localSourceHash!==sourceHash");
		expect(scripts.cleanup).toContain("AC33_CLEANUP_RESTORE_FAILED");
		expect(
			() =>
				new Function(
					createCaseScript("AC-33", scripts.action, scripts.cleanup),
				),
		).not.toThrow();
		expect(() => createAc33CaseScripts("oab-8.8/unrelated.md")).toThrow(
			"Unauthorized AC-33 fixture path",
		);
	});

	it("sends the generated AC-31 blob mutation with its observed revision", async () => {
		const fixturePath = "oab-8.8/ac-31-blob-stat-race-20261104-03.md";
		const epoch = "a".repeat(32);
		const baseBytes = new TextEncoder().encode(
			`# AC-31 blob stat race fixture\n\n${"A".repeat(1_100_000)}\n`,
		);
		const baseHash = createHash("sha256").update(baseBytes).digest("hex");
		const entryETag = formatETag(epoch, 1);
		const outbound: Array<{ path: string; options: Record<string, unknown> }> =
			[];
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async (path, options = {}) => {
				outbound.push({ path, options });
				return { status: 500, headers: {}, text: "{}" };
			},
		});
		let capturedArguments: unknown[] = [];
		let created = false;
		const state = {
			epoch,
			cursor: 7,
			base: {} as Record<string, { rev: number; hash: string }>,
			pending_ops: [] as unknown[],
			pending_apply: [] as unknown[],
			reconciliation: null,
			attention: [] as unknown[],
		};
		const files = new Map<string, Uint8Array>();
		const adapterPrototype = { stat: async () => null };
		const adapter = Object.create(adapterPrototype) as {
			getBasePath: () => string;
			stat: typeof adapterPrototype.stat;
		};
		adapter.getBasePath = () => vaults["dev-2"];
		const remote = {
			readCurrentBlobAuthority: async () => {
				if (!created) throw new SyncTransportError(404, "not_found");
				return {
					kind: "blob" as const,
					rev: 1,
					hash: baseHash,
					epoch,
				};
			},
			manifest: async () => ({
				epoch,
				head_seq: 7,
				entries: [
					{
						path: fixturePath,
						etag: entryETag,
						seq: 7,
						hash: baseHash,
						kind: "blob" as const,
						deleted: false,
					},
				],
				next_page: null,
			}),
			putBlob: (...args: unknown[]) => {
				capturedArguments = args;
				const [path, bytes, hash, precondition, key, epoch] = args;
				if (
					typeof path !== "string" ||
					!(bytes instanceof Uint8Array) ||
					typeof hash !== "string" ||
					typeof key !== "string" ||
					typeof epoch !== "string"
				)
					throw new Error("Generated AC-31 call shape is invalid");
				return transport.putBlob(
					path,
					bytes,
					hash,
					DevicePreconditionSchema.parse(precondition),
					key,
					epoch,
				);
			},
		};
		const scripts = createAc31CaseScripts("/Users/test", fixturePath);
		const app = {
			vault: {
				adapter,
				createBinary: async (path: string, bytes: ArrayBuffer) => {
					files.set(path, new Uint8Array(bytes));
					created = true;
				},
				getAbstractFileByPath: (path: string) =>
					files.has(path) ? { path } : null,
				getFiles: () => [...files.keys()].map((path) => ({ path })),
				readBinary: async (file: { path: string }) =>
					files.get(file.path)?.buffer.slice(0),
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						journal: {
							snapshot: () => structuredClone(state),
						},
						composition: { publication: { remote } },
						desktopSync: {
							isBusy: false,
							waitForIdle: async () => undefined,
							syncNow: async () => {
								const bytes = files.get(fixturePath);
								if (!bytes) throw new Error("Fixture missing");
								state.base[fixturePath] = {
									rev: 1,
									hash: createHash("sha256").update(bytes).digest("hex"),
								};
							},
						},
						sessionStatus: "connected",
						syncPaused: false,
					},
				},
			},
		};
		const hostScript = createCaseScript(
			"AC-31",
			scripts.action,
			scripts.cleanup,
		);
		const output = await (
			new Function("app", `return ${hostScript}`) as (
				app: unknown,
			) => Promise<string>
		)(app);
		const summary = JSON.parse(output.slice("OAB8CASE:".length));
		const headers = outbound[0]?.options.headers as Record<string, unknown>;
		expect(summary).toMatchObject({
			status: "failed",
			failureStage: "action",
			failureReason: "SYNC_TRANSPORT_5XX",
			cleanupStatus: "passed",
		});
		expect(capturedArguments).toHaveLength(6);
		expect(capturedArguments[0]).toBe(fixturePath);
		expect(capturedArguments[1]).toBeInstanceOf(Uint8Array);
		expect(capturedArguments[2]).toMatch(/^[a-f0-9]{64}$/);
		expect(capturedArguments[3]).toEqual({
			kind: "match",
			epoch,
			rev: 1,
		});
		expect(capturedArguments[5]).toBe(epoch);
		expect(headers).toMatchObject({
			"if-match": formatETag(epoch, 1),
			"x-vault-epoch": epoch,
		});
		expect(JSON.stringify(summary)).not.toContain("private");
	});

	it("uses a fresh AC-37 fixture and the initial attention baseline", () => {
		const action = createAc30CaseScripts("/Users/test").action;

		expect(action).toContain(
			'const path="oab-37/ac-30-response-lost-20261105-01.md"',
		);
		expect(action).toContain(
			"const initialAttentionCount=stateBefore.attention.length",
		);
		expect(action).toContain(
			"finalState.attention.length!==expectedAttentionCount",
		);
		expect(action).not.toContain("oab-8.8/ac-30-response-lost-20261104-06.md");
		const customAction = createAc30CaseScripts(
			"/Users/test",
			"oab-37/ac-30-response-lost-custom-02.md",
		).action;
		expect(customAction).toContain(
			'const path="oab-37/ac-30-response-lost-custom-02.md"',
		);
		expect(() =>
			createAc30CaseScripts(
				"/Users/test",
				"oab-8.8/ac-30-response-lost-old.md",
			),
		).toThrow("Unauthorized AC-30 fixture path");
	});

	it("keeps recovered AC-30 and Markdown AC-31 diagnostics unique", async () => {
		const ac30 = createAc30CaseScripts("/Users/test");
		const ac31 = createAc31CaseScripts(
			"/Users/test",
			"oab-8.8/ac-31-blob-stat-race-20261104-03.md",
		);
		for (const scripts of [ac30, ac31]) {
			const siteCodes = [
				...scripts.action.matchAll(/throw (?:new )?Error\("([A-Z0-9_]+)"\)/g),
			].map((match) => match[1]);
			const cleanupCodes = [
				...scripts.cleanup.matchAll(/throw (?:new )?Error\("([A-Z0-9_]+)"\)/g),
			].map((match) => match[1]);
			expect(new Set(siteCodes).size).toBe(siteCodes.length);
			expect(new Set(cleanupCodes).size).toBe(cleanupCodes.length);
			for (const code of [...siteCodes, ...cleanupCodes]) {
				expect(
					safeCaseResult("AC-30", "controlled", {
						status: "failed",
						failureStage: "action",
						failureReason: code,
						cleanupStatus: "passed",
					}).failureReason,
				).toBe(code);
			}
		}
		expect(ac31.action).toContain(
			"oab-8.8/ac-31-blob-stat-race-20261104-03.md",
		);
		expect(ac31.action).toContain(
			"createBinary(path,baseBytes.buffer.slice(0))",
		);
		expect(ac31.action).not.toContain(".bin");
		expect(ac31.action).toContain("ac-31-blob-stat-race-20261104-03.md");
		expect(ac31.action).toContain(
			'const conflictPrefix=path.slice(0,path.lastIndexOf("."))+" (conflict"',
		);
		expect(() =>
			createAc31CaseScripts(
				"/Users/test",
				"oab-8.8/ac-31-blob-stat-race-20261104-04.bin",
			),
		).toThrow("Unauthorized AC-31 fixture path");
		expect(ac30.action).toContain("oab-37/ac-30-response-lost-20261105-01.md");
		expect(ac30.action).not.toContain(
			"oab-8.8/ac-30-response-lost-20261104-05.md",
		);
		expect(ac30.action).toContain("AC30_TIMEOUT_FIRST_BOUNDARY_WAIT");
		expect(ac31.action).toContain("AC31_TIMEOUT_STAT_RACE_INJECTION");
		expect(ac31.action).toContain(
			'withCaseBoundary("AC31_READ_BASE_AUTHORITY"',
		);
		expect(ac31.action).toContain('withCaseBoundary("AC31_MUTATE_REMOTE_BLOB"');
		expect(ac30.action).not.toMatch(
			/AC30_(?:PRECONDITION|FIRST_BOUNDARY|SUCCESSOR_BOUNDARY)_FAILED/,
		);
		expect(ac31.action).not.toMatch(
			/AC31_(?:PRECONDITION|STAT_RACE|REMOTE_UPDATE|CONFLICT_PRESERVATION)_FAILED/,
		);

		/** Executes only the case's generated local assertion path. */
		const runWithVault = async (
			caseId: string,
			action: string,
			app: unknown,
			cleanup = "",
		) => {
			const hostScript = createCaseScript(caseId, action, cleanup);
			return (
				new Function("app", `return ${hostScript}`) as (
					app: unknown,
				) => Promise<string>
			)(app);
		};
		const ac30WrongTarget = await runWithVault("AC-30", ac30.action, {
			vault: { adapter: { getBasePath: () => "/wrong" } },
		});
		const ac30MissingPlugin = await runWithVault("AC-30", ac30.action, {
			vault: { adapter: { getBasePath: () => vaults["dev-2"] } },
			plugins: { plugins: {} },
		});
		const ac31WrongTarget = await runWithVault("AC-31", ac31.action, {
			vault: { adapter: { getBasePath: () => "/wrong" } },
		});
		Reflect.set(globalThis, "__oab8Ac30Restore", () => true);
		const ac30Cleanup = await runWithVault(
			"AC-30",
			ac30.action,
			{ vault: { adapter: { getBasePath: () => "/wrong" } } },
			ac30.cleanup,
		);
		expect(
			JSON.parse(ac30Cleanup.slice("OAB8CASE:".length)).cleanupStatus,
		).toBe("passed");
		expect(globalThis).not.toHaveProperty("__oab8Ac30Restore");
		for (const [caseId, cleanupScript, restoreName, cleanupCode] of [
			[
				"AC-30",
				ac30.cleanup,
				"__oab8Ac30Restore",
				"AC30_CLEANUP_RESTORE_FAILED",
			],
			[
				"AC-31",
				ac31.cleanup,
				"__oab8Ac31Restore",
				"AC31_CLEANUP_RESTORE_FAILED",
			],
		] as const) {
			Reflect.set(globalThis, restoreName, () => false);
			const result = await runWithVault(caseId, "", {}, cleanupScript);
			expect(JSON.parse(result.slice("OAB8CASE:".length))).toMatchObject({
				failureStage: "cleanup",
				failureReason: cleanupCode,
				cleanupStatus: "failed",
			});
			Reflect.deleteProperty(globalThis, restoreName);
		}
		expect(
			JSON.parse(ac30WrongTarget.slice("OAB8CASE:".length)).failureReason,
		).toBe("AC30_ASSERT_TARGET_VAULT");
		expect(
			JSON.parse(ac30MissingPlugin.slice("OAB8CASE:".length)).failureReason,
		).toBe("AC30_ASSERT_PLUGIN_CONTROLS");
		expect(
			JSON.parse(ac31WrongTarget.slice("OAB8CASE:".length)).failureReason,
		).toBe("AC31_ASSERT_TARGET_VAULT");
		for (const [caseId, timeoutCode] of [
			["AC-30", "AC30_TIMEOUT_FIRST_BOUNDARY_WAIT"],
			["AC-31", "AC31_TIMEOUT_STAT_RACE_INJECTION"],
		] as const) {
			const timeoutResult = await runWithVault(
				caseId,
				`throw new Error("${timeoutCode}")`,
				{},
			);
			expect(
				JSON.parse(timeoutResult.slice("OAB8CASE:".length)).failureReason,
			).toBe(timeoutCode);
		}
	});

	it("classifies safe unexpected errors without their messages", async () => {
		const cases = [
			{
				error: { name: "AssertionError", message: "private detail" },
				expected: "unexpected-assertion-error",
			},
			{
				error: { name: "TypeError", message: "private detail" },
				expected: "unexpected-type-error",
			},
			{
				error: { name: "TimeoutError", message: "private detail" },
				expected: "ACTION_TIMEOUT",
			},
			{
				error: {
					name: "SyncTransportError",
					status: 412,
					message: "private detail",
				},
				expected: "SYNC_TRANSPORT_4XX",
			},
			{
				error: {
					name: "SyncTransportError",
					status: 503,
					message: "private detail",
				},
				expected: "SYNC_TRANSPORT_5XX",
			},
			{
				error: {
					name: "SyncTransportError",
					status: 700,
					message: "private detail",
				},
				expected: "unexpected-sync-transport-error",
			},
		];
		for (const { error, expected } of cases) {
			const script = createCaseScript(
				"AC-02",
				`throw Object.assign(new Error(${JSON.stringify(error.message)}), ${JSON.stringify(error)})`,
				"globalThis.oab88CleanupRan = true",
			);
			const result = (
				new Function(`return ${script}`) as () => Promise<string>
			)();
			const serialized = await result;
			expect(
				JSON.parse(serialized.slice("OAB8CASE:".length)).failureReason,
			).toBe(expected);
			expect(serialized).not.toContain("private detail");
		}
		const cleanupTimeout = createCaseScript(
			"AC-02",
			"",
			"throw Object.assign(new Error('private detail'), { name: 'TimeoutError' })",
		);
		const cleanupResult = (
			new Function(`return ${cleanupTimeout}`) as () => Promise<string>
		)();
		const cleanupSerialized = await cleanupResult;
		expect(
			JSON.parse(cleanupSerialized.slice("OAB8CASE:".length)),
		).toMatchObject({
			failureStage: "cleanup",
			failureReason: "CLEANUP_TIMEOUT",
			cleanupStatus: "failed",
		});
		expect(cleanupSerialized).not.toContain("private detail");
		Reflect.deleteProperty(globalThis, "oab88CleanupRan");
	});

	it("hides unknown failure text and reports failed cleanup", async () => {
		const script = createCaseScript(
			"AC-02",
			"throw Error('private note bytes and bearer token')",
			"throw Error('authorization URL and operation key')",
		);
		const result = (
			new Function(`return ${script}`) as () => Promise<string>
		)();
		const serialized = await result;
		expect(JSON.parse(serialized.slice("OAB8CASE:".length))).toEqual({
			caseId: "AC-02",
			status: "failed",
			failureStage: "action",
			failureReason: "unknown-error",
			failureClass: "Error",
			cleanupStatus: "failed",
		});
		expect(serialized).not.toMatch(
			/private note bytes|bearer token|authorization URL|operation key/,
		);
	});

	it("sanitizes AC-30 observations before the host result returns", async () => {
		const script = createCaseScript(
			"AC-30",
			'recordAc30FinalAssertion("AC30_ASSERT_FINAL_CALL_COUNT", "private identity", 2, { callCount: 2, calls: [{ status: 201, revision: 1 }, { status: 201, revision: 1 }], retryIdentityMatches: true, successorIdentityDistinct: null, retryPayloadMatches: true, successorPayloadMatches: false, retryPreconditionMatches: true, retryReceiptMatches: true, queue: { pendingOperationCount: 1, pendingApplyCount: 0, attentionCount: 4, fixtureOperationCount: 1, otherPathOperationCount: 1, fixtureOperations: [{ ordinal: "retry", state: "sent", operation: "put", preconditionKind: "absent", key: "private-key", path: "private/path.md", payload: "private bytes" }] }, privateData: "private bytes" }); throw Error("AC30_ASSERT_FINAL_CALL_COUNT");',
			"caseEvidence.cleanupRan=true;",
		);
		const output = await (
			new Function(`return ${script}`) as () => Promise<string>
		)();
		const record = JSON.parse(output.slice("OAB8CASE:".length));

		expect(record.caseEvidence.ac30FinalAssertion).toMatchObject({
			code: "AC30_ASSERT_FINAL_CALL_COUNT",
			expected: "other",
			observed: 2,
			diagnostic: {
				callCount: 2,
				calls: [
					{ ordinal: "first", status: 201, revision: 1 },
					{ ordinal: "retry", status: 201, revision: 1 },
				],
				retryIdentityMatches: true,
				successorIdentityDistinct: null,
				retryPayloadMatches: true,
				successorPayloadMatches: false,
				retryPreconditionMatches: true,
				retryReceiptMatches: true,
				queue: {
					pendingOperationCount: 1,
					pendingApplyCount: 0,
					attentionCount: 4,
					fixtureOperationCount: 1,
					otherPathOperationCount: 1,
					fixtureOperations: [
						{
							ordinal: "retry",
							state: "sent",
							operation: "put",
							preconditionKind: "absent",
						},
					],
				},
			},
		});
		expect(record.caseEvidence.cleanupRan).toBe(true);
		expect(output).not.toMatch(
			/private identity|private-key|private\/path|private bytes/,
		);
	});

	it("restores the exact AC-30 publication method after fixture creation fails", async () => {
		/** Provides an inert method whose exact identity the generated action must restore. */
		const originalPut = async () => {
			throw new Error("Unexpected publication request");
		};
		const remote = {
			put: originalPut,
			readCurrentAuthority: async () => {
				throw Object.assign(new Error("Missing synthetic fixture"), {
					status: 404,
				});
			},
		};
		let interceptionInstalled = false;
		const app = {
			vault: {
				adapter: { getBasePath: () => vaults["dev-2"] },
				getAbstractFileByPath: () => null,
				create: async () => {
					interceptionInstalled = remote.put !== originalPut;
					throw new Error("Injected failure after interception");
				},
			},
			plugins: {
				plugins: {
					"ai-bridge": {
						journal: {
							snapshot: () => ({
								epoch,
								pending_ops: [],
								pending_apply: [],
								reconciliation: null,
								attention: [],
								base: {},
							}),
						},
						composition: { publication: { remote } },
						desktopSync: {
							isBusy: false,
							waitForIdle: async () => undefined,
							syncNow: async () => undefined,
						},
						sessionStatus: "connected",
						syncPaused: false,
					},
				},
			},
		};
		const script = createCaseScript(
			"AC-30",
			createAc30CaseScripts("/Users/test").action,
			"",
		);

		try {
			const output = await (
				new Function("app", `return ${script}`) as (
					app: unknown,
				) => Promise<string>
			)(app);
			const record = JSON.parse(output.slice("OAB8CASE:".length));

			expect(interceptionInstalled).toBe(true);
			expect(remote.put).toBe(originalPut);
			expect(record).toMatchObject({
				status: "failed",
				failureStage: "action",
				failureReason: "unknown-error",
				cleanupStatus: "passed",
			});
		} finally {
			Reflect.deleteProperty(globalThis, "__oab8Ac30Restore");
		}
	});

	it("rejects retry receipts that differ outside the ETag", async () => {
		const action = createAc30CaseScripts("/Users/test").action;
		const start = action.indexOf("const observedType=");
		const end = action.indexOf("\n}finally{", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const finalAssertions = action.slice(start, end);
		const hash = "a".repeat(64);
		const firstReceipt = {
			status: 201,
			path: "oab-37/ac-30-response-lost-20261105-01.md",
			etag: "private-etag",
			seq: 1,
			size: 12,
			hash,
			deleted: false,
		};
		const retryReceipt = { ...firstReceipt, seq: 2 };
		const bindings = {
			callCount: 3,
			firstKey: "private-first-key",
			retryKey: "private-first-key",
			successorKey: "private-successor-key",
			firstStatus: 201,
			retryStatus: 201,
			successorStatus: 201,
			firstRevision: 1,
			retryRevision: 1,
			successorRevision: 2,
			firstReceipt,
			retryReceipt,
			firstReceiptETag: firstReceipt.etag,
			retryReceiptETag: firstReceipt.etag,
			retryIdentityMatches: true,
			successorIdentityDistinct: true,
			retryPayloadMatchesOriginal: true,
			successorPayloadMatchesEdited: true,
			firstPrecondition: { kind: "absent" },
			retryPrecondition: { kind: "absent" },
			successorPrecondition: { kind: "match", epoch, rev: 1 },
			stateBefore: { epoch },
			path: "oab-37/ac-30-response-lost-20261105-01.md",
			authority: { deleted: false, rev: 2, hash },
			hashText: async () => hash,
			editedText: "private edited bytes",
			localText: "private edited bytes",
			base: { deleted: false, rev: 2, hash },
			finalHash: hash,
			finalState: {
				pending_ops: [],
				pending_apply: [],
				reconciliation: null,
				attention: [{}, {}, {}],
			},
			initialAttentionCount: 3,
			timer: null,
			releaseGate: () => undefined,
			remote: { put: async () => undefined },
			originalPut: async () => undefined,
		};
		const setup = Object.keys(bindings)
			.map((key) => `const ${key}=__params[${JSON.stringify(key)}];`)
			.join("\n");
		const script = createCaseScript(
			"AC-30",
			`${setup}\n${finalAssertions}`,
			"",
		);
		const output = await new Function("__params", `return ${script}`)(bindings);
		const record = JSON.parse(output.slice("OAB8CASE:".length));

		expect(record).toMatchObject({
			status: "failed",
			failureReason: "AC30_ASSERT_FINAL_RETRY_ETAG",
			caseEvidence: {
				ac30FinalAssertion: {
					code: "AC30_ASSERT_FINAL_RETRY_ETAG",
					expected: true,
					observed: false,
					diagnostic: { retryReceiptMatches: false },
				},
			},
		});
		expect(output).not.toMatch(
			/private-first-key|private-successor-key|private-etag|private edited bytes|a{64}/,
		);
	});

	it("projects only bounded AC-30 assertion observations", () => {
		const summary = safeCaseResult(
			"AC-30",
			"controlled",
			{
				status: "failed",
				failureStage: "action",
				failureReason: "AC30_ASSERT_FINAL_CALL_COUNT",
				cleanupStatus: "passed",
				caseEvidence: {
					ac30FinalAssertion: {
						code: "AC30_ASSERT_FINAL_CALL_COUNT",
						expected: 3,
						observed: 2,
						diagnostic: {
							callCount: 2,
							calls: [
								{ status: 201, revision: 1, secret: "private token" },
								{ status: 201, revision: 1, path: "private/path.md" },
							],
							retryIdentityMatches: true,
							queue: {
								pendingOperationCount: 1,
								pendingApplyCount: 0,
								attentionCount: 4,
								fixtureOperationCount: 1,
								otherPathOperationCount: 2,
								fixtureOperations: [
									{
										ordinal: "retry",
										state: "sent",
										operation: "put",
										preconditionKind: "absent",
										key: "private-key",
										path: "private/path.md",
										payload: "private bytes",
										precondition: { epoch: "private" },
									},
								],
							},
							secret: "private token",
						},
					},
					unapproved: "private token and note bytes",
				},
			},
			{ includeAc30Diagnostic: true },
		);

		expect(summary).toMatchObject({
			ac30FinalAssertion: {
				code: "AC30_ASSERT_FINAL_CALL_COUNT",
				expected: 3,
				observed: 2,
				diagnostic: {
					callCount: 2,
					calls: [
						{ ordinal: "first", status: 201, revision: 1 },
						{ ordinal: "retry", status: 201, revision: 1 },
					],
					retryIdentityMatches: true,
					queue: {
						pendingOperationCount: 1,
						pendingApplyCount: 0,
						attentionCount: 4,
						fixtureOperationCount: 1,
						otherPathOperationCount: 2,
						fixtureOperations: [
							{
								ordinal: "retry",
								state: "sent",
								operation: "put",
								preconditionKind: "absent",
							},
						],
					},
				},
			},
		});
		expect(JSON.stringify(summary)).not.toMatch(
			/private token|note bytes|private\/path|private bytes|private-key/,
		);
	});

	it("keeps safe AC-30 assertion data when diagnostic getters fail", () => {
		const diagnostic = new Proxy(
			{},
			{
				/** Simulates a malformed diagnostic getter at the host boundary. */
				get() {
					throw new Error("private diagnostic detail");
				},
			},
		);
		const summary = safeCaseResult(
			"AC-30",
			"controlled",
			{
				status: "failed",
				failureStage: "action",
				failureReason: "AC30_ASSERT_FINAL_CALL_COUNT",
				cleanupStatus: "passed",
				caseEvidence: {
					ac30FinalAssertion: {
						code: "AC30_ASSERT_FINAL_CALL_COUNT",
						expected: 3,
						observed: 2,
						diagnostic,
					},
				},
			},
			{ includeAc30Diagnostic: true },
		);

		expect(summary.ac30FinalAssertion).toMatchObject({
			code: "AC30_ASSERT_FINAL_CALL_COUNT",
			expected: 3,
			observed: 2,
		});
		expect(JSON.stringify(summary)).not.toContain("private diagnostic detail");
	});

	it("summarizes results without returning secret or note values", () => {
		const summary = safeCaseResult("AC-02", "controlled", {
			status: "passed",
			failureStage: null,
			failureReason: null,
			cleanupStatus: "passed",
			token: "secret-token",
			authorizationCode: "private-code",
			cookie: "session-cookie",
			noteBody: "private note bytes",
			path: "oab-8.8/case.md",
		});

		expect(summary).toEqual({
			caseId: "AC-02",
			evidence: "controlled",
			status: "passed",
			failureStage: null,
			failureReason: null,
			cleanupStatus: "passed",
		});
		expect(JSON.stringify(summary)).not.toMatch(
			/secret-token|private-code|session-cookie|private note bytes/,
		);
		expect(() =>
			safeCaseResult("AC-02", "controlled", { status: "unknown" }),
		).toThrow("Invalid case status");
		expect(
			safeCaseResult("AC-30", "controlled", {
				status: "failed",
				failureStage: "action",
				failureReason: "Bearer private-token",
				cleanupStatus: "passed",
			}),
		).toEqual({
			caseId: "AC-30",
			evidence: "controlled",
			status: "failed",
			failureStage: "action",
			failureReason: "unknown-error",
			cleanupStatus: "passed",
		});
	});

	// Covers the OAB-40 feed-replay regression across modify and debounce timing orders.
	const ac30TimingCases = [
		{ name: "delayed modify admission", eventDelay: 5_000, holdModifyMs: 0 },
		{
			name: "debounce before retry wait",
			eventDelay: 500,
			holdModifyMs: 1_000,
		},
		{
			name: "debounce while first PUT is held",
			eventDelay: 0,
			holdModifyMs: 2_100,
		},
	] as const;
	it.each(ac30TimingCases)(
		"checks AC-30 feed replay: $name",
		async (scenario) => {
			const cases = [scenario] as const;
			const outcomes: Array<{
				name: string;
				status: string;
				failureReason: string | null;
				allCalls: number;
				targetCalls: number;
				callPaths: string[];
				feedRowsRead: number;
				feedSequences: number[];
				serviceRevision: number;
				cursor: number | null;
				canonicalIsOriginal: boolean;
				localFileStates: Array<{
					path: string;
					original: boolean;
					edited: boolean;
				}>;
				pendingOperationCount: number;
				fixtureRetryKeyEqual: boolean;
				fixturePreconditions: string[];
				debounceFired: boolean;
				debounceBeforeRetryDue: boolean;
				debounceWhileFirstPutPending: boolean;
			}> = [];

			for (const scenario of cases) {
				const storage = new MemoryStorage();
				const vault = new AcceptanceMemoryVault();
				const calls: Array<{
					path: string;
					text: string;
					key: string;
					precondition: DevicePrecondition;
				}> = [];
				const versions = new Map<string, { text: string; hash: string }>();
				const serviceFiles = new Map<
					string,
					{ rev: number; text: string; hash: string }
				>();
				const receipts = new Map<string, PublicationReceipt>();
				const feed: Array<{
					seq: number;
					op: "put";
					path: string;
					etag: string;
					hash: string;
					origin: string;
					at: number;
				}> = [];
				const feedReads: number[] = [];
				const returnedFeedSequences: number[] = [];
				let sequence = 0;
				let modifyEventObserved = false;
				let debounceFired = false;
				let debounceBeforeRetryDue = false;
				let debounceWhileFirstPutPending = false;
				const fixturePath = "oab-37/ac-30-response-lost-20261105-01.md";
				const originalText =
					"# AC-30 response-loss fixture\\n\\nOriginal immutable payload.\\n";
				const editedText = `${originalText}\\nLocal successor edit.\\n`;
				/** Releases a held synthetic modify event after the chosen timing delay. */
				let releaseModify = () => {};
				/** Signals that the synthetic modify callback reached its hold. */
				let markModifyStarted = () => {};
				const modifyCanReturn = new Promise<void>((resolve) => {
					releaseModify = resolve;
				});
				const modifyStarted = new Promise<void>((resolve) => {
					markModifyStarted = resolve;
				});
				/** Signals that the synthetic service received its first publication request. */
				let firstPutStarted = () => {};
				const firstPut = new Promise<void>((resolve) => {
					firstPutStarted = resolve;
				});
				/** Rejects the first-boundary wait when the sync cycle reports an error. */
				let rejectFirstCycleError = (_error: unknown) => {};
				const firstCycleError = new Promise<never>((_resolve, reject) => {
					rejectFirstCycleError = reject;
				});
				const remote: PublicationRemote & {
					manifest: (token: string | null) => Promise<{
						epoch: string;
						head_seq: number;
						next_page: null;
						entries: [];
					}>;
					changes: (
						requestEpoch: string,
						since: number,
					) => Promise<{
						epoch: string;
						head_seq: number;
						entries: typeof feed;
					}>;
					createText: () => Promise<never>;
				} = {
					readAuthority: async (path, requestEpoch, requestedRevision) => {
						const version = versions.get(`${path}:${requestedRevision}`);
						if (!version || requestEpoch !== epoch)
							throw new Error("Pinned revision unavailable");
						return {
							deleted: false,
							text: version.text,
							epoch,
							rev: requestedRevision,
							hash: version.hash,
						};
					},
					readCurrentAuthority: async (path) => {
						const file = serviceFiles.get(path);
						if (!file) throw new SyncTransportError(404, "not_found");
						return {
							deleted: false,
							text: file.text,
							epoch,
							rev: file.rev,
							hash: file.hash,
						};
					},
					put: async (path, text, precondition, key) => {
						if (calls.length === 0) firstPutStarted();
						calls.push({
							path,
							text,
							key,
							precondition: structuredClone(precondition),
						});
						const prior = receipts.get(key);
						if (prior) return structuredClone(prior);
						const current = serviceFiles.get(path);
						const valid =
							precondition.kind === "absent"
								? current === undefined
								: precondition.epoch === epoch &&
									precondition.rev === current?.rev;
						if (!valid)
							throw new SyncTransportError(412, "precondition_failed");
						const fileRevision = (current?.rev ?? 0) + 1;
						sequence += 1;
						const hash = await hashAcceptanceText(text);
						const receipt: PublicationReceipt = {
							status: current ? 200 : 201,
							path,
							etag: formatETag(epoch, fileRevision),
							seq: sequence,
							size: new TextEncoder().encode(text).byteLength,
							hash,
							deleted: false,
						};
						versions.set(`${path}:${fileRevision}`, { text, hash });
						serviceFiles.set(path, { rev: fileRevision, text, hash });
						feed.push({
							seq: sequence,
							op: "put",
							path,
							etag: receipt.etag,
							hash,
							origin: "test-device",
							at: Date.now(),
						});
						receipts.set(key, receipt);
						return structuredClone(receipt);
					},
					delete: async () => {
						throw new Error("Unexpected delete");
					},
					rename: async () => {
						throw new Error("Unexpected rename");
					},
					manifest: async () => ({
						epoch,
						head_seq: sequence,
						next_page: null,
						entries: [],
					}),
					changes: async (requestEpoch, since) => {
						feedReads.push(since);
						const entries = feed.filter((entry) => entry.seq > since);
						returnedFeedSequences.push(...entries.map((entry) => entry.seq));
						return {
							epoch: requestEpoch,
							head_seq: sequence,
							entries,
						};
					},
					createText: async () => {
						throw new Error("Unexpected enrollment create");
					},
				};
				const journal = await DeviceJournal.open(storage);
				await journal.resetEpoch(epoch);
				await journal.setCursor(epoch, 0);
				for (const suffix of ["one", "two", "three"])
					await journal.recordAttention(`oab-8.8/${suffix}.md`, "retained");
				const applyEngine = new TextApplyEngine(
					journal,
					vault,
					{
						read: async (path, requestEpoch, requestedRevision) => {
							const authority = await remote.readAuthority(
								path,
								requestEpoch,
								requestedRevision,
							);
							return authority.deleted ? null : authority.text;
						},
					},
					{ deviceName: "Synthetic acceptance test" },
				);
				const publication = new PublicationController(journal, vault, remote, {
					applyEngine,
					now: () => Date.now(),
					recoverPrecondition: async () => reconciliation.replay(),
				});
				const reconciliation = new ReconciliationController(
					journal,
					applyEngine,
					vault,
					remote,
				);
				const desktopSync = new DesktopSyncController({
					cycle: async () => {
						await reconciliation.resume();
						await publication.scan();
						await publication.flush();
						await reconciliation.replay();
					},
					onEvent: (event) => publication.observe(event),
					onError: rejectFirstCycleError,
					host: {
						setTimeout: (callback, delay) =>
							setTimeout(() => {
								if (modifyEventObserved && delay === 2_000 && !debounceFired) {
									debounceFired = true;
									const retryAt = journal
										.snapshot()
										.pending_ops.find(
											(operation: PendingOperation) =>
												operation.state === "sent",
										)?.retry_at;
									debounceWhileFirstPutPending = retryAt === undefined;
									debounceBeforeRetryDue =
										retryAt === undefined || retryAt > Date.now();
								}
								callback();
							}, delay) as unknown as number,
						clearTimeout: (handle) =>
							clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
						setInterval: () => 1,
						clearInterval: () => undefined,
					},
				});
				const scripts = createAc30CaseScripts("/Users/test");
				const hostScript = createCaseScript(
					"AC-30",
					scripts.action,
					scripts.cleanup,
				);
				const originalPut = remote.put;
				let run: Promise<string> | null = null;
				const host = {
					vault: {
						adapter: { getBasePath: () => vaults["dev-2"] },
						create: async (path: string, text: string) => {
							if (!(await vault.create(path, text)))
								throw new Error("Path exists");
							await desktopSync.observe({ type: "create", path });
							return { path };
						},
						modify: async (file: { path: string }, text: string) => {
							vault.files.set(file.path, text);
							if (scenario.eventDelay > 0)
								setTimeout(() => {
									modifyEventObserved = true;
									void desktopSync.observe({
										type: "modify",
										path: file.path,
									});
								}, scenario.eventDelay);
							else {
								modifyEventObserved = true;
								await desktopSync.observe({ type: "modify", path: file.path });
							}
							if (scenario.holdModifyMs > 0) {
								markModifyStarted();
								await modifyCanReturn;
							}
							return { path: file.path };
						},
						read: async (file: { path: string }) => vault.read(file.path),
						getAbstractFileByPath: (path: string) =>
							vault.files.has(path) ? { path } : null,
					},
					plugins: {
						plugins: {
							"ai-bridge": {
								journal,
								composition: { publication },
								desktopSync,
								sessionStatus: "connected",
								syncPaused: false,
							},
						},
					},
				};
				try {
					run = (
						new Function("app", `return ${hostScript}`) as (
							app: unknown,
						) => Promise<string>
					)(host);
					await Promise.race([
						firstPut,
						firstCycleError,
						run.then((output) => {
							throw new Error(output);
						}),
					]);
					if (scenario.holdModifyMs > 0) {
						await modifyStarted;
						await new Promise((resolve) =>
							setTimeout(resolve, scenario.holdModifyMs),
						);
						releaseModify();
					}
					const output = await run;
					const record = JSON.parse(output.slice("OAB8CASE:".length));
					expect(remote.put).toBe(originalPut);
					expect(globalThis).not.toHaveProperty("__oab8Ac30Restore");
					outcomes.push({
						name: scenario.name,
						status: record.status,
						failureReason: record.failureReason,
						allCalls: calls.length,
						targetCalls: calls.filter((call) => call.path === fixturePath)
							.length,
						callPaths: calls.map((call) =>
							call.path === fixturePath ? "fixture" : "other",
						),
						feedRowsRead: feedReads.length,
						feedSequences: returnedFeedSequences,
						serviceRevision: serviceFiles.get(fixturePath)?.rev ?? 0,
						cursor: journal.snapshot().cursor,
						canonicalIsOriginal: vault.files.get(fixturePath) === originalText,
						localFileStates: [...vault.files].map(([path, text]) => ({
							path: path === fixturePath ? "fixture" : "other",
							original: text === originalText,
							edited: text === editedText,
						})),
						pendingOperationCount: journal.snapshot().pending_ops.length,
						fixtureRetryKeyEqual:
							calls.filter((call) => call.path === fixturePath).length >= 2 &&
							calls.filter((call) => call.path === fixturePath)[0]?.key ===
								calls.filter((call) => call.path === fixturePath)[1]?.key,
						fixturePreconditions: calls
							.filter((call) => call.path === fixturePath)
							.map((call) => call.precondition.kind),
						debounceFired,
						debounceBeforeRetryDue,
						debounceWhileFirstPutPending,
					});
					if (scenario.eventDelay > 0)
						await new Promise((resolve) => setTimeout(resolve, 5_000));
				} finally {
					releaseModify();
					try {
						if (run) await run;
						await desktopSync.waitForIdle();
					} finally {
						const restore = Reflect.get(globalThis, "__oab8Ac30Restore");
						try {
							if (typeof restore === "function")
								Reflect.apply(restore, undefined, []);
						} finally {
							remote.put = originalPut;
							Reflect.deleteProperty(globalThis, "__oab8Ac30Restore");
							desktopSync.close();
							reconciliation.close();
							publication.close();
							journal.close();
						}
					}
				}
			}

			expect(
				outcomes.map(
					({
						name,
						status,
						failureReason,
						allCalls,
						targetCalls,
						callPaths,
						serviceRevision,
						fixtureRetryKeyEqual,
						fixturePreconditions,
						debounceFired,
						debounceBeforeRetryDue,
						debounceWhileFirstPutPending,
					}) => ({
						name,
						status,
						failureReason,
						allCalls,
						targetCalls,
						callPaths,
						serviceRevision,
						fixtureRetryKeyEqual,
						fixturePreconditions,
						debounceFired,
						debounceBeforeRetryDue,
						debounceWhileFirstPutPending,
					}),
				),
			).toEqual([
				{
					name: scenario.name,
					status: "passed",
					failureReason: null,
					allCalls: 3,
					targetCalls: 3,
					callPaths: ["fixture", "fixture", "fixture"],
					serviceRevision: 2,
					fixtureRetryKeyEqual: true,
					fixturePreconditions: ["absent", "absent", "match"],
					debounceFired: scenario.holdModifyMs > 0,
					debounceBeforeRetryDue: scenario.holdModifyMs > 0,
					debounceWhileFirstPutPending:
						scenario.holdModifyMs > 0 && scenario.eventDelay === 0,
				},
			]);
			expect(outcomes.every((outcome) => outcome.feedRowsRead > 0)).toBe(true);
		},
		320_000,
	);
});
