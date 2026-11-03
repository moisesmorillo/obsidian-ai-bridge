import { createHash } from "node:crypto";
import { formatETag } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import {
	assertAuthorizedVault,
	createAc04BaselineScript,
	createAc20FixtureScript,
	createCaseScript,
	createInstallScript,
	dispatchCapturedCallback,
	hasCapturedCallback,
	parseInstalledPluginArtifact,
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
		expect(await result).toBe('OAB8CASE:{"caseId":"AC-02","status":"failed"}');
		expect(globalThis).toHaveProperty("oab88CleanupRan", true);
		Reflect.deleteProperty(globalThis, "oab88CleanupRan");
	});

	it("summarizes results without returning secret or note values", () => {
		const summary = safeCaseResult("AC-02", "controlled", {
			status: "passed",
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
		});
		expect(JSON.stringify(summary)).not.toMatch(
			/secret-token|private-code|session-cookie|private note bytes/,
		);
		expect(() =>
			safeCaseResult("AC-02", "controlled", { status: "unknown" }),
		).toThrow("Invalid case status");
	});
});
