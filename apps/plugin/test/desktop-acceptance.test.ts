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
	DevicePreconditionSchema,
	formatETag,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";
import { SyncTransportError } from "../src/sync/remote-text";
import {
	assertAuthorizedVault,
	authorizedVaults,
	classifyAc13PreflightFiles,
	createAc04BaselineScript,
	createAc13CaseScripts,
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

describe("desktop acceptance safety", () => {
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
		expect(ac30.action).toContain("oab-8.8/ac-30-response-lost-20261104-06.md");
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
			'recordAc30FinalAssertion("AC30_ASSERT_FINAL_CALL_COUNT", "private identity", 2); throw Error("AC30_ASSERT_FINAL_CALL_COUNT");',
			"caseEvidence.cleanupRan=true;",
		);
		const output = await (
			new Function(`return ${script}`) as () => Promise<string>
		)();
		const record = JSON.parse(output.slice("OAB8CASE:".length));

		expect(record.caseEvidence).toEqual({
			ac30FinalAssertion: {
				code: "AC30_ASSERT_FINAL_CALL_COUNT",
				expected: "other",
				observed: 2,
			},
			cleanupRan: true,
		});
		expect(output).not.toContain("private identity");
	});

	it("projects only bounded AC-30 assertion observations", () => {
		const summary = safeCaseResult("AC-30", "controlled", {
			status: "failed",
			failureStage: "action",
			failureReason: "AC30_ASSERT_FINAL_CALL_COUNT",
			cleanupStatus: "passed",
			caseEvidence: {
				ac30FinalAssertion: {
					code: "AC30_ASSERT_FINAL_CALL_COUNT",
					expected: 3,
					observed: 2,
				},
				unapproved: "private token and note bytes",
			},
		});

		expect(summary).toMatchObject({
			ac30FinalAssertion: {
				code: "AC30_ASSERT_FINAL_CALL_COUNT",
				expected: 3,
				observed: 2,
			},
		});
		expect(JSON.stringify(summary)).not.toMatch(/private token|note bytes/);
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
});
