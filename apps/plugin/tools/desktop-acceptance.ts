import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileHttpErrorSchema } from "@obsidian-ai-bridge/protocol";
import {
	DEVICE_JOURNAL_FAILURE_STAGES,
	type DeviceJournalFailureStage,
} from "@plugin/sync/device-journal";
import type { DeleteResponseDiagnostic } from "@plugin/sync/remote-text";

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

/** Runs one explicitly targeted Obsidian CLI command without printing its output. */
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

/** Safe counts and lifecycle flags used to verify AC-20 enrollment preconditions. */
export interface Ac20VaultInspection {
	/** Current local authorization state. */
	sessionStatus: "disconnected" | "connecting" | "connected" | "reconnect";
	/** Current safe synchronization state, or null when no projection exists. */
	syncState:
		| "disconnected"
		| "syncing"
		| "settled"
		| "pending"
		| "attention"
		| "revoked"
		| "paused"
		| "backup failed"
		| null;
	/** Fixed non-secret journal failure stage, or null when no stage is recorded. */
	storageFailureStage: DeviceJournalFailureStage | null;
	/** Safe metadata from the latest DELETE response, or null before one. */
	deleteResponseDiagnostic: DeleteResponseDiagnostic | null;
	/** Number of local files in the AC-20 fixture directory. */
	localFixtureCount: number;
	/** Number of live paths recorded in the local journal base. */
	liveBaseCount: number;
	/** Number of live base paths that exist in the local Obsidian index. */
	localBaseFileCount: number;
	/** Number of live AC-20 paths recorded in the local journal base. */
	ac20LiveBaseCount: number;
	/** Live file count from a direct service summary, or null before connection. */
	serviceLiveCount: number | null;
	/** Live file count currently shown by the cached status projection. */
	displayedLiveCount: number | null;
	/** True when the local journal has an epoch. */
	hasEpoch: boolean;
	/** True when the local journal has a non-null feed cursor. */
	hasCursor: boolean;
	/** Number of durable pending operations. */
	pendingOperationCount: number;
	/** Number of durable pending apply steps. */
	pendingApplyCount: number;
}

/** Validates canonical DELETE metadata and discards every unlisted host field. */
function safeDeleteResponseDiagnostic(
	value: unknown,
): DeleteResponseDiagnostic | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object")
		throw new Error("Invalid AC-20 inspection result");
	const statusClass = Reflect.get(value, "statusClass");
	const errorKind = Reflect.get(value, "errorKind");
	const responseETagClass = Reflect.get(value, "responseETagClass");
	if (
		!["1xx", "2xx", "3xx", "4xx", "5xx", "other", null].includes(statusClass) ||
		(errorKind !== null && !FileHttpErrorSchema.safeParse(errorKind).success) ||
		!["strong", "weak", "missing", "invalid", "unavailable"].includes(
			responseETagClass,
		)
	)
		throw new Error("Invalid AC-20 inspection result");
	return {
		statusClass: statusClass as DeleteResponseDiagnostic["statusClass"],
		errorKind: errorKind as DeleteResponseDiagnostic["errorKind"],
		responseETagClass:
			responseETagClass as DeleteResponseDiagnostic["responseETagClass"],
	};
}

/** Projects fixed AC-20 counts, journal stages, and canonical DELETE metadata. */
export function safeAc20Inspection(value: unknown): Ac20VaultInspection {
	if (!value || typeof value !== "object")
		throw new Error("Invalid AC-20 inspection result");
	const sessionStatus = Reflect.get(value, "sessionStatus");
	const syncState = Reflect.get(value, "syncState");
	const storageFailureStage = Reflect.get(value, "storageFailureStage") ?? null;
	const deleteResponseDiagnostic = safeDeleteResponseDiagnostic(
		Reflect.get(value, "deleteResponseDiagnostic"),
	);
	const counts = [
		"localFixtureCount",
		"liveBaseCount",
		"localBaseFileCount",
		"ac20LiveBaseCount",
		"pendingOperationCount",
		"pendingApplyCount",
	].map((key) => Reflect.get(value, key));
	const serviceLiveCount = Reflect.get(value, "serviceLiveCount");
	const displayedLiveCount = Reflect.get(value, "displayedLiveCount");
	const hasEpoch = Reflect.get(value, "hasEpoch");
	const hasCursor = Reflect.get(value, "hasCursor");
	if (
		!["disconnected", "connecting", "connected", "reconnect"].includes(
			sessionStatus,
		) ||
		![
			"disconnected",
			"syncing",
			"settled",
			"pending",
			"attention",
			"revoked",
			"paused",
			"backup failed",
			null,
		].includes(syncState) ||
		counts.some(
			(count) =>
				typeof count !== "number" || !Number.isSafeInteger(count) || count < 0,
		) ||
		![serviceLiveCount, displayedLiveCount].every(
			(count) =>
				count === null ||
				(typeof count === "number" &&
					Number.isSafeInteger(count) &&
					count >= 0),
		) ||
		typeof hasEpoch !== "boolean" ||
		typeof hasCursor !== "boolean" ||
		(storageFailureStage !== null &&
			!DEVICE_JOURNAL_FAILURE_STAGES.some(
				(stage: DeviceJournalFailureStage) => stage === storageFailureStage,
			))
	)
		throw new Error("Invalid AC-20 inspection result");
	return {
		sessionStatus,
		syncState,
		storageFailureStage:
			storageFailureStage as DeviceJournalFailureStage | null,
		deleteResponseDiagnostic,
		localFixtureCount: counts[0],
		liveBaseCount: counts[1],
		localBaseFileCount: counts[2],
		ac20LiveBaseCount: counts[3],
		serviceLiveCount,
		displayedLiveCount,
		hasEpoch,
		hasCursor,
		pendingOperationCount: counts[4],
		pendingApplyCount: counts[5],
	};
}

/** Safe revision comparison from a fixed current-file GET without file identity values. */
export interface Ac04BaselineInspection {
	/** HTTP status class without the exact response number. */
	statusClass: "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";
	/** True only when the response path matches the fixed AC-04 path. */
	pathMatches: boolean;
	/** True or false when a strong ETag validates, otherwise null. */
	baselineRevisionChanged: boolean | null;
	/** Current tombstone state when response metadata validates, otherwise null. */
	deleted: boolean | null;
	/** True only when the response ETag is a canonical strong ETag. */
	strongResponseETag: boolean;
}

/** Validates one AC-04 result and discards all values outside its safe fields. */
export function safeAc04BaselineInspection(
	value: unknown,
): Ac04BaselineInspection {
	if (!value || typeof value !== "object")
		throw new Error("Invalid AC-04 baseline result");
	const statusClass = Reflect.get(value, "statusClass");
	const pathMatches = Reflect.get(value, "pathMatches");
	const baselineRevisionChanged = Reflect.get(value, "baselineRevisionChanged");
	const deleted = Reflect.get(value, "deleted");
	const strongResponseETag = Reflect.get(value, "strongResponseETag");
	if (
		!["1xx", "2xx", "3xx", "4xx", "5xx", "other"].includes(statusClass) ||
		typeof pathMatches !== "boolean" ||
		(baselineRevisionChanged !== null &&
			typeof baselineRevisionChanged !== "boolean") ||
		(deleted !== null && typeof deleted !== "boolean") ||
		typeof strongResponseETag !== "boolean"
	)
		throw new Error("Invalid AC-04 baseline result");
	return {
		statusClass,
		pathMatches,
		baselineRevisionChanged,
		deleted,
		strongResponseETag,
	};
}

/** Creates an exact-vault script for one read-only GET of the fixed AC-04 path. */
export function createAc04BaselineScript(
	target: string,
	home = homedir(),
): string {
	const authorizedTarget = assertAuthorizedVault("dev-1", target, home);
	const targetValue = JSON.stringify(authorizedTarget);
	const path = "oab-8.8/ac-04/shared.md";
	return `(async () => {
		if (app.vault.adapter.getBasePath() !== ${targetValue}) throw Error("Vault path mismatch");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.session?.requestResponse) throw Error("Plugin session unavailable");
		const path = ${JSON.stringify(path)};
		try {
			const response = await plugin.session.requestResponse("/v1/files/" + path.split("/").map(encodeURIComponent).join("/"), { method: "GET" });
			const statusClass = response.status >= 100 && response.status < 600 ? Math.floor(response.status / 100) + "xx" : "other";
			const etag = response.headers.etag;
			const match = typeof etag === "string" ? /^"(?=.*[a-f])[0-9a-f]{32}\\.([1-9][0-9]*)"$/.exec(etag) : null;
			const revision = match ? Number(match[1]) : null;
			const strongResponseETag = revision !== null && Number.isSafeInteger(revision);
			if (response.status !== 200) return "OAB8AC04BASELINE:" + JSON.stringify({ statusClass, pathMatches: false, baselineRevisionChanged: null, deleted: null, strongResponseETag });
			let body;
			try { body = JSON.parse(response.text); } catch { return "OAB8AC04BASELINE:" + JSON.stringify({ statusClass, pathMatches: false, baselineRevisionChanged: null, deleted: null, strongResponseETag }); }
			const pathMatches = body?.path === path;
			const identityMatches = pathMatches && body?.etag === etag && typeof body.deleted === "boolean";
			return "OAB8AC04BASELINE:" + JSON.stringify({ statusClass, pathMatches, baselineRevisionChanged: identityMatches && strongResponseETag ? revision !== 1 : null, deleted: identityMatches ? body.deleted : null, strongResponseETag });
		} catch {
			return "OAB8AC04BASELINE:" + JSON.stringify({ statusClass: "other", pathMatches: false, baselineRevisionChanged: null, deleted: null, strongResponseETag: false });
		}
	})()`;
}

/** Reads the fixed AC-04 service path through the exact authorized vault session. */
export function inspectAc04Baseline(
	vaultName: string,
	options: { executable?: string } = {},
): Ac04BaselineInspection {
	const script = createAc04BaselineScript(authorizedVaults()["dev-1"]);
	const output = invokeScopedObsidian(
		"dev-1",
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8AC04BASELINE:");
	if (marker < 0) throw new Error("AC-04 baseline result was unavailable");
	try {
		return safeAc04BaselineInspection(
			JSON.parse(output.slice(marker + "OAB8AC04BASELINE:".length).trim()),
		);
	} catch {
		throw new Error("AC-04 baseline result was invalid");
	}
}

/** Reads safe AC-20 file and service counts through the exact authorized vault. */
export function inspectAc20Vault(
	id: DesktopVaultId,
	vaultName: string,
	options: { executable?: string } = {},
): Ac20VaultInspection {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const script = `(async () => {
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw new Error("Vault path mismatch");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.journal?.snapshot || !plugin?.syncStatus) throw new Error("Plugin state unavailable");
		const journal = plugin.journal.snapshot();
		const status = plugin.syncStatus();
		const summary = plugin.composition?.readVaultSummary ? await plugin.composition.readVaultSummary() : null;
		const base = journal.base ?? {};
		const localPaths = new Set(app.vault.getFiles().map((file) => file.path));
		const liveBasePaths = Object.entries(base).filter(([, entry]) => !entry.deleted);
		const prefix = "oab-8.8/ac-20/";
		const result = {
			sessionStatus: plugin.sessionStatus,
			syncState: status?.state ?? null,
			storageFailureStage: status?.storageFailureStage ?? null,
			deleteResponseDiagnostic: status?.deleteResponseDiagnostic ?? null,
			localFixtureCount: [...localPaths].filter((path) => path.startsWith(prefix)).length,
			liveBaseCount: liveBasePaths.length,
			localBaseFileCount: liveBasePaths.filter(([path]) => localPaths.has(path)).length,
			ac20LiveBaseCount: liveBasePaths.filter(([path]) => path.startsWith(prefix)).length,
			serviceLiveCount: summary?.counts?.live ?? null,
			displayedLiveCount: status?.counts?.live ?? null,
			hasEpoch: journal.epoch !== undefined,
			hasCursor: journal.cursor !== undefined && journal.cursor !== null,
			pendingOperationCount: journal.pending_ops?.length ?? 0,
			pendingApplyCount: journal.pending_apply?.length ?? 0
		};
		return "OAB8AC20INSPECT:" + JSON.stringify(result);
	})()`;
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = output.lastIndexOf("OAB8AC20INSPECT:");
	if (marker < 0) throw new Error("AC-20 inspection was unavailable");
	try {
		return safeAc20Inspection(
			JSON.parse(output.slice(marker + "OAB8AC20INSPECT:".length).trim()),
		);
	} catch {
		throw new Error("AC-20 inspection result was invalid");
	}
}

/** Selects a safe local fixture phase for the approved two-device enrollment case. */
export type Ac20FixturePhase = "seed-dev1" | "prepare-dev2";

/** Synthetic text for the four first-hydration outcomes. */
const AC20_FIXTURES = {
	equal: {
		path: "oab-8.8/ac-20/equal.md",
		content: "OAB-8.8 AC-20 shared equal fixture.\n",
	},
	localOnly: {
		path: "oab-8.8/ac-20/local-only.md",
		content: "OAB-8.8 AC-20 local-only fixture.\n",
	},
	remoteOnly: {
		path: "oab-8.8/ac-20/remote-only.md",
		content: "OAB-8.8 AC-20 remote-only fixture.\n",
	},
	differentRemote: {
		path: "oab-8.8/ac-20/different.md",
		content: "OAB-8.8 AC-20 remote-side fixture.\n",
	},
	differentLocal: {
		path: "oab-8.8/ac-20/different.md",
		content: "OAB-8.8 AC-20 local-side fixture.\n",
	},
};

/** Builds a guarded Obsidian script to seed dev-1 or prepare disconnected dev-2. */
export function createAc20FixtureScript(
	id: DesktopVaultId,
	phase: Ac20FixturePhase,
	resolvedPath: string,
	home = homedir(),
): string {
	const target = assertAuthorizedVault(id, resolvedPath, home);
	if (
		(phase === "seed-dev1" && id !== "dev-1") ||
		(phase === "prepare-dev2" && id !== "dev-2")
	)
		throw new Error("AC-20 fixture phase does not match the vault");
	const fixtures =
		phase === "seed-dev1"
			? [
					AC20_FIXTURES.equal,
					AC20_FIXTURES.remoteOnly,
					AC20_FIXTURES.differentRemote,
				]
			: [
					AC20_FIXTURES.equal,
					AC20_FIXTURES.localOnly,
					AC20_FIXTURES.differentLocal,
				];
	const fixturePaths = Object.values(AC20_FIXTURES).map(({ path }) => path);
	return `(async () => {
		const target = ${JSON.stringify(target)};
		const adapter = app.vault.adapter;
		if (adapter.getBasePath() !== target) throw new Error("Vault path mismatch");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		const journal = plugin?.journal?.snapshot?.();
		if (!journal) throw new Error("Device journal unavailable");
		const fixtures = ${JSON.stringify(fixtures)};
		const allPaths = ${JSON.stringify(fixturePaths)};
		const base = journal.base ?? {};
		if (${JSON.stringify(phase)} === "prepare-dev2") {
			if (plugin.sessionStatus !== "disconnected" || plugin.session?.pending) throw new Error("Dev-2 is not disconnected");
			if (journal.epoch !== undefined || (journal.cursor !== undefined && journal.cursor !== null) || Object.keys(base).length > 0 || journal.pending_ops?.length || journal.pending_apply?.length || journal.attention?.length) throw new Error("Dev-2 already has sync state");
			for (const path of allPaths) if (Object.prototype.hasOwnProperty.call(base, path)) throw new Error("Dev-2 fixture already has a base");
			if (await adapter.exists(${JSON.stringify(AC20_FIXTURES.remoteOnly.path)})) throw new Error("Remote-only fixture exists in dev-2");
		} else {
			if (plugin.sessionStatus !== "connected" || journal.epoch === undefined || plugin.syncStatus?.().state !== "settled" || journal.pending_ops?.length || journal.pending_apply?.length || journal.attention?.length) throw new Error("Dev-1 is not settled");
		}
		for (const fixture of fixtures) {
			const { path, content } = fixture;
			if (await adapter.exists(path)) {
				if (await adapter.read(path) !== content) throw new Error("Fixture path contains different bytes");
				continue;
			}
			for (const folder of ["oab-8.8", "oab-8.8/ac-20"]) if (!(await adapter.exists(folder))) await app.vault.createFolder(folder);
			await app.vault.create(path, content);
		}
		return ${JSON.stringify(phase === "seed-dev1" ? "OAB8AC20:remote-fixtures-local" : "OAB8AC20:local-fixtures-ready")};
	})()`;
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

/** Describes a plugin artifact read back from an authorized Obsidian vault. */
export interface InstalledPluginArtifact {
	/** Version read from the installed plugin manifest. */
	version: string;
	/** SHA-256 of the installed main.js text. */
	mainSha256: string;
	/** SHA-256 of the installed manifest.json text. */
	manifestSha256: string;
}

/** Validates the exact bundle fingerprints returned by the host after installation. */
export function parseInstalledPluginArtifact(
	output: string,
	expected: InstalledPluginArtifact,
): InstalledPluginArtifact {
	const marker = "OAB8INSTALL:";
	const markerIndex = output.lastIndexOf(marker);
	if (markerIndex < 0)
		throw new Error("Plugin artifact verification was unavailable");
	const resultText = output
		.slice(markerIndex + marker.length)
		.trim()
		.replace(/^['"]|['"]$/g, "");
	let result: unknown;
	try {
		result = JSON.parse(resultText);
	} catch {
		throw new Error("Plugin artifact verification was invalid");
	}
	if (
		!result ||
		typeof result !== "object" ||
		!("status" in result) ||
		result.status !== "passed" ||
		!("version" in result) ||
		typeof result.version !== "string" ||
		!("mainSha256" in result) ||
		typeof result.mainSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.mainSha256) ||
		!("manifestSha256" in result) ||
		typeof result.manifestSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.manifestSha256)
	)
		throw new Error("Plugin artifact verification was invalid");
	if (
		result.version !== expected.version ||
		result.mainSha256 !== expected.mainSha256 ||
		result.manifestSha256 !== expected.manifestSha256
	)
		throw new Error(
			"Installed plugin artifact does not match the checked bundle",
		);
	return {
		version: result.version,
		mainSha256: result.mainSha256,
		manifestSha256: result.manifestSha256,
	};
}

/** Installs and hashes the checked-in bundle through one exact target vault. */
export async function installScopedPlugin(
	id: DesktopVaultId,
	vaultName: string,
	distDirectory: string,
	options: { executable?: string } = {},
): Promise<InstalledPluginArtifact> {
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
	const expected: InstalledPluginArtifact = {
		version: manifest.version,
		mainSha256: createHash("sha256").update(mainText, "utf8").digest("hex"),
		manifestSha256: createHash("sha256")
			.update(manifestText, "utf8")
			.digest("hex"),
	};
	const script = createInstallScript(id, target, manifestText, mainText);
	const installOutput = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	parseInstalledPluginArtifact(installOutput, expected);
	runScopedObsidian(
		id,
		vaultName,
		"plugin:enable",
		[`id=${manifest.id}`],
		options,
	);
	const verifyScript = `(async () => {
		const pluginId = ${JSON.stringify(manifest.id)};
		const adapter = app.vault.adapter;
		if (adapter.getBasePath() !== ${JSON.stringify(target)}) throw Error("Vault path mismatch");
		if (!app.plugins.enabledPlugins.has(pluginId) || !app.plugins.plugins?.[pluginId]) throw Error("Plugin is not active");
		if (app.plugins.manifests?.[pluginId]?.version !== ${JSON.stringify(manifest.version)}) throw Error("Plugin revision mismatch");
		const directory = ".obsidian/plugins/" + pluginId;
		/** Computes SHA-256 over UTF-8 text for installed artifact identity. */
		const hash = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const mainText = await adapter.read(directory + "/main.js");
		const manifestText = await adapter.read(directory + "/manifest.json");
		return "OAB8INSTALL:" + JSON.stringify({ status: "passed", version: app.plugins.manifests[pluginId].version, mainSha256: await hash(mainText), manifestSha256: await hash(manifestText) });
	})()`;
	const verifyOutput = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${verifyScript}`],
		options,
	);
	return parseInstalledPluginArtifact(verifyOutput, expected);
}

/** Creates a host script that preserves differing files and verifies loaded artifact hashes. */
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
		/** Computes SHA-256 over UTF-8 text for backup and artifact identity. */
		const hash = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
		for (const [name, content] of [["manifest.json", manifestText], ["main.js", bundle]]) {
			const path = directory + "/" + name;
			if (await adapter.exists(path)) {
				const old = await adapter.read(path);
				if (old !== content) {
					const firstBackup = path + ".oab-8.8-backup";
					let backup = firstBackup;
					if (await adapter.exists(backup) && await adapter.read(backup) !== old)
						backup = path + ".oab-8.8-backup-" + await hash(old);
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
		const mainFile = directory + "/main.js";
		const manifestFile = directory + "/manifest.json";
		const installedMain = await adapter.read(mainFile);
		const installedManifest = await adapter.read(manifestFile);
		if (installedMain !== bundle || installedManifest !== manifestText) throw Error("Plugin artifact mismatch");
		return "OAB8INSTALL:" + JSON.stringify({ status: "passed", version: app.plugins.manifests[id].version, mainSha256: await hash(installedMain), manifestSha256: await hash(installedManifest) });
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
	const artifact = await installScopedPlugin(id, vaultName, distDirectory);
	console.log(
		`Installed plugin version ${artifact.version} in ${id} with main SHA-256 ${artifact.mainSha256} and manifest SHA-256 ${artifact.manifestSha256}`,
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await runCommand(process.argv.slice(2));
}
