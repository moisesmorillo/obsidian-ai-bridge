import { describe, expect, it } from "vitest";
import {
	assertAuthorizedVault,
	createCaseScript,
	createInstallScript,
	dispatchCapturedCallback,
	hasCapturedCallback,
	runHostCase,
	runScopedObsidian,
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
