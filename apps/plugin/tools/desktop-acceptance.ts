import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FileHttpErrorSchema,
	type MutationReceipt,
	MutationReceiptSchema,
	PathSchema,
	parseETag,
} from "@obsidian-ai-bridge/protocol";
import {
	DEVICE_JOURNAL_FAILURE_STAGES,
	type DeviceJournalFailureStage,
} from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import type {
	CanonicalSyncErrorKind,
	DeleteResponseDiagnostic,
} from "@plugin/sync/remote-text";

/** Identifies one authorized desktop vault and the exact path that Obsidian must resolve. */
export type DesktopVaultId = "dev-1" | "dev-2";

/** Fixed case and error codes that may appear in host failure summaries. */
const SAFE_CASE_FAILURE_CODES = [
	"AC30_PRECONDITION_FAILED",
	"AC30_FIRST_BOUNDARY_FAILED",
	"AC30_SUCCESSOR_BOUNDARY_FAILED",
	"AC30_ASSERT_TARGET_VAULT",
	"AC30_ASSERT_PLUGIN_CONTROLS",
	"AC30_ASSERT_INITIAL_STATE",
	"AC30_ASSERT_FIXTURE_ABSENT",
	"AC30_ASSERT_REMOTE_CAPABILITIES",
	"AC30_ASSERT_SERVICE_PATH_ABSENT",
	"AC30_ASSERT_FIRST_COMMIT_AUTHORITY",
	"AC30_ASSERT_FIRST_COMMIT_QUEUE",
	"AC30_ASSERT_LOCAL_EDIT_READBACK",
	"AC30_ASSERT_SUCCESSOR_REVISION",
	"AC30_ASSERT_FINAL_INTERCEPTION_RESTORED",
	"AC30_INJECTED_RESPONSE_LOSS",
	"AC30_CLEANUP_RESTORE_FAILED",
	"AC30_TIMEOUT_FIRST_BOUNDARY_WAIT",
	"AC31_ASSERT_TARGET_VAULT",
	"AC31_ASSERT_PLUGIN_CONTROLS",
	"AC31_ASSERT_INITIAL_STATE",
	"AC31_ASSERT_FIXTURE_ABSENT",
	"AC31_ASSERT_REMOTE_CAPABILITIES",
	"AC31_ASSERT_SERVICE_ABSENT",
	"AC31_ASSERT_INITIAL_REVISION",
	"AC31_ASSERT_MANIFEST_EPOCH_STABLE",
	"AC31_ASSERT_MANIFEST_ENTRY_CURRENT",
	"AC31_ASSERT_MANIFEST_ETAG_INVALID",
	"AC31_ASSERT_MANIFEST_EPOCH_MISMATCH",
	"AC31_ASSERT_MANIFEST_REVISION_MISMATCH",
	"AC31_ASSERT_STAT_BEFORE_FILE",
	"AC31_ASSERT_STAT_MTIME_CHANGED",
	"AC31_ASSERT_RACE_INJECTION_COMPLETE",
	"AC31_ASSERT_REMOTE_BLOB_UPDATE",
	"AC31_ASSERT_RACE_SOURCE_EXISTS",
	"AC31_ASSERT_FINAL_CONFLICT_PRESERVATION",
	"AC31_CLEANUP_RESTORE_FAILED",
	"AC31_TIMEOUT_STAT_RACE_INJECTION",
	"AC1032_ASSERT_TARGET_VAULT",
	"AC1032_ASSERT_PLUGIN_CONTROLS",
	"AC1032_ASSERT_INITIAL_STATE",
	"AC1032_ASSERT_FIXTURE_ABSENT",
	"AC1032_ASSERT_REMOTE_CAPABILITIES",
	"AC1032_ASSERT_SERVICE_ABSENT",
	"AC1032_ASSERT_BASELINE",
	"AC1032_ASSERT_REMOTE_UPDATE",
	"AC1032_ASSERT_PROCESS_INTERCEPTION",
	"AC1032_ASSERT_BASE_UNCHANGED_AT_REFUSAL",
	"AC1032_ASSERT_FINAL_STATE",
	"AC1032_CLEANUP_RESTORE_FAILED",
	"AC33_ASSERT_TARGET_VAULT",
	"AC33_ASSERT_PLUGIN_CONTROLS",
	"AC33_ASSERT_INITIAL_STATE",
	"AC33_ASSERT_FIXTURES_ABSENT",
	"AC33_ASSERT_REMOTE_CAPABILITIES",
	"AC33_ASSERT_CURRENT_EPOCH",
	"AC33_ASSERT_SERVICE_ABSENT",
	"AC33_ASSERT_BASELINE",
	"AC33_ASSERT_SOURCE_CREATE",
	"AC33_ASSERT_HYDRATED_SOURCE",
	"AC33_ASSERT_RENAME_AUTHORITY",
	"AC33_ASSERT_MANIFEST_SNAPSHOT",
	"AC33_ASSERT_HYDRATED_DESTINATION",
	"AC33_ASSERT_SOURCE_ONLY_REPLAY",
	"AC33_ASSERT_FINAL_STATE",
	"AC33_CLEANUP_RESTORE_FAILED",
	"AC13_ASSERT_TARGET_VAULT",
	"AC13_ASSERT_PLUGIN_CONTROLS",
	"AC13_ASSERT_INITIAL_STATE",
	"AC13_ASSERT_MANIFEST_SNAPSHOT",
	"AC13_ASSERT_EXCLUDED_FILE",
	"AC13_ASSERT_ELIGIBLE_FIXTURES",
	"AC13_ASSERT_CONTROLLED_EPOCH",
	"AC13_ASSERT_ACTUAL_EPOCH_RECOVERY",
	"AC13_ASSERT_FINAL_STATE",
	"AC13_CLEANUP_RESTORE_FAILED",
	"unexpected-assertion-error",
	"unexpected-type-error",
	"unexpected-range-error",
	"unexpected-reference-error",
	"unexpected-syntax-error",
	"unexpected-sync-transport-error",
	"SYNC_TRANSPORT_1XX",
	"SYNC_TRANSPORT_2XX",
	"SYNC_TRANSPORT_3XX",
	"SYNC_TRANSPORT_4XX",
	"SYNC_TRANSPORT_5XX",
	"SYNC_TRANSPORT_OTHER",
	"ACTION_TIMEOUT",
	"CLEANUP_TIMEOUT",
] as const;

/** Fixed AC-31 operation boundaries that can appear in case diagnostics. */
const SAFE_CASE_FAILURE_BOUNDARIES = [
	"AC31_READ_SERVICE_ABSENCE",
	"AC31_SYNC_BASELINE",
	"AC31_WAIT_BASELINE_IDLE",
	"AC31_READ_BASE_AUTHORITY",
	"AC31_READ_MANIFEST",
	"AC31_MUTATE_REMOTE_BLOB",
	"AC31_READ_UPDATED_AUTHORITY",
	"AC31_SYNC_FINAL_APPLY",
	"AC31_WAIT_FINAL_IDLE",
	"AC31_READ_FINAL_AUTHORITY",
	"AC1032_READ_SERVICE_ABSENCE",
	"AC1032_SYNC_BASELINE",
	"AC1032_WAIT_BASELINE_IDLE",
	"AC1032_READ_BASE_AUTHORITY",
	"AC1032_MUTATE_REMOTE_TEXT",
	"AC1032_READ_REMOTE_AUTHORITY",
	"AC1032_APPLY_REMOTE_CHANGE",
	"AC1032_WAIT_APPLY_IDLE",
	"AC1032_PUBLISH_CONFLICT_COPY",
	"AC1032_WAIT_CONFLICT_SYNC",
	"AC1032_READ_FINAL_AUTHORITY",
	"AC1032_READ_CONFLICT_AUTHORITY",
	"AC33_READ_CURRENT_MANIFEST",
	"AC33_READ_SERVICE_ABSENCE",
	"AC33_CREATE_SOURCE",
	"AC33_HYDRATE_SOURCE",
	"AC33_READ_SOURCE_AUTHORITY",
	"AC33_READ_DESTINATION_ABSENCE",
	"AC33_RENAME_SOURCE",
	"AC33_READ_RENAMED_SOURCE",
	"AC33_READ_RENAMED_DESTINATION",
	"AC33_CAPTURE_MANIFEST",
	"AC33_HYDRATE_DESTINATION",
	"AC33_REPLAY_RENAME",
	"AC33_RESUME_HYDRATION",
	"AC33_WAIT_FINAL_IDLE",
	"AC33_READ_FINAL_SOURCE",
	"AC33_READ_FINAL_DESTINATION",
	"AC13_READ_INITIAL_MANIFEST",
	"AC13_READ_EXCLUDED_AUTHORITY",
	"AC13_CONTROLLED_RECONCILE",
	"AC13_READ_ACTUAL_MANIFEST",
	"AC13_RESTORE_RECONCILE",
	"AC13_WAIT_FINAL_IDLE",
] as const;

/** Error classes allowed in diagnostics from a wrapped case operation. */
const SAFE_CASE_FAILURE_CLASSES = [
	"SyncTransportError",
	"AssertionError",
	"UnsupportedRemoteTextError",
	"TimeoutError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"Error",
	"other",
] as const;

/** Canonical HTTP failure codes validated by the protocol package. */
const SAFE_CASE_TRANSPORT_ERROR_CODES = FileHttpErrorSchema.options;

/** Safe failure labels returned after exact allowlist matching. */
type SafeCaseFailureReason =
	| (typeof SAFE_CASE_FAILURE_CODES)[number]
	| "unknown-error"
	| "cleanup-error";

/** Allowlisted operation boundaries used in safe case diagnostics. */
type SafeCaseFailureBoundary = (typeof SAFE_CASE_FAILURE_BOUNDARIES)[number];
/** Allowlisted exception classes used in safe case diagnostics. */
type SafeCaseFailureClass = (typeof SAFE_CASE_FAILURE_CLASSES)[number];

/** Safe details for one wrapped external operation boundary. */
export interface SafeCaseFailureDetails {
	/** Fixed operation stage from the case script. */
	boundary: SafeCaseFailureBoundary;
	/** Allowlisted constructor class, without an exception message. */
	errorClass: SafeCaseFailureClass;
	/** Valid HTTP status on a SyncTransportError, or null when unavailable. */
	status: number | null;
	/** Canonical protocol error code, or null when not validated. */
	code: CanonicalSyncErrorKind | null;
}

/** Limits host results to safe evidence fields and truthful cleanup state. */
export interface DesktopCaseSummary {
	caseId: string;
	evidence: "service" | "controlled" | "local";
	status: "passed" | "failed" | "blocked";
	failureStage: "action" | "cleanup" | "unknown" | null;
	failureReason: SafeCaseFailureReason | null;
	/** Safe class, status, and canonical code from a named operation boundary. */
	failureDetails?: SafeCaseFailureDetails;
	/** Allowlisted class of the first failed action or cleanup. */
	failureClass?: SafeCaseFailureClass;
	/** Last named operation boundary that completed before the result. */
	lastCompletedBoundary?: SafeCaseFailureBoundary;
	/** Canonical successful mutation status captured by AC-33. */
	receiptStatus?: MutationReceipt["status"];
	/** Safe separation of AC-13 transport-wrapper restoration and controller recovery. */
	ac13Cleanup?: {
		wrapperRestored: boolean;
		controllerResumed: boolean;
	};
	/** Private AC-13 before-case hash snapshot write result. */
	privateSnapshotStatus?: "saved" | "failed" | "unavailable";
	cleanupStatus: "passed" | "failed" | "unknown";
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

/** Builds a safe case summary and replaces unrecognized diagnostics with generic labels. */
export function safeCaseResult(
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	result: Record<string, unknown>,
): DesktopCaseSummary {
	const reportedStatus = result.status;
	if (
		reportedStatus !== "passed" &&
		reportedStatus !== "failed" &&
		reportedStatus !== "blocked"
	)
		throw new Error("Invalid case status");
	const cleanupStatus =
		result.cleanupStatus === "passed" || result.cleanupStatus === "failed"
			? result.cleanupStatus
			: "unknown";
	const status =
		reportedStatus === "passed" && cleanupStatus !== "passed"
			? "failed"
			: reportedStatus;
	const failureStage =
		status === "passed"
			? null
			: result.failureStage === "action" || result.failureStage === "cleanup"
				? result.failureStage
				: cleanupStatus === "failed"
					? "cleanup"
					: "unknown";
	const failureReason =
		status === "passed"
			? null
			: isSafeCaseFailureReason(result.failureReason)
				? result.failureReason
				: failureStage === "cleanup"
					? "cleanup-error"
					: "unknown-error";
	const failureDetails =
		status === "passed" ? null : safeCaseFailureDetails(result.failureDetails);
	const failureClass = SAFE_CASE_FAILURE_CLASSES.find(
		(item) => item === result.failureClass,
	);
	const lastCompletedBoundary = SAFE_CASE_FAILURE_BOUNDARIES.find(
		(item) => item === result.lastCompletedBoundary,
	);
	const caseEvidence = Reflect.get(result, "caseEvidence");
	const rawReceiptStatus =
		caseId === "AC-33" && caseEvidence && typeof caseEvidence === "object"
			? Reflect.get(caseEvidence, "renameReceiptStatus")
			: result.receiptStatus;
	const receiptStatus =
		MutationReceiptSchema.shape.status.safeParse(rawReceiptStatus);
	const rawAc13Cleanup =
		caseId === "AC-13" && caseEvidence && typeof caseEvidence === "object"
			? Reflect.get(caseEvidence, "ac13Cleanup")
			: null;
	const ac13Cleanup =
		rawAc13Cleanup &&
		typeof rawAc13Cleanup === "object" &&
		typeof Reflect.get(rawAc13Cleanup, "wrapperRestored") === "boolean" &&
		typeof Reflect.get(rawAc13Cleanup, "controllerResumed") === "boolean"
			? {
					wrapperRestored: Reflect.get(rawAc13Cleanup, "wrapperRestored"),
					controllerResumed: Reflect.get(rawAc13Cleanup, "controllerResumed"),
				}
			: undefined;
	return {
		caseId,
		evidence,
		status,
		failureStage,
		failureReason,
		...(failureDetails ? { failureDetails } : {}),
		...(status !== "passed" && failureClass ? { failureClass } : {}),
		...(lastCompletedBoundary ? { lastCompletedBoundary } : {}),
		...(receiptStatus.success ? { receiptStatus: receiptStatus.data } : {}),
		...(ac13Cleanup ? { ac13Cleanup } : {}),
		cleanupStatus,
	};
}

/** Accepts only fixed failure labels and rejects arbitrary host exception text. */
function isSafeCaseFailureReason(
	value: unknown,
): value is SafeCaseFailureReason {
	return (
		typeof value === "string" &&
		(SAFE_CASE_FAILURE_CODES.some((code) => code === value) ||
			value === "unknown-error" ||
			value === "cleanup-error")
	);
}

/** Keeps only valid boundary diagnostics and canonical transport metadata. */
function safeCaseFailureDetails(value: unknown): SafeCaseFailureDetails | null {
	if (!value || typeof value !== "object") return null;
	const boundary = Reflect.get(value, "boundary");
	const errorClass = Reflect.get(value, "errorClass");
	const rawStatus = Reflect.get(value, "status");
	const rawCode = Reflect.get(value, "code");
	if (
		!SAFE_CASE_FAILURE_BOUNDARIES.some((item) => item === boundary) ||
		!SAFE_CASE_FAILURE_CLASSES.some((item) => item === errorClass)
	)
		return null;
	return {
		boundary: boundary as SafeCaseFailureDetails["boundary"],
		errorClass: errorClass as SafeCaseFailureDetails["errorClass"],
		status:
			errorClass === "SyncTransportError" &&
			typeof rawStatus === "number" &&
			Number.isInteger(rawStatus) &&
			rawStatus >= 100 &&
			rawStatus < 600
				? rawStatus
				: null,
		code:
			errorClass === "SyncTransportError" &&
			typeof rawCode === "string" &&
			FileHttpErrorSchema.safeParse(rawCode).success
				? (rawCode as CanonicalSyncErrorKind)
				: null,
	};
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

/** Finds and parses one balanced safe host-result object. */
function readCaseResultRecord(output: string): Record<string, unknown> {
	const marker = output.lastIndexOf("OAB8CASE:");
	if (marker < 0) throw new Error("Obsidian case result was unavailable");
	const start = output.indexOf("{", marker + "OAB8CASE:".length);
	if (start < 0) throw new Error("Obsidian case result was unavailable");
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let index = start; index < output.length; index += 1) {
		const character = output[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
	}
	if (end < 0) throw new Error("Obsidian case result was unavailable");
	try {
		const result: unknown = JSON.parse(output.slice(start, end));
		if (!result || typeof result !== "object" || Array.isArray(result))
			throw new Error("Invalid case result object");
		return result as Record<string, unknown>;
	} catch {
		throw new Error("Obsidian case result was invalid");
	}
}

/** Parses one host result and projects only the fixed safe case fields. */
export function parseSafeCaseResult(
	output: string,
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
): DesktopCaseSummary {
	return safeCaseResult(caseId, evidence, readCaseResultRecord(output));
}

/** Validates hashed AC-13 fixture evidence before it enters private scratch. */
export function parseAc13PrivateHashSnapshot(value: unknown): {
	eligible: Array<{ path: string; size: number; hash: string }>;
	excluded: Array<{ path: string; size: number; hash: string }>;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid AC-13 private hash snapshot");
	/** Validates and projects one eligibility group from the host snapshot. */
	const parseFiles = (key: "eligible" | "excluded") => {
		const files = Reflect.get(value, key);
		if (!Array.isArray(files))
			throw new Error("Invalid AC-13 private hash snapshot");
		return files.map((file: unknown) => {
			if (!file || typeof file !== "object" || Array.isArray(file))
				throw new Error("Invalid AC-13 private hash snapshot");
			const path = PathSchema.parse(Reflect.get(file, "path"));
			const size = Reflect.get(file, "size");
			const hash = Reflect.get(file, "hash");
			if (
				typeof size !== "number" ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				typeof hash !== "string" ||
				!/^[0-9a-f]{64}$/.test(hash) ||
				(classifyEnrollmentPath(path, size) === "excluded") !==
					(key === "excluded")
			)
				throw new Error("Invalid AC-13 private hash snapshot");
			return { path, size, hash };
		});
	};
	const eligible = parseFiles("eligible");
	const excluded = parseFiles("excluded");
	const paths = [...eligible, ...excluded].map((file) => file.path);
	if (new Set(paths).size !== paths.length)
		throw new Error("Invalid AC-13 private hash snapshot");
	return { eligible, excluded };
}

/** Stores one validated AC-13 hash snapshot in ignored, owner-only scratch. */
function savePrivateAc13HashSnapshot(snapshot: {
	eligible: Array<{ path: string; size: number; hash: string }>;
	excluded: Array<{ path: string; size: number; hash: string }>;
}): void {
	const directory = resolve(
		process.cwd(),
		".superpowers/sdd/oab-8.8-desktop-gate",
	);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	writeFileSync(
		resolve(directory, `ac13-precase-hashes-${randomUUID()}.json`),
		JSON.stringify(snapshot),
		{ encoding: "utf8", mode: 0o600, flag: "wx" },
	);
}

/** Runs an optional read-only preflight before one case and returns safe result fields. */
export function runHostCase(
	id: DesktopVaultId,
	vaultName: string,
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	actionScript: string,
	cleanupScript: string,
	options: { executable?: string; preflightScript?: string } = {},
): DesktopCaseSummary {
	if (caseId === "AC-32" && !options.preflightScript)
		throw new Error("AC1032_PREFLIGHT_REQUIRED");
	if (options.preflightScript) {
		const preflight = createCaseScript(caseId, options.preflightScript, "");
		const preflightOutput = invokeScopedObsidian(
			id,
			vaultName,
			"eval",
			[`code=${preflight}`],
			options,
		);
		const preflightRecord = readCaseResultRecord(preflightOutput);
		const preflightSummary = safeCaseResult(caseId, evidence, preflightRecord);
		if (preflightSummary.status !== "passed")
			throw new Error("AC1032_FIXTURE_PREFLIGHT_BLOCKED");
	}
	const script = createCaseScript(caseId, actionScript, cleanupScript);
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const record = readCaseResultRecord(output);
	const summary = safeCaseResult(caseId, evidence, record);
	if (caseId !== "AC-13") return summary;
	try {
		const caseEvidence = Reflect.get(record, "caseEvidence");
		if (!caseEvidence || typeof caseEvidence !== "object")
			return { ...summary, privateSnapshotStatus: "unavailable" };
		const rawSnapshot = Reflect.get(caseEvidence, "ac13PrecaseFiles");
		if (rawSnapshot === undefined)
			return { ...summary, privateSnapshotStatus: "unavailable" };
		savePrivateAc13HashSnapshot(parseAc13PrivateHashSnapshot(rawSnapshot));
		return { ...summary, privateSnapshotStatus: "saved" };
	} catch {
		return { ...summary, privateSnapshotStatus: "failed" };
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
		!isHttpStatusClass(statusClass) ||
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

/** Describes one safe current-file revision result without returning its ETag. */
export interface Ac02ServiceRevisionInspection {
	/** HTTP status class without the exact response number. */
	statusClass: Ac04BaselineInspection["statusClass"];
	/** True only when the response body identifies the requested path. */
	pathMatches: boolean;
	/** Revision parsed from a canonical strong ETag, or null without authority. */
	serviceRevision: number | null;
	/** True only when the success response contains a canonical strong ETag. */
	strongResponseETag: boolean;
}

/** Validates a safe AC-02 service read and parses its strong ETag revision. */
export function safeAc02ServiceRevision(
	value: unknown,
): Ac02ServiceRevisionInspection {
	if (!value || typeof value !== "object")
		throw new Error("Invalid AC-02 service revision evidence");
	const statusClass = Reflect.get(value, "statusClass");
	const pathMatches = Reflect.get(value, "pathMatches");
	const etag = Reflect.get(value, "etag");
	if (!isHttpStatusClass(statusClass) || typeof pathMatches !== "boolean")
		throw new Error("Invalid AC-02 service revision evidence");
	if (statusClass !== "2xx")
		return {
			statusClass,
			pathMatches,
			serviceRevision: null,
			strongResponseETag: false,
		};
	if (!pathMatches || typeof etag !== "string")
		throw new Error("Invalid AC-02 service revision evidence");
	try {
		return {
			statusClass,
			pathMatches,
			serviceRevision: parseETag(etag).rev,
			strongResponseETag: true,
		};
	} catch {
		throw new Error("Invalid AC-02 service revision evidence");
	}
}

/** Reads one service ETag through the exact authorized vault and returns only its revision. */
export function inspectAc02ServiceRevision(
	id: DesktopVaultId,
	vaultName: string,
	path: string,
	options: { executable?: string } = {},
): Ac02ServiceRevisionInspection {
	const target = assertAuthorizedVault(id, authorizedVaults()[id]);
	const canonicalPath = PathSchema.parse(path);
	if (!canonicalPath.startsWith("oab-8.8/ac-02-"))
		throw new Error("Unauthorized AC-02 service path");
	const script = `(async () => {
		const target = ${JSON.stringify(target)};
		const path = ${JSON.stringify(canonicalPath)};
		if (app.vault.adapter.getBasePath() !== target) throw Error("Vault path mismatch");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.session?.requestResponse) throw Error("Plugin session unavailable");
		let statusClass = "other";
		try {
			const response = await plugin.session.requestResponse("/v1/files/" + path.split("/").map(encodeURIComponent).join("/"), { method: "GET" });
			statusClass = response.status >= 100 && response.status < 600 ? Math.floor(response.status / 100) + "xx" : "other";
			const etag = typeof response.headers.etag === "string" ? response.headers.etag : null;
			let pathMatches = false;
			if (response.status >= 200 && response.status < 300) {
				try {
					const body = JSON.parse(response.text);
					pathMatches =
						body?.path === path &&
						body?.etag === etag &&
						typeof body.deleted === "boolean";
				} catch {}
			}
			return "OAB8AC02REVISION:" + JSON.stringify({ statusClass, pathMatches, etag });
		} catch {
			return "OAB8AC02REVISION:" + JSON.stringify({ statusClass, pathMatches: false, etag: null });
		}
	})()`;
	const output = invokeScopedObsidian(
		id,
		vaultName,
		"eval",
		[`code=${script}`],
		options,
	);
	const marker = "OAB8AC02REVISION:";
	const markerIndex = output.lastIndexOf(marker);
	if (markerIndex < 0)
		throw new Error("AC-02 service revision result was unavailable");
	let evidence: unknown;
	try {
		evidence = JSON.parse(
			output
				.slice(markerIndex + marker.length)
				.trim()
				.replace(/^['"]|['"]$/g, ""),
		);
	} catch {
		throw new Error("AC-02 service revision result was invalid");
	}
	return safeAc02ServiceRevision(evidence);
}

/** Accepts only the closed HTTP status classes used by safe service evidence. */
function isHttpStatusClass(
	value: unknown,
): value is Ac04BaselineInspection["statusClass"] {
	return (
		value === "1xx" ||
		value === "2xx" ||
		value === "3xx" ||
		value === "4xx" ||
		value === "5xx" ||
		value === "other"
	);
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

/** Adds failure-safe cleanup and returns allowlisted stage and transport diagnostics. */
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
		const safeFailureCodes = ${JSON.stringify(SAFE_CASE_FAILURE_CODES)};
		const safeFailureBoundaries = ${JSON.stringify(SAFE_CASE_FAILURE_BOUNDARIES)};
		const safeFailureClasses = ${JSON.stringify(SAFE_CASE_FAILURE_CLASSES)};
		const safeTransportErrorCodes = ${JSON.stringify(SAFE_CASE_TRANSPORT_ERROR_CODES)};
		const boundaryDetailsKey = Symbol("case-boundary-details");
		const caseEvidence = {};
		let lastCompletedBoundary = null;
		const readBoundaryDetails = (error) => {
			try {
				return error && typeof error === "object" ? error[boundaryDetailsKey] ?? null : null;
			} catch {
				return null;
			}
		};
		const withCaseBoundary = async (boundary, operation) => {
			try {
				const result = await operation();
				if (safeFailureBoundaries.includes(boundary))
					lastCompletedBoundary = boundary;
				return result;
			} catch (error) {
				let errorClass = "other";
				let status = null;
				let code = null;
				try {
					const name = error && typeof error === "object" ? error.name : null;
					if (safeFailureClasses.includes(name)) errorClass = name;
					if (errorClass === "SyncTransportError") {
						const candidateStatus = error.status;
						if (Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus < 600) status = candidateStatus;
						const candidateCode = error.code;
						if (safeTransportErrorCodes.includes(candidateCode)) code = candidateCode;
					}
				} catch {
					/* Invalid exception fields stay absent from diagnostics. */
				}
				const safeBoundary = safeFailureBoundaries.includes(boundary) ? boundary : null;
				if (safeBoundary === null) throw error;
				const wrapped = new Error("Case operation failed");
				Object.defineProperty(wrapped, boundaryDetailsKey, {
					value: { boundary: safeBoundary, errorClass, status, code },
				});
				throw wrapped;
			}
		};
		const classifyFailure = (error, phase) => {
			try {
				const details = readBoundaryDetails(error);
				const name = details?.errorClass ?? (error && typeof error === "object" ? error.name : null);
				if (name === "TimeoutError") return phase === "action" ? "ACTION_TIMEOUT" : "CLEANUP_TIMEOUT";
				if (name === "SyncTransportError") {
					const status = details?.status ?? (error && typeof error === "object" ? error.status : null);
					if (!Number.isInteger(status) || status < 100 || status >= 600) return "unexpected-sync-transport-error";
					return "SYNC_TRANSPORT_" + Math.floor(status / 100) + "XX";
				}
				const unexpected = {
					AssertionError: "unexpected-assertion-error",
					TypeError: "unexpected-type-error",
					RangeError: "unexpected-range-error",
					ReferenceError: "unexpected-reference-error",
					SyntaxError: "unexpected-syntax-error"
				};
				if (Object.prototype.hasOwnProperty.call(unexpected, name)) return unexpected[name];
				const message = error instanceof Error ? error.message : null;
				return safeFailureCodes.includes(message) ? message : "unknown-error";
			} catch {
				return "unknown-error";
			}
		};
		let status = "passed";
		let failureStage = null;
		let failureReason = null;
		let failureDetails = null;
		let failureClass = null;
		let cleanupStatus = "failed";
		try {
			await (async () => { ${actionScript} })();
		} catch (error) {
			status = "failed";
			failureStage = "action";
			failureDetails = readBoundaryDetails(error);
			const name = error && typeof error === "object" ? error.name : null;
			failureClass =
				failureDetails?.errorClass ??
				(safeFailureClasses.includes(name) ? name : "other");
			failureReason = classifyFailure(error, "action");
		}
		try {
			await (async () => { ${cleanupScript} })();
			cleanupStatus = "passed";
		} catch (error) {
			status = "failed";
			if (failureStage === null) {
				failureStage = "cleanup";
				failureDetails = readBoundaryDetails(error);
				const name = error && typeof error === "object" ? error.name : null;
				failureClass =
					failureDetails?.errorClass ??
					(safeFailureClasses.includes(name) ? name : "other");
				const cleanupReason = classifyFailure(error, "cleanup");
				failureReason = safeFailureCodes.includes(cleanupReason) ? cleanupReason : "cleanup-error";
			}
		}
		return "OAB8CASE:" + JSON.stringify({ caseId: ${JSON.stringify(caseId)}, status, failureStage, failureReason, ...(failureDetails ? { failureDetails } : {}), ...(failureClass ? { failureClass } : {}), ...(lastCompletedBoundary ? { lastCompletedBoundary } : {}), ...(Object.keys(caseEvidence).length ? { caseEvidence } : {}), cleanupStatus });
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

/** Action and cleanup scripts for one bounded real acceptance case. */
export interface DesktopCaseScripts {
	/** Case action source with a fixed authorized vault target. */
	action: string;
	/** Read-only eligibility check that runs before the case action when present. */
	preflight?: string;
	/** Cleanup source that restores the local transport or adapter interception. */
	cleanup: string;
}

/** Builds the recovered AC-30 lost-response action with one code per assertion site. */
export function createAc30CaseScripts(home = homedir()): DesktopCaseScripts {
	const target = JSON.stringify(
		assertAuthorizedVault(
			"dev-2",
			resolve(home, "vaults/obsidian-ai-bridge-dev-2"),
			home,
		),
	);
	return {
		action: `
if(app.vault.adapter.getBasePath()!==__AUTHORIZED_TARGET__)throw Error("AC30_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"];
if(!plugin?.journal?.snapshot||!plugin.composition?.publication||!plugin.desktopSync||plugin.sessionStatus!=="connected"||plugin.syncPaused!==false)throw Error("AC30_ASSERT_PLUGIN_CONTROLS");
await plugin.desktopSync.waitForIdle();
const stateBefore=plugin.journal.snapshot();
if(stateBefore.pending_ops.length||stateBefore.pending_apply.length||stateBefore.reconciliation||plugin.desktopSync.isBusy)throw Error("AC30_ASSERT_INITIAL_STATE");
const path="oab-8.8/ac-30-response-lost-20261104-04.md";
if(app.vault.getAbstractFileByPath(path))throw Error("AC30_ASSERT_FIXTURE_ABSENT");
const remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.createText||!remote.readCurrentAuthority||globalThis.__oab8Ac30Restore)throw Error("AC30_ASSERT_REMOTE_CAPABILITIES");
let absent=false;
try{await remote.readCurrentAuthority(path);}catch(error){absent=typeof error==="object"&&error!==null&&Reflect.get(error,"status")===404;}
if(!absent)throw Error("AC30_ASSERT_SERVICE_PATH_ABSENT");
const originalText="# AC-30 response-loss fixture\\n\\nOriginal immutable payload.\\n";
const editedText=originalText+"\\nLocal successor edit.\\n";
const originalCreateText=remote.createText;
let callCount=0;
let firstReceiptETag=null;
let retryReceiptETag=null;
let originalPayloadHash=null;
let retryPayloadMatchesOriginal=false;
let firstRevision=null;
let retryRevision=null;
let releaseGate=()=>{};
let markReached=()=>{};
let timer=null;
let resolveReached;
let rejectReached;
const reached=new Promise((resolve,reject)=>{resolveReached=resolve;rejectReached=reject;});
const gate=new Promise((resolve)=>{releaseGate=resolve;});
const failAfterTimeout=()=>rejectReached(new Error("AC30_TIMEOUT_FIRST_BOUNDARY_WAIT"));
timer=setTimeout(failAfterTimeout,30000);
markReached=()=>{if(timer!==null){clearTimeout(timer);timer=null;}resolveReached();};
const hashText=async(text)=>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const wrapper=async function(){
 const args=arguments;
 if(args[0]!==path)return originalCreateText.apply(this,args);
 callCount+=1;
 const text=args[1];
 const response=await originalCreateText.apply(this,args);
 if(callCount===1){
  originalPayloadHash=await hashText(text);
  firstReceiptETag=response.etag;
  const authority=await remote.readCurrentAuthority(path);
  if(authority.deleted||authority.rev!==1||authority.hash!==originalPayloadHash)throw new Error("AC30_ASSERT_FIRST_COMMIT_AUTHORITY");
  firstRevision=authority.rev;
  const pending=plugin.journal.snapshot().pending_ops.filter((operation)=>operation.path===path&&operation.state==="sent"&&operation.op==="put"&&operation.precondition.kind==="absent"&&operation.payload_hash===originalPayloadHash);
  if(pending.length!==1||Object.prototype.hasOwnProperty.call(plugin.journal.snapshot().base,path))throw new Error("AC30_ASSERT_FIRST_COMMIT_QUEUE");
  markReached();
  await gate;
  throw new Error("AC30_INJECTED_RESPONSE_LOSS");
 }
 if(callCount===2){
  retryPayloadMatchesOriginal=await hashText(text)===originalPayloadHash;
  const authority=await remote.readCurrentAuthority(path);
  retryRevision=authority.rev;
  retryReceiptETag=response.etag;
 }
 return response;
};
globalThis.__oab8Ac30Restore=()=>{remote.createText=originalCreateText;return remote.createText===originalCreateText;};
let cycle;
try{
 remote.createText=wrapper;
 const file=await app.vault.create(path,originalText);
 cycle=plugin.desktopSync.syncNow();
 await reached;
 await app.vault.modify(file,editedText);
 if(await app.vault.read(file)!==editedText)throw new Error("AC30_ASSERT_LOCAL_EDIT_READBACK");
 releaseGate();
 try{await cycle;}catch{}
 await plugin.desktopSync.syncNow();
 await plugin.desktopSync.waitForIdle();
 const authority=await remote.readCurrentAuthority(path);
 const finalState=plugin.journal.snapshot();
 const fileNow=app.vault.getAbstractFileByPath(path);
 const localText=fileNow?await app.vault.read(fileNow):null;
 const finalHash=localText===null?null:await hashText(localText);
 const base=finalState.base[path];
 if(callCount!==2||!retryPayloadMatchesOriginal||firstRevision!==1||retryRevision!==1||retryReceiptETag!==firstReceiptETag||authority.deleted||authority.rev!==2||authority.hash!==await hashText(editedText)||localText!==editedText||!base||base.deleted||base.rev!==2||base.hash!==await hashText(editedText)||finalHash!==base.hash||finalState.pending_ops.length||finalState.pending_apply.length||finalState.reconciliation||finalState.attention.length!==3)throw new Error("AC30_ASSERT_SUCCESSOR_REVISION");
}finally{
 if(timer!==null)clearTimeout(timer);
 releaseGate();
 remote.createText=originalCreateText;
}
if(remote.createText!==originalCreateText)throw new Error("AC30_ASSERT_FINAL_INTERCEPTION_RESTORED");
`.replace("__AUTHORIZED_TARGET__", target),
		cleanup: `if(globalThis.__oab8Ac30Restore&&!globalThis.__oab8Ac30Restore())throw Error("AC30_CLEANUP_RESTORE_FAILED");delete globalThis.__oab8Ac30Restore;`,
	};
}

/** Builds the recovered large Markdown AC-31 blob race action and local cleanup. */
export function createAc31CaseScripts(
	home = homedir(),
	fixturePath = "oab-8.8/ac-31-blob-stat-race-20261104-02.md",
): DesktopCaseScripts {
	const safeFixturePath = PathSchema.parse(fixturePath);
	if (
		!safeFixturePath.startsWith("oab-8.8/ac-31-blob-stat-race-") ||
		!safeFixturePath.endsWith(".md")
	)
		throw new Error("Unauthorized AC-31 fixture path");
	const target = JSON.stringify(
		assertAuthorizedVault(
			"dev-2",
			resolve(home, "vaults/obsidian-ai-bridge-dev-2"),
			home,
		),
	);
	return {
		action: `
if(app.vault.adapter.getBasePath()!==__AUTHORIZED_TARGET__)throw Error("AC31_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"];
if(!plugin?.journal?.snapshot||!plugin.composition?.publication||!plugin.desktopSync||plugin.sessionStatus!=="connected"||plugin.syncPaused!==false)throw Error("AC31_ASSERT_PLUGIN_CONTROLS");
await plugin.desktopSync.waitForIdle();
const stateBefore=plugin.journal.snapshot();
if(stateBefore.pending_ops.length||stateBefore.pending_apply.length||stateBefore.reconciliation||plugin.desktopSync.isBusy)throw Error("AC31_ASSERT_INITIAL_STATE");
const path=${JSON.stringify(safeFixturePath)};
if(app.vault.getAbstractFileByPath(path))throw Error("AC31_ASSERT_FIXTURE_ABSENT");
const remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.manifest||!remote.putBlob||!remote.readCurrentBlobAuthority||globalThis.__oab8Ac31Restore)throw Error("AC31_ASSERT_REMOTE_CAPABILITIES");
let absent=false;
try{await withCaseBoundary("AC31_READ_SERVICE_ABSENCE",()=>remote.readCurrentBlobAuthority(path));}catch(error){absent=readBoundaryDetails(error)?.status===404;if(!absent)throw error;}
if(!absent)throw Error("AC31_ASSERT_SERVICE_ABSENT");
const makeBytes=(char)=>new TextEncoder().encode("# AC-31 blob stat race fixture\\n\\n"+char.repeat(1100000)+"\\n");
const baseBytes=makeBytes("A"),remoteBytes=makeBytes("B"),raceBytes=makeBytes("C");
const hashBytes=async(bytes)=>{const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const baseHash=await hashBytes(baseBytes),remoteHash=await hashBytes(remoteBytes),raceHash=await hashBytes(raceBytes);
await app.vault.createBinary(path,baseBytes.buffer.slice(0));
await withCaseBoundary("AC31_SYNC_BASELINE",()=>plugin.desktopSync.syncNow());
await withCaseBoundary("AC31_WAIT_BASELINE_IDLE",()=>plugin.desktopSync.waitForIdle());
const initial=await withCaseBoundary("AC31_READ_BASE_AUTHORITY",()=>remote.readCurrentBlobAuthority(path));
const afterCreate=plugin.journal.snapshot();
if(initial.kind!=="blob"||initial.rev!==1||initial.hash!==baseHash||afterCreate.base[path]?.rev!==1||afterCreate.base[path]?.hash!==baseHash||afterCreate.pending_ops.length||afterCreate.pending_apply.length)throw Error("AC31_ASSERT_INITIAL_REVISION");
let pageToken=null,pageEpoch=null,manifestEntry=null;
do{const page=await withCaseBoundary("AC31_READ_MANIFEST",()=>remote.manifest(pageToken));if(pageEpoch!==null&&page.epoch!==pageEpoch)throw Error("AC31_ASSERT_MANIFEST_EPOCH_STABLE");pageEpoch=page.epoch;manifestEntry=page.entries.find((entry)=>entry.path===path)??null;pageToken=manifestEntry?null:page.next_page;}while(pageToken!==null);
if(!manifestEntry||manifestEntry.deleted||manifestEntry.kind!=="blob"||pageEpoch!==afterCreate.epoch)throw Error("AC31_ASSERT_MANIFEST_ENTRY_CURRENT");
const manifestIdentityParts=/^"([0-9a-f]{32})\\.([1-9][0-9]*)"$/.exec(manifestEntry.etag);
if(!manifestIdentityParts)throw Error("AC31_ASSERT_MANIFEST_ETAG_INVALID");
const manifestIdentity={epoch:manifestIdentityParts[1],rev:Number(manifestIdentityParts[2])};
if(manifestIdentity.epoch!==pageEpoch)throw Error("AC31_ASSERT_MANIFEST_EPOCH_MISMATCH");
if(manifestIdentity.rev!==initial.rev)throw Error("AC31_ASSERT_MANIFEST_REVISION_MISMATCH");
const adapter=app.vault.adapter,originalStat=adapter.stat;
let statCalls=0,raceInjected=false,injectionActive=false,mtimeChanged=false,sizeUnchanged=false;
let resolveInjection,rejectInjection;
const injection=new Promise((resolve,reject)=>{resolveInjection=resolve;rejectInjection=reject;});
let timer=setTimeout(()=>rejectInjection(new Error("AC31_TIMEOUT_STAT_RACE_INJECTION")),30000);
globalThis.__oab8Ac31Restore=()=>{adapter.stat=originalStat;return adapter.stat===originalStat;};
const wrappedStat=async function(candidatePath){
 if(candidatePath!==path||raceInjected||injectionActive)return originalStat.call(this,candidatePath);
 statCalls+=1;
 if(statCalls!==2)return originalStat.call(this,candidatePath);
 injectionActive=true;
 try{const before=await originalStat.call(this,candidatePath);const file=app.vault.getAbstractFileByPath(path);if(!before||!file)throw new Error("AC31_ASSERT_STAT_BEFORE_FILE");await app.vault.modifyBinary(file,raceBytes.buffer.slice(0));const after=await originalStat.call(this,candidatePath);if(!after||before.mtime===after.mtime)throw new Error("AC31_ASSERT_STAT_MTIME_CHANGED");mtimeChanged=true;sizeUnchanged=before.size===after.size;raceInjected=true;if(timer!==null){clearTimeout(timer);timer=null;}resolveInjection();return after;}finally{injectionActive=false;}
};
try{
 adapter.stat=wrappedStat;
const updateResponse=await withCaseBoundary("AC31_MUTATE_REMOTE_BLOB",()=>remote.putBlob(path,remoteBytes,remoteHash,{kind:"match",epoch:manifestIdentity.epoch,rev:manifestIdentity.rev},crypto.randomUUID(),pageEpoch));
const serviceUpdate=await withCaseBoundary("AC31_READ_UPDATED_AUTHORITY",()=>remote.readCurrentBlobAuthority(path));
 if((updateResponse.status!==200&&updateResponse.status!==201)||serviceUpdate.kind!=="blob"||serviceUpdate.rev!==2||serviceUpdate.hash!==remoteHash)throw new Error("AC31_ASSERT_REMOTE_BLOB_UPDATE");
 try{await plugin.desktopSync.syncNow();}catch{}
 await injection;
 try{await plugin.desktopSync.waitForIdle();}catch{}
}finally{if(timer!==null)clearTimeout(timer);adapter.stat=originalStat;}
if(adapter.stat!==originalStat||!raceInjected||!mtimeChanged||!sizeUnchanged)throw new Error("AC31_ASSERT_RACE_INJECTION_COMPLETE");
const raceState=plugin.journal.snapshot();
const raceFile=app.vault.getAbstractFileByPath(path);
if(!raceFile)throw new Error("AC31_ASSERT_RACE_SOURCE_EXISTS");
const raceLocalHash=await hashBytes(new Uint8Array(await app.vault.readBinary(raceFile)));
const conflictPrefix=path.slice(0,path.lastIndexOf("."))+" (conflict";
const raceCopies=app.vault.getFiles().filter((file)=>file.path.startsWith(conflictPrefix));
let preservedRaceCopy=false;for(const copy of raceCopies){if(await hashBytes(new Uint8Array(await app.vault.readBinary(copy)))===raceHash)preservedRaceCopy=true;}
const intermediatePreserved=raceLocalHash===raceHash&&raceCopies.length===1&&preservedRaceCopy&&raceState.base[path]?.rev===1&&raceState.base[path]?.hash===baseHash&&raceState.pending_apply.some((entry)=>entry.change.path===path);
if(raceState.pending_apply.length)await withCaseBoundary("AC31_SYNC_FINAL_APPLY",()=>plugin.desktopSync.syncNow());
await withCaseBoundary("AC31_WAIT_FINAL_IDLE",()=>plugin.desktopSync.waitForIdle());
const finalState=plugin.journal.snapshot(),finalFile=app.vault.getAbstractFileByPath(path);
const finalHash=finalFile?await hashBytes(new Uint8Array(await app.vault.readBinary(finalFile))):null;
const finalCopies=app.vault.getFiles().filter((file)=>file.path.startsWith(conflictPrefix));
let finalCopyMatches=false;for(const copy of finalCopies){if(await hashBytes(new Uint8Array(await app.vault.readBinary(copy)))===raceHash)finalCopyMatches=true;}
const authority=await withCaseBoundary("AC31_READ_FINAL_AUTHORITY",()=>remote.readCurrentBlobAuthority(path));
if(!intermediatePreserved||!finalFile||finalHash!==remoteHash||authority.rev!==2||authority.hash!==remoteHash||finalCopies.length!==1||!finalCopyMatches||finalState.base[path]?.rev!==2||finalState.base[path]?.hash!==remoteHash||finalState.pending_ops.length||finalState.pending_apply.length||finalState.reconciliation||!finalState.attention.some((item)=>item.path===path))throw new Error("AC31_ASSERT_FINAL_CONFLICT_PRESERVATION");
`.replace("__AUTHORIZED_TARGET__", target),
		cleanup: `if(globalThis.__oab8Ac31Restore&&!globalThis.__oab8Ac31Restore())throw Error("AC31_CLEANUP_RESTORE_FAILED");delete globalThis.__oab8Ac31Restore;`,
	};
}

/** Builds one controlled AC-10/32 edit race and preserves both service revisions. */
export function createAc1032CaseScripts(
	fixturePath: string,
): DesktopCaseScripts {
	const safeFixturePath = PathSchema.parse(fixturePath);
	if (
		!safeFixturePath.startsWith("oab-8.8/ac-10-32-process-race-") ||
		!safeFixturePath.endsWith(".md")
	)
		throw new Error("Unauthorized AC-10/32 fixture path");
	return {
		preflight: `
if(app.vault.adapter.getBasePath()!==${JSON.stringify(authorizedVaults()["dev-2"])})throw Error("AC1032_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"];
if(!plugin?.composition?.publication)throw Error("AC1032_ASSERT_REMOTE_CAPABILITIES");
const path=${JSON.stringify(safeFixturePath)},remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.readCurrentAuthority)throw Error("AC1032_ASSERT_REMOTE_CAPABILITIES");
const localExists=Boolean(app.vault.getAbstractFileByPath(path));
let serviceExists=true;
try{await remote.readCurrentAuthority(path);}catch(error){if(error?.status===404)serviceExists=false;else throw Error("AC1032_ASSERT_REMOTE_CAPABILITIES");}
if(localExists||serviceExists)throw Error("AC1032_ASSERT_FIXTURE_ABSENT");
`.trim(),
		action: `
if(app.vault.adapter.getBasePath()!==${JSON.stringify(authorizedVaults()["dev-2"])})throw Error("AC1032_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"];
if(!plugin?.journal?.snapshot||!plugin.composition?.publication||!plugin.desktopSync||plugin.sessionStatus!=="connected"||plugin.syncPaused!==false)throw Error("AC1032_ASSERT_PLUGIN_CONTROLS");
await plugin.desktopSync.waitForIdle();
const stateBefore=plugin.journal.snapshot();
if(stateBefore.pending_ops.length||stateBefore.pending_apply.length||stateBefore.reconciliation||plugin.desktopSync.isBusy)throw Error("AC1032_ASSERT_INITIAL_STATE");
const path=${JSON.stringify(safeFixturePath)},baseText="# AC-10/32 process race fixture\\n\\nBase revision\\n",remoteText="# AC-10/32 process race fixture\\n\\nRemote revision\\n",userText="# AC-10/32 process race fixture\\n\\nUser edit\\n";
if(app.vault.getAbstractFileByPath(path))throw Error("AC1032_ASSERT_FIXTURE_ABSENT");
const remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.put||!remote?.readCurrentAuthority||!remote?.manifest||globalThis.__oab8Ac1032Restore)throw Error("AC1032_ASSERT_REMOTE_CAPABILITIES");
let absent=false;
try{await withCaseBoundary("AC1032_READ_SERVICE_ABSENCE",()=>remote.readCurrentAuthority(path));}catch(error){absent=readBoundaryDetails(error)?.status===404;if(!absent)throw error;}
if(!absent)throw Error("AC1032_ASSERT_SERVICE_ABSENT");
const hashText=async(text)=>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const baseHash=await hashText(baseText),remoteHash=await hashText(remoteText),userHash=await hashText(userText);
await app.vault.create(path,baseText);
await withCaseBoundary("AC1032_SYNC_BASELINE",()=>plugin.desktopSync.syncNow());
await withCaseBoundary("AC1032_WAIT_BASELINE_IDLE",()=>plugin.desktopSync.waitForIdle());
const initial=await withCaseBoundary("AC1032_READ_BASE_AUTHORITY",()=>remote.readCurrentAuthority(path));
const seeded=plugin.journal.snapshot();
if(initial.deleted||initial.text!==baseText||initial.rev!==1||seeded.base[path]?.rev!==1||seeded.base[path]?.hash!==baseHash||seeded.pending_ops.length||seeded.pending_apply.length)throw Error("AC1032_ASSERT_BASELINE");
const update=await withCaseBoundary("AC1032_MUTATE_REMOTE_TEXT",()=>remote.put(path,remoteText,{kind:"match",epoch:initial.epoch,rev:initial.rev},crypto.randomUUID(),initial.epoch));
const updated=await withCaseBoundary("AC1032_READ_REMOTE_AUTHORITY",()=>remote.readCurrentAuthority(path));
if((update.status!==200&&update.status!==201)||updated.deleted||updated.rev!==2||updated.hash!==remoteHash)throw Error("AC1032_ASSERT_REMOTE_UPDATE");
const vault=app.vault,originalProcess=vault.process;
let raceInjected=false,callbackSawUserEdit=false,callbackLeftUserEdit=false,callbackBaseAfterRefusal=null;
globalThis.__oab8Ac1032Restore=()=>{vault.process=originalProcess;return vault.process===originalProcess;};
const interceptedProcess=async function(file,callback){if(file?.path!==path||raceInjected)return originalProcess.call(this,file,callback);await vault.modify(file,userText);raceInjected=true;const wrapped=(current)=>{callbackSawUserEdit=current===userText;const next=callback(current);callbackLeftUserEdit=callbackSawUserEdit&&next===current;if(callbackLeftUserEdit)callbackBaseAfterRefusal=plugin.journal.snapshot().base[path]??null;return next;};return originalProcess.call(this,file,wrapped);};
try{vault.process=interceptedProcess;await withCaseBoundary("AC1032_APPLY_REMOTE_CHANGE",()=>plugin.desktopSync.syncNow());await withCaseBoundary("AC1032_WAIT_APPLY_IDLE",()=>plugin.desktopSync.waitForIdle());}finally{vault.process=originalProcess;}
if(vault.process!==originalProcess||!raceInjected||!callbackSawUserEdit||!callbackLeftUserEdit)throw Error("AC1032_ASSERT_PROCESS_INTERCEPTION");
if(callbackBaseAfterRefusal?.rev!==seeded.base[path]?.rev||callbackBaseAfterRefusal?.hash!==seeded.base[path]?.hash)throw Error("AC1032_ASSERT_BASE_UNCHANGED_AT_REFUSAL");
const conflictPrefix=path.slice(0,path.lastIndexOf("."))+" (conflict";
const localCopies=vault.getFiles().filter((file)=>file.path.startsWith(conflictPrefix));
let localConflictCopy=null;for(const file of localCopies){if(await hashText(await vault.read(file))===userHash)localConflictCopy=file;}
if(!localConflictCopy)throw Error("AC1032_ASSERT_PROCESS_INTERCEPTION");
await withCaseBoundary("AC1032_PUBLISH_CONFLICT_COPY",()=>plugin.desktopSync.syncNow());
await withCaseBoundary("AC1032_WAIT_CONFLICT_SYNC",()=>plugin.desktopSync.waitForIdle());
const finalState=plugin.journal.snapshot(),finalAuthority=await withCaseBoundary("AC1032_READ_FINAL_AUTHORITY",()=>remote.readCurrentAuthority(path));
const conflictAuthority=await withCaseBoundary("AC1032_READ_CONFLICT_AUTHORITY",()=>remote.readCurrentAuthority(localConflictCopy.path));
if(finalAuthority.deleted||finalAuthority.rev!==2||finalAuthority.hash!==remoteHash||conflictAuthority.deleted||conflictAuthority.hash!==userHash||finalState.base[path]?.rev!==2||finalState.base[path]?.hash!==remoteHash||finalState.pending_ops.length||finalState.pending_apply.length||finalState.reconciliation)throw Error("AC1032_ASSERT_FINAL_STATE");
`.trim(),
		cleanup: `if(globalThis.__oab8Ac1032Restore&&!globalThis.__oab8Ac1032Restore())throw Error("AC1032_CLEANUP_RESTORE_FAILED");delete globalThis.__oab8Ac1032Restore;`,
	};
}

/** Builds a same-epoch AC-33 hydration pause followed by actual feed replay. */
export function createAc33CaseScripts(
	fixturePath = "oab-8.8/ac-33-hydration-dest-20261104-01.md",
): DesktopCaseScripts {
	const safeFixturePath = PathSchema.parse(fixturePath);
	if (
		!safeFixturePath.startsWith("oab-8.8/ac-33-hydration-dest-") ||
		!safeFixturePath.endsWith(".md")
	)
		throw new Error("Unauthorized AC-33 fixture path");
	const target = authorizedVaults()["dev-2"];
	return {
		action: `
if(app.vault.adapter.getBasePath()!==${JSON.stringify(target)})throw Error("AC33_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"],reconciliation=plugin?.composition?.reconciliation;
if(!plugin?.journal?.snapshot||!plugin.composition?.publication||!reconciliation?.reconcile||!reconciliation?.replay||!reconciliation?.resume||!plugin.desktopSync||plugin.sessionStatus!=="connected"||plugin.syncPaused!==false)throw Error("AC33_ASSERT_PLUGIN_CONTROLS");
await plugin.desktopSync.waitForIdle();
const stateBefore=plugin.journal.snapshot(),observedEpoch=stateBefore.epoch;
if(!observedEpoch||stateBefore.cursor===null||stateBefore.pending_ops.length||stateBefore.pending_apply.length||stateBefore.reconciliation||plugin.desktopSync.isBusy)throw Error("AC33_ASSERT_INITIAL_STATE");
const destination=${JSON.stringify(safeFixturePath)},source=destination.replace("ac-33-hydration-dest-","ac-33-hydration-source-"),sourceText="# AC-33 controlled rename fixture\\n\\nSource bytes\\n";
if(app.vault.getAbstractFileByPath(source)||app.vault.getAbstractFileByPath(destination))throw Error("AC33_ASSERT_FIXTURES_ABSENT");
const remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.manifest||!remote?.changes||!remote?.put||!remote?.rename||!remote?.readCurrentAuthority||globalThis.__oab8Ac33Restore)throw Error("AC33_ASSERT_REMOTE_CAPABILITIES");
const firstPage=await withCaseBoundary("AC33_READ_CURRENT_MANIFEST",()=>remote.manifest(null));
if(firstPage.epoch!==observedEpoch)throw Error("AC33_ASSERT_CURRENT_EPOCH");
const expectAbsent=async(path,boundary)=>{try{await withCaseBoundary(boundary,()=>remote.readCurrentAuthority(path));return false;}catch(error){if(readBoundaryDetails(error)?.status===404)return true;throw error;}};
const sourceAbsent=await expectAbsent(source,"AC33_READ_SERVICE_ABSENCE"),destinationAbsence=await expectAbsent(destination,"AC33_READ_DESTINATION_ABSENCE");
if(!sourceAbsent||!destinationAbsence)throw Error("AC33_ASSERT_SERVICE_ABSENT");
const hashText=async(text)=>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const sourceHash=await hashText(sourceText);
const sourceCreate=await withCaseBoundary("AC33_CREATE_SOURCE",()=>remote.put(source,sourceText,{kind:"absent"},crypto.randomUUID(),observedEpoch));
const createdSource=await withCaseBoundary("AC33_READ_SOURCE_AUTHORITY",()=>remote.readCurrentAuthority(source));
if(sourceCreate.status!==201||createdSource.deleted||createdSource.epoch!==observedEpoch||createdSource.rev!==1||createdSource.hash!==sourceHash)throw Error("AC33_ASSERT_SOURCE_CREATE");
const originalManifest=remote.manifest,capturedEntries=[],capturedTokens=new Set();
let restoreComplete=false;
globalThis.__oab8Ac33Restore=()=>{if(restoreComplete)return true;remote.manifest=originalManifest;restoreComplete=remote.manifest===originalManifest;return restoreComplete;};
remote.manifest=async function(token){const page=await originalManifest.call(remote,token);if(page.epoch!==observedEpoch)throw Error("AC33_ASSERT_CURRENT_EPOCH");return page;};
await withCaseBoundary("AC33_HYDRATE_SOURCE",()=>reconciliation.reconcile());
const sourceBefore=await withCaseBoundary("AC33_READ_SOURCE_AUTHORITY",()=>remote.readCurrentAuthority(source)),baseline=plugin.journal.snapshot(),cursorBeforeRename=baseline.cursor,localSource=app.vault.getAbstractFileByPath(source),localSourceHash=localSource?await hashText(await app.vault.read(localSource)):null;
if(sourceBefore.deleted||sourceBefore.epoch!==observedEpoch||sourceBefore.rev!==1||sourceBefore.hash!==sourceHash||baseline.base[source]?.rev!==1||baseline.base[source]?.hash!==sourceHash||baseline.base[destination]!==undefined||localSourceHash!==sourceHash||baseline.pending_ops.length||baseline.pending_apply.length||baseline.reconciliation||cursorBeforeRename===null)throw Error("AC33_ASSERT_HYDRATED_SOURCE");
const destinationStillAbsent=await expectAbsent(destination,"AC33_READ_DESTINATION_ABSENCE");
if(!destinationStillAbsent)throw Error("AC33_ASSERT_SERVICE_ABSENT");
const renameReceipt=await withCaseBoundary("AC33_RENAME_SOURCE",()=>remote.rename(source,destination,{kind:"match",epoch:observedEpoch,rev:sourceBefore.rev},crypto.randomUUID()));
caseEvidence.renameReceiptStatus=renameReceipt.status;
const renamedSource=await withCaseBoundary("AC33_READ_RENAMED_SOURCE",()=>remote.readCurrentAuthority(source)),renamedDestination=await withCaseBoundary("AC33_READ_RENAMED_DESTINATION",()=>remote.readCurrentAuthority(destination));
if(!renamedSource.deleted||renamedSource.rev!==2||renamedDestination.deleted||renamedDestination.epoch!==observedEpoch||renamedDestination.rev!==1||renamedDestination.hash!==sourceHash)throw Error("AC33_ASSERT_RENAME_AUTHORITY");
let capturedHead=null,capturedEpoch=null,pageToken=null;
do{const page=await withCaseBoundary("AC33_CAPTURE_MANIFEST",()=>originalManifest.call(remote,pageToken));if(capturedEpoch!==null&&page.epoch!==capturedEpoch)throw Error("AC33_ASSERT_MANIFEST_SNAPSHOT");if(capturedHead!==null&&page.head_seq!==capturedHead)throw Error("AC33_ASSERT_MANIFEST_SNAPSHOT");capturedEpoch=page.epoch;capturedHead=page.head_seq;capturedEntries.push(...page.entries);pageToken=page.next_page;if(pageToken!==null){if(capturedTokens.has(pageToken))throw Error("AC33_ASSERT_MANIFEST_SNAPSHOT");capturedTokens.add(pageToken);}}while(pageToken!==null);
const destinationEntry=capturedEntries.find((entry)=>entry.path===destination),sourceEntry=capturedEntries.find((entry)=>entry.path===source);
if(capturedEpoch!==observedEpoch||capturedHead===null||capturedHead<=cursorBeforeRename||new Set(capturedEntries.map((entry)=>entry.path)).size!==capturedEntries.length||capturedEntries.filter((entry)=>entry.path===destination).length!==1||capturedEntries.filter((entry)=>entry.path===source).length!==1||!destinationEntry||destinationEntry.deleted||destinationEntry.hash!==sourceHash||!sourceEntry?.deleted)throw Error("AC33_ASSERT_MANIFEST_SNAPSHOT");
const continuationToken="ac33-controlled-continuation",remainingEntries=capturedEntries.filter((entry)=>entry.path!==destinationEntry.path),hydrationFirstPage={epoch:observedEpoch,head_seq:capturedHead,entries:[destinationEntry],next_page:continuationToken},hydrationContinuation={epoch:observedEpoch,head_seq:capturedHead,entries:remainingEntries,next_page:null},hydrationStop=Object.assign(new Error("controlled hydration boundary"),{name:"AC33_CONTROLLED_HYDRATION_STOP"});
let stoppedAfterDestination=false,allowContinuation=false;
remote.manifest=async function(token){if(token===null)return hydrationFirstPage;if(token!==continuationToken)throw Error("AC33_ASSERT_MANIFEST_SNAPSHOT");if(!allowContinuation){stoppedAfterDestination=true;throw hydrationStop;}return hydrationContinuation;};
try{
let stopObserved=false;try{await withCaseBoundary("AC33_HYDRATE_DESTINATION",()=>reconciliation.reconcile());}catch(error){const details=readBoundaryDetails(error);if(details?.boundary!=="AC33_HYDRATE_DESTINATION"||details.errorClass!=="other"||details.status!==null||details.code!==null)throw error;stopObserved=true;}
const hydrated=plugin.journal.snapshot(),destinationFile=app.vault.getAbstractFileByPath(destination),destinationHash=destinationFile?await hashText(await app.vault.read(destinationFile)):null;
if(!stopObserved||!stoppedAfterDestination||hydrated.epoch!==observedEpoch||hydrated.cursor!==cursorBeforeRename||hydrated.base[destination]?.rev!==renamedDestination.rev||hydrated.base[destination]?.hash!==sourceHash||hydrated.base[source]?.rev!==sourceBefore.rev||!hydrated.reconciliation||hydrated.reconciliation.stage!=="manifest"||hydrated.reconciliation.page_token!==continuationToken||destinationHash!==sourceHash||hydrated.pending_ops.length||hydrated.pending_apply.length)throw Error("AC33_ASSERT_HYDRATED_DESTINATION");
await withCaseBoundary("AC33_REPLAY_RENAME",()=>reconciliation.replay());
const replayed=plugin.journal.snapshot(),replayedDestination=app.vault.getAbstractFileByPath(destination);
if(replayed.base[destination]?.rev!==renamedDestination.rev||replayed.base[destination]?.hash!==sourceHash||replayed.base[source]?.deleted!==true||replayed.base[source]?.rev!==renamedSource.rev||app.vault.getAbstractFileByPath(source)||!replayedDestination||await hashText(await app.vault.read(replayedDestination))!==sourceHash||app.vault.getFiles().filter((file)=>file.path===destination).length!==1)throw Error("AC33_ASSERT_SOURCE_ONLY_REPLAY");
allowContinuation=true;
await withCaseBoundary("AC33_RESUME_HYDRATION",()=>reconciliation.resume());
}finally{if(!globalThis.__oab8Ac33Restore())throw Error("AC33_CLEANUP_RESTORE_FAILED");}
await withCaseBoundary("AC33_WAIT_FINAL_IDLE",()=>plugin.desktopSync.waitForIdle());
const finalState=plugin.journal.snapshot(),finalSource=await withCaseBoundary("AC33_READ_FINAL_SOURCE",()=>remote.readCurrentAuthority(source)),finalDestination=await withCaseBoundary("AC33_READ_FINAL_DESTINATION",()=>remote.readCurrentAuthority(destination));
if(finalState.epoch!==observedEpoch||finalState.cursor!==capturedHead||finalState.reconciliation||finalState.pending_ops.length||finalState.pending_apply.length||finalState.base[destination]?.rev!==renamedDestination.rev||finalState.base[destination]?.hash!==sourceHash||finalState.base[source]?.deleted!==true||finalState.base[source]?.rev!==renamedSource.rev||!finalSource.deleted||finalSource.rev!==renamedSource.rev||finalDestination.deleted||finalDestination.rev!==renamedDestination.rev||finalDestination.hash!==sourceHash||app.vault.getAbstractFileByPath(source)||app.vault.getFiles().filter((file)=>file.path===destination).length!==1)throw Error("AC33_ASSERT_FINAL_STATE");
`.trim(),
		cleanup: `if(globalThis.__oab8Ac33Restore&&!globalThis.__oab8Ac33Restore())throw Error("AC33_CLEANUP_RESTORE_FAILED");delete globalThis.__oab8Ac33Restore;`,
	};
}

/** Separates excluded local files from eligible AC-13 checks and reports eligible mismatches. */
export function classifyAc13PreflightFiles<
	T extends {
		path: string;
		size: number;
		baseMatches: boolean;
		serviceMatches: boolean;
	},
>(files: readonly T[]): { eligible: T[]; excluded: T[]; blockers: T[] } {
	const excluded = files.filter(
		(file) => classifyEnrollmentPath(file.path, file.size) === "excluded",
	);
	const eligible = files.filter(
		(file) => classifyEnrollmentPath(file.path, file.size) !== "excluded",
	);
	const blockers = eligible.filter(
		(file) => !file.baseMatches || !file.serviceMatches,
	);
	return { eligible, excluded, blockers };
}

/** Captures the excluded local files that the controlled AC-13 case must preserve. */
export interface Ac13ExcludedFileScope {
	/** Every excluded path in the local and service inventory. */
	excludedPaths: readonly string[];
	/** Excluded local files whose bytes must remain unchanged. */
	excludedLocalFiles: readonly { path: string; size: number }[];
	/** Excluded local files with no live base or service entry. */
	localOnlyExcludedPaths: readonly string[];
}

/** Builds one controlled AC-13 epoch recovery without changing service authority. */
export function createAc13CaseScripts(
	scope: Ac13ExcludedFileScope,
): DesktopCaseScripts {
	const excludedPaths = [
		...new Set(scope.excludedPaths.map((path) => PathSchema.parse(path))),
	];
	const excludedLocalFiles = scope.excludedLocalFiles.map(({ path, size }) => ({
		path: PathSchema.parse(path),
		size,
	}));
	const localOnlyExcludedPaths = [
		...new Set(
			scope.localOnlyExcludedPaths.map((path) => PathSchema.parse(path)),
		),
	];
	const excludedPathSet = new Set(excludedPaths);
	if (
		excludedPaths.length !== scope.excludedPaths.length ||
		localOnlyExcludedPaths.length !== scope.localOnlyExcludedPaths.length ||
		excludedPaths.some(
			(path) => classifyEnrollmentPath(path, 0) !== "excluded",
		) ||
		excludedLocalFiles.some(
			(file) =>
				!excludedPathSet.has(file.path) ||
				classifyEnrollmentPath(file.path, file.size) !== "excluded",
		) ||
		localOnlyExcludedPaths.some(
			(path) =>
				!excludedPathSet.has(path) ||
				!excludedLocalFiles.some((file) => file.path === path),
		)
	)
		throw new Error("Unauthorized AC-13 excluded file scope");
	const target = authorizedVaults()["dev-2"];
	return {
		action: `
if(app.vault.adapter.getBasePath()!==${JSON.stringify(target)})throw Error("AC13_ASSERT_TARGET_VAULT");
const plugin=app.plugins.plugins?.["ai-bridge"],reconciliation=plugin?.composition?.reconciliation;
if(!plugin?.journal?.snapshot||!plugin.composition?.publication||!reconciliation?.reconcile||!plugin.desktopSync||plugin.sessionStatus!=="connected"||plugin.syncPaused!==false)throw Error("AC13_ASSERT_PLUGIN_CONTROLS");
await plugin.desktopSync.waitForIdle();
const remote=Reflect.get(plugin.composition.publication,"remote"),stateBefore=plugin.journal.snapshot(),expectedExcludedPaths=new Set(${JSON.stringify(excludedPaths)}),expectedExcludedLocal=${JSON.stringify(excludedLocalFiles)},localOnlyExcludedPaths=${JSON.stringify(localOnlyExcludedPaths)};
if(!remote?.manifest||!remote.readCurrentAuthority||globalThis.__oab8Ac13Restore||stateBefore.pending_ops.length||stateBefore.pending_apply.length||stateBefore.reconciliation||plugin.desktopSync.isBusy||!stateBefore.epoch||stateBefore.cursor===null||!stateBefore.client_id)throw Error("AC13_ASSERT_INITIAL_STATE");
const readManifestSnapshot=async(boundary)=>{const entries=[],tokens=new Set();let token=null,epoch=null,head=null;do{const page=await withCaseBoundary(boundary,()=>remote.manifest(token));if(epoch!==null&&(page.epoch!==epoch||page.head_seq!==head))throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");epoch=page.epoch;head=page.head_seq;entries.push(...page.entries);token=page.next_page;if(token!==null){if(tokens.has(token))throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");tokens.add(token);}}while(token!==null);if(epoch===null||head===null||new Set(entries.map((entry)=>entry.path)).size!==entries.length)throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");return{epoch,head,entries};};
const initial=await readManifestSnapshot("AC13_READ_INITIAL_MANIFEST");
if(initial.epoch!==stateBefore.epoch||initial.head!==stateBefore.cursor)throw Error("AC13_ASSERT_INITIAL_STATE");
const controlledEpoch=(initial.epoch[0]==="a"?"b":"a")+initial.epoch.slice(1);
const projectControlledETag=(etag)=>{const value=etag.slice(1,-1).split(".");if(etag[0]!==String.fromCharCode(34)||etag[etag.length-1]!==String.fromCharCode(34)||value.length!==2||value[0]!==initial.epoch||!/^[1-9][0-9]*$/.test(value[1]))throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");const rev=Number(value[1]);if(!Number.isSafeInteger(rev)||rev<=0)throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");return String.fromCharCode(34)+controlledEpoch+"."+rev+String.fromCharCode(34);};
for(const entry of initial.entries)projectControlledETag(entry.etag);
const localSnapshot=async()=>{const files=app.vault.getFiles(),result=[];for(const file of files){const bytes=new Uint8Array(await app.vault.readBinary(file)),digest=await crypto.subtle.digest("SHA-256",bytes),hash=Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");result.push({path:file.path,size:bytes.byteLength,hash});}return result.sort((left,right)=>left.path.localeCompare(right.path));};
const sameSnapshot=(left,right)=>left.length===right.length&&left.every((item,index)=>item.path===right[index].path&&item.size===right[index].size&&item.hash===right[index].hash);
const filesBefore=await localSnapshot(),localByPath=new Map(filesBefore.map((file)=>[file.path,file])),entryByPath=new Map(initial.entries.map((entry)=>[entry.path,entry]));
caseEvidence.ac13PrecaseFiles={eligible:filesBefore.filter((file)=>!expectedExcludedPaths.has(file.path)),excluded:filesBefore.filter((file)=>expectedExcludedPaths.has(file.path))};
const actualExcludedLocal=filesBefore.filter((file)=>expectedExcludedPaths.has(file.path));
if(actualExcludedLocal.length!==expectedExcludedLocal.length||expectedExcludedLocal.some((expected)=>{const actual=localByPath.get(expected.path);return !actual||actual.size!==expected.size;}))throw Error("AC13_ASSERT_EXCLUDED_FILE");
for(const path of localOnlyExcludedPaths){if(Object.hasOwn(stateBefore.base,path)||entryByPath.has(path))throw Error("AC13_ASSERT_EXCLUDED_FILE");let absent=false;try{await withCaseBoundary("AC13_READ_EXCLUDED_AUTHORITY",()=>remote.readCurrentAuthority(path));}catch(error){absent=readBoundaryDetails(error)?.status===404;if(!absent)throw error;}if(!absent)throw Error("AC13_ASSERT_EXCLUDED_FILE");}
const eligibleFiles=filesBefore.filter((file)=>!expectedExcludedPaths.has(file.path)),eligibleBase=Object.entries(stateBefore.base).filter(([path,base])=>!expectedExcludedPaths.has(path)&&base.deleted!==true),eligibleService=initial.entries.filter((entry)=>!expectedExcludedPaths.has(entry.path)&&!entry.deleted);
const eligiblePreflightPassed=eligibleFiles.length>0&&eligibleFiles.every((file)=>{const base=stateBefore.base[file.path],entry=entryByPath.get(file.path);return Boolean(base&&base.deleted!==true&&base.hash===file.hash&&entry&&!entry.deleted&&entry.hash===file.hash);})&&eligibleBase.every(([path,base])=>{const file=localByPath.get(path),entry=entryByPath.get(path);return Boolean(file&&file.hash===base.hash&&entry&&!entry.deleted&&entry.hash===base.hash);})&&eligibleService.every((entry)=>{const file=localByPath.get(entry.path),base=stateBefore.base[entry.path];return Boolean(file&&file.hash===entry.hash&&base&&base.deleted!==true&&base.hash===entry.hash);});
if(!eligiblePreflightPassed)throw Error("AC13_ASSERT_ELIGIBLE_FIXTURES");
const originalManifest=remote.manifest,observedEpoch=initial.epoch,observedHead=initial.head,attentionBefore=JSON.stringify(stateBefore.attention);
let controllerPaused=false,restoreComplete=false,controllerResumeFailed=false;
const restoreManifest=()=>{remote.manifest=originalManifest;return remote.manifest===originalManifest;};
const restore=async()=>{if(restoreComplete)return{wrapperRestored:true,controllerResumed:!controllerResumeFailed};if(!restoreManifest())return{wrapperRestored:false,controllerResumed:false};restoreComplete=true;if(controllerPaused){const resume=plugin.desktopSync.resume();controllerPaused=false;try{await resume;await plugin.desktopSync.waitForIdle();}catch{controllerResumeFailed=true;}}return{wrapperRestored:remote.manifest===originalManifest,controllerResumed:!controllerResumeFailed};};
globalThis.__oab8Ac13Restore=restore;
controllerPaused=true;plugin.desktopSync.pause();
remote.manifest=async function(token){const page=await originalManifest.call(remote,token);if(page.epoch!==observedEpoch||page.head_seq!==observedHead)throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");return{...page,epoch:controlledEpoch,entries:page.entries.map((entry)=>({...entry,etag:projectControlledETag(entry.etag)}))};};
try{await withCaseBoundary("AC13_CONTROLLED_RECONCILE",()=>reconciliation.reconcile());}finally{if(!restoreManifest())throw Error("AC13_CLEANUP_RESTORE_FAILED");}
const controlledState=plugin.journal.snapshot(),filesAfterControlled=await localSnapshot();
if(controlledState.epoch!==controlledEpoch||controlledState.cursor!==observedHead||controlledState.reconciliation||controlledState.pending_ops.length||controlledState.pending_apply.length||controlledState.device_id!==stateBefore.device_id||controlledState.client_id!==stateBefore.client_id||JSON.stringify(controlledState.attention)!==attentionBefore||!sameSnapshot(filesBefore,filesAfterControlled)||localOnlyExcludedPaths.some((path)=>Object.hasOwn(controlledState.base,path)))throw Error("AC13_ASSERT_CONTROLLED_EPOCH");
const current=await readManifestSnapshot("AC13_READ_ACTUAL_MANIFEST");
if(current.epoch!==observedEpoch||current.head!==observedHead)throw Error("AC13_ASSERT_MANIFEST_SNAPSHOT");
await withCaseBoundary("AC13_RESTORE_RECONCILE",()=>reconciliation.reconcile());
const restoredState=plugin.journal.snapshot();
if(restoredState.epoch!==observedEpoch||restoredState.cursor!==observedHead||restoredState.reconciliation||restoredState.pending_ops.length||restoredState.pending_apply.length||restoredState.device_id!==stateBefore.device_id||restoredState.client_id!==stateBefore.client_id||JSON.stringify(restoredState.attention)!==attentionBefore||!sameSnapshot(filesBefore,await localSnapshot())||localOnlyExcludedPaths.some((path)=>Object.hasOwn(restoredState.base,path)))throw Error("AC13_ASSERT_ACTUAL_EPOCH_RECOVERY");
await plugin.desktopSync.resume();controllerPaused=false;
await withCaseBoundary("AC13_WAIT_FINAL_IDLE",()=>plugin.desktopSync.waitForIdle());
const finalState=plugin.journal.snapshot(),finalManifest=await readManifestSnapshot("AC13_READ_ACTUAL_MANIFEST");
if(plugin.sessionStatus!=="connected"||plugin.syncPaused!==false||plugin.desktopSync.isBusy||finalManifest.epoch!==observedEpoch||finalManifest.head!==observedHead||finalState.epoch!==observedEpoch||finalState.cursor!==observedHead||finalState.reconciliation||finalState.pending_ops.length||finalState.pending_apply.length||finalState.device_id!==stateBefore.device_id||finalState.client_id!==stateBefore.client_id||JSON.stringify(finalState.attention)!==attentionBefore||!sameSnapshot(filesBefore,await localSnapshot())||localOnlyExcludedPaths.some((path)=>Object.hasOwn(finalState.base,path))||remote.manifest!==originalManifest)throw Error("AC13_ASSERT_FINAL_STATE");
`.trim(),
		cleanup: `const restore=globalThis.__oab8Ac13Restore;if(restore){let result=null;try{result=await restore();}catch{}caseEvidence.ac13Cleanup={wrapperRestored:result?.wrapperRestored===true,controllerResumed:result?.controllerResumed===true};if(result?.wrapperRestored)delete globalThis.__oab8Ac13Restore;if(!result?.wrapperRestored||!result?.controllerResumed)throw Error("AC13_CLEANUP_RESTORE_FAILED");}`,
	};
}
