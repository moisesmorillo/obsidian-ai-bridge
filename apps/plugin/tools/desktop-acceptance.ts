import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Identifies one authorized desktop vault and the exact path that Obsidian must resolve. */
export type DesktopVaultId = "dev-1" | "dev-2";

/** Limits host results to non-secret evidence fields. */
export interface DesktopCaseSummary {
	caseId: string;
	evidence: "service" | "controlled" | "local";
	status: "passed" | "failed" | "blocked";
}

/** Returns the only two vault paths that this acceptance driver may target. */
export function authorizedVaults(
	home = homedir(),
): Record<DesktopVaultId, string> {
	return {
		"dev-1": resolve(home, "vaults/obsidian-ai-bridge-dev"),
		"dev-2": resolve(home, "vaults/obsidian-ai-bridge-dev-2"),
	};
}

/** Rejects unknown IDs and path mismatches before any host command can run. */
export function assertAuthorizedVault(
	id: string,
	resolvedPath: string,
	home = homedir(),
): string {
	const allowed = authorizedVaults(home);
	if (
		(id !== "dev-1" && id !== "dev-2") ||
		!isAbsolute(resolvedPath) ||
		resolve(resolvedPath) !== allowed[id]
	)
		throw new Error("Unauthorized vault target");
	return allowed[id];
}

/** Accepts only the expected PKCE authorization request and rejects callback credentials. */
export function validateAuthorizationUrl(value: string): string {
	try {
		const url = new URL(value);
		const parameters = url.searchParams;
		if (
			url.origin !== "https://obsidian-bridge.mmorillo.dev" ||
			url.pathname !== "/authorize" ||
			url.hash ||
			parameters.get("response_type") !== "code" ||
			!parameters.get("client_id") ||
			!parameters.get("state") ||
			!parameters.get("code_challenge") ||
			parameters.get("code_challenge_method") !== "S256" ||
			["code", "access_token", "refresh_token", "cookie"].some((key) =>
				parameters.has(key),
			)
		)
			throw new Error("Invalid authorization URL");
		return value;
	} catch {
		throw new Error("Invalid authorization URL");
	}
}

/** Validates the private-scheme callback without returning its one-time values. */
export function validateCallbackUrl(value: string): void {
	try {
		const url = new URL(value);
		const parameters = url.searchParams;
		const keys = [...parameters.keys()];
		if (
			url.protocol !== "obsidian:" ||
			url.hostname !== "ai-bridge" ||
			url.pathname !== "/callback" ||
			url.username ||
			url.password ||
			url.port ||
			url.hash ||
			parameters.getAll("code").length !== 1 ||
			!parameters.get("code") ||
			parameters.getAll("state").length !== 1 ||
			!parameters.get("state") ||
			parameters.getAll("iss").length > 1 ||
			keys.some((key) => !["code", "state", "iss"].includes(key))
		)
			throw new Error("Invalid device callback");
	} catch {
		throw new Error("Invalid device callback");
	}
}

/** Builds a summary from explicit safe fields and discards every other result value. */
export function safeCaseResult(
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	result: Record<string, unknown>,
): DesktopCaseSummary {
	const status = result.status;
	if (status !== "passed" && status !== "failed" && status !== "blocked")
		throw new Error("Invalid case status");
	return { caseId, evidence, status };
}

/** Runs one explicitly targeted Obsidian CLI command without exposing its output. */
export function runScopedObsidian(
	id: DesktopVaultId,
	vaultName: string,
	command: string,
	args: readonly string[],
	options: { executable?: string } = {},
): void {
	invokeScopedObsidian(id, vaultName, command, args, options);
}

/** Delivers one validated browser callback to the matching active plugin session. */
export function dispatchCapturedCallback(
	id: DesktopVaultId,
	vaultName: string,
	pageId: string,
	expectedPageId: string,
	callbackUrl: string,
	options: { executable?: string } = {},
): void {
	if (!pageId || pageId !== expectedPageId)
		throw new Error("Callback page mismatch");
	assertAuthorizedVault(id, authorizedVaults()[id]);
	validateCallbackUrl(callbackUrl);
	const url = new URL(callbackUrl);
	const callback = {
		code: url.searchParams.get("code") ?? "",
		state: url.searchParams.get("state") ?? "",
		...(url.searchParams.has("iss")
			? { iss: url.searchParams.get("iss") ?? "" }
			: {}),
	};
	const script = `(async () => {
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(authorizedVaults()[id])}) return "OAB8CALLBACK:blocked";
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.session?.callback) return "OAB8CALLBACK:blocked";
		try {
			await plugin.session.callback(${JSON.stringify(callback)});
			return "OAB8CALLBACK:passed";
		} catch {
			return "OAB8CALLBACK:failed";
		}
	})()`;
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8CALLBACK:");
	if (
		marker < 0 ||
		output.slice(marker + "OAB8CALLBACK:".length).trim() !== "passed"
	)
		throw new Error("Device callback was not accepted");
}

/** Checks browser capture metadata without returning any callback value. */
export function hasCapturedCallback(
	value: unknown,
	pageId: string,
	expectedPageId: string,
): boolean {
	if (!pageId || pageId !== expectedPageId) return false;
	return collectCallbackUrls(value).length === 1;
}

/** Clicks consent once and hands only its captured callback to the target plugin session. */
export function submitConsentAndDispatch(
	id: DesktopVaultId,
	vaultName: string,
	pageId: string,
	expectedPageId: string,
	approveButtonRef: string,
	options: { executable?: string; browserExecutable?: string } = {},
): void {
	if (!pageId || pageId !== expectedPageId)
		throw new Error("Callback page mismatch");
	if (!approveButtonRef || !/^[A-Za-z0-9@_-]+$/.test(approveButtonRef))
		throw new Error("Invalid consent control");
	assertAuthorizedVault(id, authorizedVaults()[id]);
	runScopedObsidian(id, vaultName, "vault", ["info=path"], options);
	const browserExecutable = options.browserExecutable ?? "orca";
	const click = spawnSync(
		browserExecutable,
		["click", "--page", pageId, "--element", approveButtonRef, "--json"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	const network = spawnSync(
		browserExecutable,
		["network", "--page", pageId, "--limit", "50", "--json"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	const tabs = spawnSync(browserExecutable, ["tab", "list", "--json"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	const pageUrl = pageUrlForId(tabs.stdout, pageId);
	const candidates = [
		...collectCallbackUrls(click.stdout),
		...collectCallbackUrls(network.stdout),
		...collectCallbackUrls(pageUrl),
	];
	const unique = [...new Set(candidates)];
	if (unique.length !== 1) {
		cancelPendingAuthorization(id, vaultName, options);
		throw new Error("Callback capture unavailable");
	}
	try {
		dispatchCapturedCallback(
			id,
			vaultName,
			pageId,
			expectedPageId,
			unique[0],
			options,
		);
	} catch {
		cancelPendingAuthorization(id, vaultName, options);
		throw new Error("Device callback was not accepted");
	}
}

/** Captures one PKCE URL, restores the browser opener, and writes only to ignored scratch. */
export async function captureAuthorizationUrl(
	id: DesktopVaultId,
	vaultName: string,
	options: { executable?: string } = {},
): Promise<string> {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const script = `(async () => {
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.session?.host?.openBrowser) throw Error("Device session is unavailable");
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw Error("Vault path mismatch");
		const host = plugin.session.host;
		const original = host.openBrowser;
		let authorizationUrl;
		try {
			host.openBrowser = (url) => { authorizationUrl = url; };
			await plugin.session.connect();
		} finally {
			host.openBrowser = original;
		}
		if (!authorizationUrl) throw Error("Authorization URL was not captured");
		return "OAB8AUTH:" + encodeURIComponent(authorizationUrl);
	})()`;
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8AUTH:");
	if (marker < 0) throw new Error("Authorization URL capture failed");
	const encoded = output
		.slice(marker + "OAB8AUTH:".length)
		.trim()
		.replace(/^['"]|['"]$/g, "");
	let authorizationUrl: string;
	try {
		authorizationUrl = validateAuthorizationUrl(decodeURIComponent(encoded));
	} catch {
		throw new Error("Authorization URL capture failed");
	}
	const destination = resolve(
		process.cwd(),
		".superpowers/sdd/oab-8.8-desktop-gate",
		`${id}-authorization.url`,
	);
	await writeFile(destination, authorizationUrl, {
		encoding: "utf8",
		mode: 0o600,
	});
	return destination;
}

/** Runs one case as one host evaluation and returns only its fixed safe status fields. */
export function runHostCase(
	id: DesktopVaultId,
	vaultName: string,
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	actionScript: string,
	cleanupScript: string,
	options: { executable?: string } = {},
): DesktopCaseSummary {
	const script = createCaseScript(caseId, actionScript, cleanupScript);
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8CASE:");
	if (marker < 0) throw new Error("Obsidian case result was unavailable");
	const payload = output.slice(marker + "OAB8CASE:".length).trim();
	const objectEnd = payload.indexOf("}");
	if (objectEnd < 0) throw new Error("Obsidian case result was unavailable");
	try {
		return safeCaseResult(
			caseId,
			evidence,
			JSON.parse(payload.slice(0, objectEnd + 1)),
		);
	} catch {
		throw new Error("Obsidian case result was invalid");
	}
}

/** Adds a failure-safe cleanup boundary to trusted case code without returning its data. */
export function createCaseScript(
	caseId: string,
	actionScript: string,
	cleanupScript: string,
): string {
	if (
		caseId.length !== 5 ||
		!caseId.startsWith("AC-") ||
		caseId.charCodeAt(3) < 48 ||
		caseId.charCodeAt(3) > 57 ||
		caseId.charCodeAt(4) < 48 ||
		caseId.charCodeAt(4) > 57
	)
		throw new Error("Invalid acceptance case ID");
	return `(async () => {
		let status = "passed";
		try {
			await (async () => { ${actionScript} })();
		} catch {
			status = "failed";
		} finally {
			try {
				await (async () => { ${cleanupScript} })();
			} catch {
				status = "failed";
			}
		}
		return "OAB8CASE:" + JSON.stringify({ caseId: ${JSON.stringify(caseId)}, status });
	})()`;
}

/** Cancels pending consent after a failed single-submit capture or dispatch. */
function cancelPendingAuthorization(
	id: DesktopVaultId,
	vaultName: string,
	options: { executable?: string },
): void {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const script = `(async () => {
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) return "OAB8CANCEL:blocked";
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.session?.cancel) return "OAB8CANCEL:failed";
		plugin.session.cancel();
		return plugin.session.pending ? "OAB8CANCEL:failed" : "OAB8CANCEL:passed";
	})()`;
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8CANCEL:");
	if (
		marker < 0 ||
		output.slice(marker + "OAB8CANCEL:".length).trim() !== "passed"
	)
		throw new Error("Could not cancel pending authorization");
}

/** Finds one page URL from tab-list JSON without exposing its callback values. */
function pageUrlForId(output: string, pageId: string): string | null {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object") return null;
		const result = Reflect.get(parsed, "result");
		if (!result || typeof result !== "object") return null;
		const tabs = Reflect.get(result, "tabs");
		if (!Array.isArray(tabs)) return null;
		const page = tabs.find(
			(tab) =>
				tab &&
				typeof tab === "object" &&
				Reflect.get(tab, "browserPageId") === pageId,
		);
		if (!page || typeof page !== "object") return null;
		const url = Reflect.get(page, "url");
		return typeof url === "string" ? url : null;
	} catch {
		return null;
	}
}

/** Collects only exact private callback URIs from captured browser data in memory. */
function collectCallbackUrls(value: unknown): string[] {
	const values: unknown[] = [value];
	const urls = new Set<string>();
	while (values.length > 0) {
		const current = values.pop();
		if (typeof current === "string") {
			try {
				const parsed: unknown = JSON.parse(current);
				if (parsed !== current) values.push(parsed);
			} catch {
				// Orca can return a raw callback string instead of JSON.
			}
			try {
				validateCallbackUrl(current);
				urls.add(current);
			} catch {
				// Captured browser strings can be unrelated to the private callback.
			}
		} else if (Array.isArray(current)) values.push(...current);
		else if (current && typeof current === "object")
			values.push(...Object.values(current));
	}
	return [...urls];
}

/** Verifies an exact vault path before running a CLI command and captures output internally. */
function invokeScopedObsidian(
	id: DesktopVaultId,
	vaultName: string,
	command: string,
	args: readonly string[],
	options: { executable?: string } = {},
): string {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	if (!vaultName || !/^[A-Za-z0-9 _-]+$/.test(vaultName))
		throw new Error("Invalid Obsidian vault name");
	const executable = options.executable ?? "/opt/homebrew/bin/obsidian";
	const identity = spawnSync(
		executable,
		[`vault=${vaultName}`, "vault", "info=path"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	if (identity.status !== 0 || identity.stdout.trim() !== target)
		throw new Error("Obsidian resolved an unauthorized vault path");
	const result = spawnSync(
		executable,
		[`vault=${vaultName}`, command, ...args],
		{ encoding: "utf8", timeout: 60_000 },
	);
	if (result.error || result.status !== 0)
		throw new Error("Obsidian command failed");
	return result.stdout;
}

/** Installs the checked-in plugin bundle through the exact target vault's Obsidian adapter. */
export async function installScopedPlugin(
	id: DesktopVaultId,
	vaultName: string,
	distDirectory: string,
	options: { executable?: string } = {},
): Promise<string> {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const manifestText = await readFile(
		resolve(distDirectory, "manifest.json"),
		"utf8",
	);
	const manifest: unknown = JSON.parse(manifestText);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("id" in manifest) ||
		manifest.id !== "ai-bridge" ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	)
		throw new Error("Unexpected plugin artifact identity");
	const mainText = await readFile(resolve(distDirectory, "main.js"), "utf8");
	const script = createInstallScript(id, target, manifestText, mainText);
	runScopedObsidian(id, vaultName, "eval", [`code=${script}`], options);
	runScopedObsidian(
		id,
		vaultName,
		"plugin:enable",
		[`id=${manifest.id}`],
		options,
	);
	const verifyScript = `(async () => {
		const pluginId = ${JSON.stringify(manifest.id)};
		if (!app.plugins.enabledPlugins.has(pluginId) || !app.plugins.plugins?.[pluginId]) throw Error("Plugin is not active");
		if (app.plugins.manifests?.[pluginId]?.version !== ${JSON.stringify(manifest.version)}) throw Error("Plugin revision mismatch");
		return JSON.stringify({ status: "passed" });
	})()`;
	runScopedObsidian(id, vaultName, "eval", [`code=${verifyScript}`], options);
	return manifest.version;
}

/** Creates an Obsidian-host script that refuses mismatched existing files before writing. */
export function createInstallScript(
	id: DesktopVaultId,
	target: string,
	manifestText: string,
	mainText: string,
	home = homedir(),
): string {
	const authorizedTarget = assertAuthorizedVault(id, target, home);
	const manifest: unknown = JSON.parse(manifestText);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("id" in manifest) ||
		manifest.id !== "ai-bridge" ||
		!("version" in manifest) ||
		typeof manifest.version !== "string"
	)
		throw new Error("Unexpected plugin artifact identity");
	const expectedVersion = JSON.stringify(manifest.version);
	/** Encodes plugin text for safe transport as one CLI argument. */
	const base64 = (value: string) =>
		Buffer.from(value, "utf8").toString("base64");
	const targetValue = JSON.stringify(authorizedTarget);
	const manifestValue = JSON.stringify(base64(manifestText));
	const mainValue = JSON.stringify(base64(mainText));
	return `(async () => {
		const adapter = app.vault.adapter;
		if (adapter.getBasePath() !== ${targetValue}) throw Error("Vault path mismatch");
		const id = "ai-bridge";
		const directory = ".obsidian/plugins/" + id;
		const decode = (value) => new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
		const manifestText = decode(${manifestValue});
		const manifest = JSON.parse(manifestText);
		const bundle = decode(${mainValue});
		if (manifest.id !== id) throw Error("Plugin ID mismatch");
		manifest.dir = directory;
		app.plugins.manifests[id] = manifest;
		if (!(await adapter.exists(directory))) await adapter.mkdir(directory);
		for (const [name, content] of [["manifest.json", manifestText], ["main.js", bundle]]) {
			const path = directory + "/" + name;
			if (await adapter.exists(path)) {
				const old = await adapter.read(path);
				if (old !== content) {
					const backup = path + ".oab-8.8-backup";
					if (await adapter.exists(backup)) {
						if (await adapter.read(backup) !== old) throw Error("Plugin backup differs");
					} else {
						await adapter.write(backup, old);
					}
					await adapter.write(path, content);
				}
			} else {
				await adapter.write(path, content);
			}
		}
		for (const [name, content] of [["manifest.json", manifestText], ["main.js", bundle]]) {
			if (await adapter.read(directory + "/" + name) !== content) throw Error("Plugin artifact mismatch");
		}
		if (app.plugins.enabledPlugins.has(id)) await app.plugins.disablePlugin(id);
		await app.plugins.loadPlugin(id);
		await app.plugins.enablePlugin(id);
		if (!app.plugins.enabledPlugins.has(id)) throw Error("Plugin did not enable");
		if (app.plugins.manifests[id]?.version !== ${expectedVersion}) throw Error("Plugin revision mismatch");
		return JSON.stringify({ status: "passed" });
	})()`;
}

/** Runs the explicit install or vault-path verification command for a test vault. */
async function runCommand(arguments_: readonly string[]): Promise<void> {
	const [action, id, vaultName] = arguments_;
	if (
		(action !== "install" && action !== "verify") ||
		(id !== "dev-1" && id !== "dev-2") ||
		!vaultName
	)
		throw new Error(
			"Usage: desktop-acceptance.ts <install|verify> <dev-1|dev-2> <vault-name>",
		);
	if (action === "verify") {
		runScopedObsidian(id, vaultName, "vault", ["info=path"]);
		console.log(`Verified authorized target ${id}`);
		return;
	}
	const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
	const version = await installScopedPlugin(id, vaultName, distDirectory);
	console.log(`Installed plugin version ${version} in ${id}`);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await runCommand(process.argv.slice(2));
}
