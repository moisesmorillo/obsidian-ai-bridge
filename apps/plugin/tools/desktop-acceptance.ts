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

/** Isolated local fixture paths for one authorized synthetic AC-19 vault. */
export interface Ac19FixturePaths {
	/** Unique directory that preserves all earlier acceptance evidence. */
	root: string;
	/** Eligible local note path used to seed the remote revision. */
	source: string;
	/** Excluded suffix placeholder used only to simulate an iCloud transition. */
	placeholder: string;
}

/** Builds validated paths under the fresh AC-19 namespace for one approved test vault. */
export function createAc19FixturePaths(
	id: DesktopVaultId,
	existingPaths: readonly string[] = [],
): Ac19FixturePaths {
	if (id !== "dev-1" && id !== "dev-2")
		throw new Error("Unauthorized AC-19 test vault");
	const root = PathSchema.parse(`oab-10.1/${id}`);
	const source = PathSchema.parse(`${root}/simulated-eviction.md`);
	const placeholder = PathSchema.parse(`${source}.icloud`);
	const existing = new Set(existingPaths.map((path) => PathSchema.parse(path)));
	if (existing.has(source) || existing.has(placeholder))
		throw new Error("AC-19 fixture path already exists");
	if (
		classifyEnrollmentPath(source, 0) === "excluded" ||
		classifyEnrollmentPath(placeholder, 0) !== "excluded"
	)
		throw new Error("Invalid AC-19 fixture scope");
	return { root, source, placeholder };
}

/** Final AC-30 checks that may expose one bounded mismatch observation. */
const AC30_FINAL_ASSERTION_CODES = [
	"AC30_ASSERT_FINAL_CALL_COUNT",
	"AC30_ASSERT_FINAL_RETRY_KEY",
	"AC30_ASSERT_FINAL_SUCCESSOR_KEY",
	"AC30_ASSERT_FINAL_RETRY_PAYLOAD",
	"AC30_ASSERT_FINAL_SUCCESSOR_PAYLOAD",
	"AC30_ASSERT_FINAL_NO_422",
	"AC30_ASSERT_FINAL_FIRST_REVISION",
	"AC30_ASSERT_FINAL_RETRY_REVISION",
	"AC30_ASSERT_SUCCESSOR_REVISION",
	"AC30_ASSERT_FINAL_RETRY_ETAG",
	"AC30_ASSERT_FINAL_PRECONDITION_KIND",
	"AC30_ASSERT_FINAL_PRECONDITION_EPOCH",
	"AC30_ASSERT_FINAL_PRECONDITION_REVISION",
	"AC30_ASSERT_FINAL_AUTHORITY_LIVE",
	"AC30_ASSERT_FINAL_AUTHORITY_REVISION",
	"AC30_ASSERT_FINAL_AUTHORITY_HASH",
	"AC30_ASSERT_FINAL_LOCAL_TEXT",
	"AC30_ASSERT_FINAL_BASE_PRESENT",
	"AC30_ASSERT_FINAL_BASE_LIVE",
	"AC30_ASSERT_FINAL_BASE_REVISION",
	"AC30_ASSERT_FINAL_BASE_HASH",
	"AC30_ASSERT_FINAL_LOCAL_HASH",
	"AC30_ASSERT_FINAL_PENDING_OPERATIONS",
	"AC30_ASSERT_FINAL_PENDING_APPLIES",
	"AC30_ASSERT_FINAL_RECONCILIATION",
	"AC30_ASSERT_FINAL_ATTENTION_COUNT",
] as const;

/** Fixed request roles assigned by AC-30 call order without exposing operation keys. */
const AC30_DIAGNOSTIC_CALL_ORDINALS = ["first", "retry", "successor"] as const;

/** Maximum bounded AC-30 call and queue samples exposed in host diagnostics. */
const AC30_DIAGNOSTIC_SAMPLE_LIMIT = 3;

/** Fixed lifecycle states accepted for pending AC-30 operations. */
const AC30_DIAGNOSTIC_OPERATION_STATES = [
	"queued",
	"sent",
	"resolved",
] as const;

/** Fixed mutation kinds accepted for pending AC-30 operation diagnostics. */
const AC30_DIAGNOSTIC_OPERATION_KINDS = ["put", "delete", "rename"] as const;

/** Fixed case and error codes that may appear in host failure summaries. */
const AC30_SAFE_OBSERVATION_STATES = [
	"match",
	"absent",
	"present",
	"null",
	"undefined",
	"string",
	"boolean",
	"number",
	"object",
	"array",
	"other",
] as const;

/** Fixed failure labels accepted by generated case-result parsing. */
const SAFE_CASE_FAILURE_CODES = [
	"AC19_ASSERT_TARGET_VAULT",
	"AC19_ASSERT_PLUGIN_CONTROLS",
	"AC19_ASSERT_INITIAL_STATE",
	"AC19_ASSERT_FIXTURE_COLLISION",
	"AC19_ASSERT_BASELINE_SYNC",
	"AC19_ASSERT_CONFIRMATION",
	"AC19_ASSERT_PLACEHOLDER_EXCLUDED",
	"AC19_ASSERT_SERVICE_UNCHANGED",
	"AC19_CLEANUP_RESTORE_FAILED",
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
	"AC30_ASSERT_FIRST_PAYLOAD",
	"AC30_ASSERT_RETRY_DEADLINE",
	"AC30_ASSERT_RETRY_WAIT_BOUND",
	"AC30_ASSERT_RETRY_IDENTITY",
	"AC30_ASSERT_RETRY_AFTER_WAIT_IDENTITY",
	"AC30_ASSERT_SUCCESSOR_REQUEST",
	"AC30_ASSERT_LOCAL_EDIT_READBACK",
	...AC30_FINAL_ASSERTION_CODES,
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

/** Fixed operation boundaries that can appear in safe case diagnostics. */
const SAFE_CASE_FAILURE_BOUNDARIES = [
	"AC19_READ_SERVICE_ABSENCE",
	"AC19_SEED_BASELINE",
	"AC19_WAIT_DELETE_CAPTURE",
	"AC19_READ_SERVICE_AUTHORITY",
	"AC19_RESOLVE_CONFIRMATION",
	"AC19_RESTORE_SOURCE",
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
	/** Sanitized values and optional bounded diagnostics for a failed AC-30 assertion. */
	ac30FinalAssertion?: SafeAc30FinalAssertion;
	/** Safe separation of AC-13 transport-wrapper restoration and controller recovery. */
	ac13Cleanup?: {
		wrapperRestored: boolean;
		controllerResumed: boolean;
	};
	/** Private AC-13 before-case hash snapshot write result. */
	privateSnapshotStatus?: "saved" | "failed" | "unavailable";
	/** Safe baseline deltas for one synthetic AC-19 case without path or content data. */
	ac19Evidence?: {
		captureReload: boolean;
		attentionUnchanged: boolean;
		baselineSynced: boolean;
		confirmationVisible: boolean;
		placeholderExcluded: boolean;
		serviceSourceLive: boolean | null;
		deleteOrRenameOperationCount: number;
		initialPendingOperationCount: number;
		initialPendingApplyCount: number;
		initialAttentionCount: number;
		initialConfirmationCount: number;
		pendingOperationDelta: number;
		pendingApplyDelta: number;
		attentionDelta: number;
		confirmationDelta: number;
	};
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

/**
 * Builds a safe case summary and replaces unrecognized diagnostics with generic labels.
 *
 * @param options - Enables AC-30 diagnostic output for host result boundaries.
 */
export function safeCaseResult(
	caseId: string,
	evidence: DesktopCaseSummary["evidence"],
	result: Record<string, unknown>,
	options: { includeAc30Diagnostic?: boolean } = {},
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
	let caseEvidence: unknown;
	try {
		caseEvidence = Reflect.get(result, "caseEvidence");
	} catch {
		caseEvidence = undefined;
	}
	const rawReceiptStatus =
		caseId === "AC-33" && caseEvidence && typeof caseEvidence === "object"
			? readRecordProperty(caseEvidence, "renameReceiptStatus").value
			: result.receiptStatus;
	const receiptStatus =
		MutationReceiptSchema.shape.status.safeParse(rawReceiptStatus);
	const rawAc30FinalAssertion =
		caseId === "AC-30" &&
		status === "failed" &&
		failureStage === "action" &&
		caseEvidence &&
		typeof caseEvidence === "object"
			? readRecordProperty(caseEvidence, "ac30FinalAssertion").value
			: null;
	const ac30FinalAssertion = safeAc30FinalAssertion(
		rawAc30FinalAssertion,
		failureReason,
		options.includeAc30Diagnostic === true,
	);
	const rawAc13Cleanup =
		caseId === "AC-13" && caseEvidence && typeof caseEvidence === "object"
			? readRecordProperty(caseEvidence, "ac13Cleanup").value
			: null;
	const rawWrapperRestored = readRecordProperty(
		rawAc13Cleanup,
		"wrapperRestored",
	).value;
	const rawControllerResumed = readRecordProperty(
		rawAc13Cleanup,
		"controllerResumed",
	).value;
	const ac13Cleanup =
		typeof rawWrapperRestored === "boolean" &&
		typeof rawControllerResumed === "boolean"
			? {
					wrapperRestored: rawWrapperRestored,
					controllerResumed: rawControllerResumed,
				}
			: undefined;
	const rawAc19Evidence =
		caseId === "AC-19" && caseEvidence && typeof caseEvidence === "object"
			? readRecordProperty(caseEvidence, "ac19").value
			: null;
	/** Returns an allowlisted boolean or null when AC-19 evidence is untrusted. */
	const ac19Boolean = (key: string) => {
		const value = readRecordProperty(rawAc19Evidence, key).value;
		return typeof value === "boolean" ? value : null;
	};
	/** Returns a bounded integer count or delta without copying host objects. */
	const ac19Integer = (key: string, allowNegative = false) => {
		const value = readRecordProperty(rawAc19Evidence, key).value;
		return Number.isSafeInteger(value) &&
			(allowNegative
				? Math.abs(value as number) <= 100_000
				: (value as number) >= 0 && (value as number) <= 100_000)
			? (value as number)
			: null;
	};
	const ac19ServiceSourceLive = readRecordProperty(
		rawAc19Evidence,
		"serviceSourceLive",
	).value;
	const ac19Evidence =
		ac19Boolean("captureReload") !== null &&
		ac19Boolean("attentionUnchanged") !== null &&
		ac19Boolean("baselineSynced") !== null &&
		ac19Boolean("confirmationVisible") !== null &&
		ac19Boolean("placeholderExcluded") !== null &&
		(ac19ServiceSourceLive === null ||
			typeof ac19ServiceSourceLive === "boolean") &&
		ac19Integer("deleteOrRenameOperationCount") !== null &&
		ac19Integer("initialPendingOperationCount") !== null &&
		ac19Integer("initialPendingApplyCount") !== null &&
		ac19Integer("initialAttentionCount") !== null &&
		ac19Integer("initialConfirmationCount") !== null &&
		ac19Integer("pendingOperationDelta", true) !== null &&
		ac19Integer("pendingApplyDelta", true) !== null &&
		ac19Integer("attentionDelta", true) !== null &&
		ac19Integer("confirmationDelta", true) !== null
			? {
					captureReload: ac19Boolean("captureReload") as boolean,
					attentionUnchanged: ac19Boolean("attentionUnchanged") as boolean,
					baselineSynced: ac19Boolean("baselineSynced") as boolean,
					confirmationVisible: ac19Boolean("confirmationVisible") as boolean,
					placeholderExcluded: ac19Boolean("placeholderExcluded") as boolean,
					serviceSourceLive: ac19ServiceSourceLive as boolean | null,
					deleteOrRenameOperationCount: ac19Integer(
						"deleteOrRenameOperationCount",
					) as number,
					initialPendingOperationCount: ac19Integer(
						"initialPendingOperationCount",
					) as number,
					initialPendingApplyCount: ac19Integer(
						"initialPendingApplyCount",
					) as number,
					initialAttentionCount: ac19Integer("initialAttentionCount") as number,
					initialConfirmationCount: ac19Integer(
						"initialConfirmationCount",
					) as number,
					pendingOperationDelta: ac19Integer(
						"pendingOperationDelta",
						true,
					) as number,
					pendingApplyDelta: ac19Integer("pendingApplyDelta", true) as number,
					attentionDelta: ac19Integer("attentionDelta", true) as number,
					confirmationDelta: ac19Integer("confirmationDelta", true) as number,
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
		...(ac30FinalAssertion ? { ac30FinalAssertion } : {}),
		...(ac13Cleanup ? { ac13Cleanup } : {}),
		...(ac19Evidence ? { ac19Evidence } : {}),
		cleanupStatus,
	};
}

/** Result of one guarded property read from host evidence. */
interface SafePropertyRead {
	/** Untrusted value that still needs validation at its consumer. */
	value: unknown;
}

/** Reads one host property without letting a hostile getter stop safe projection. */
function readRecordProperty(value: unknown, key: string): SafePropertyRead {
	if (value === null || typeof value !== "object") return { value: undefined };
	try {
		return { value: Reflect.get(value, key) };
	} catch {
		return { value: undefined };
	}
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

/**
 * Projects only allowlisted AC-30 assertion values and omits raw identity data.
 *
 * @param includeDiagnostic - Includes only the bounded AC-30 diagnostic projection.
 */
function safeAc30FinalAssertion(
	value: unknown,
	failureReason: SafeCaseFailureReason | null,
	includeDiagnostic = false,
): SafeAc30FinalAssertion | null {
	if (!value || typeof value !== "object") return null;
	const code = readRecordProperty(value, "code").value;
	const expected = readRecordProperty(value, "expected").value;
	const observed = readRecordProperty(value, "observed").value;
	/** Allows only non-sensitive scalar values in the returned case summary. */
	const isSafeValue = (
		candidate: unknown,
	): candidate is SafeAc30ObservationValue =>
		typeof candidate === "boolean" ||
		candidate === null ||
		(typeof candidate === "number" && Number.isSafeInteger(candidate)) ||
		AC30_SAFE_OBSERVATION_STATES.some((item) => item === candidate);
	if (
		!AC30_FINAL_ASSERTION_CODES.some((item) => item === code) ||
		code !== failureReason ||
		!isSafeValue(expected) ||
		!isSafeValue(observed)
	)
		return null;
	const diagnostic = includeDiagnostic
		? safeAc30Diagnostic(readRecordProperty(value, "diagnostic").value)
		: null;
	return {
		code: code as SafeAc30FinalAssertion["code"],
		expected,
		observed,
		...(diagnostic ? { diagnostic } : {}),
	};
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
	return safeCaseResult(caseId, evidence, readCaseResultRecord(output), {
		includeAc30Diagnostic: true,
	});
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
		const preflightSummary = safeCaseResult(caseId, evidence, preflightRecord, {
			includeAc30Diagnostic: true,
		});
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
	const summary = safeCaseResult(caseId, evidence, record, {
		includeAc30Diagnostic: true,
	});
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

/** Values that can describe a mismatch without exposing payloads or identities. */
type SafeAc30ObservationValue =
	| boolean
	| number
	| null
	| (typeof AC30_SAFE_OBSERVATION_STATES)[number];

/** Ordinal label for one observed AC-30 request without exposing its key. */
type SafeAc30CallOrdinal = (typeof AC30_DIAGNOSTIC_CALL_ORDINALS)[number];

/** Safe status and revision observed at one AC-30 request boundary. */
interface SafeAc30CallDiagnostic {
	/** Stable request role assigned by call order, not by key value. */
	ordinal: SafeAc30CallOrdinal;
	/** Valid HTTP response status, or null before a response. */
	status: number | null;
	/** Valid service revision, or null before authoritative read-back. */
	revision: number | null;
}

/** Safe summary for one pending fixture operation at assertion time. */
interface SafeAc30QueueOperationDiagnostic {
	/** Ordinal identity label, or other for an unrelated operation. */
	ordinal: SafeAc30CallOrdinal | "other";
	/** Valid publication lifecycle state. */
	state: (typeof AC30_DIAGNOSTIC_OPERATION_STATES)[number];
	/** Valid publication operation kind. */
	operation: (typeof AC30_DIAGNOSTIC_OPERATION_KINDS)[number];
	/** Valid conditional-write kind without its epoch or revision value. */
	preconditionKind: "match" | "absent";
}

/** Safe queue counts and bounded fixture-operation samples at assertion time. */
interface SafeAc30QueueDiagnostic {
	/** Number of all pending journal operations, or null when invalid. */
	pendingOperationCount: number | null;
	/** Number of pending local applies, or null when invalid. */
	pendingApplyCount: number | null;
	/** Number of unresolved attention records, or null when invalid. */
	attentionCount: number | null;
	/** Number of queued operations for the authorized fixture path. */
	fixtureOperationCount: number | null;
	/** Number of queued operations for other paths, without path values. */
	otherPathOperationCount: number | null;
	/** At most three operations, without key, path, payload, or precondition values. */
	fixtureOperations: SafeAc30QueueOperationDiagnostic[];
}

/** Safe AC-30 call identity equalities and final queue observations. */
interface SafeAc30Diagnostic {
	/** Number of observed fixture requests, bounded to one hundred. */
	callCount: number | null;
	/** At most three HTTP status and authoritative revision samples. */
	calls: SafeAc30CallDiagnostic[];
	/** Whether retry identity matched the first request identity. */
	retryIdentityMatches: boolean | null;
	/** Whether the successor used a key distinct from the first request. */
	successorIdentityDistinct: boolean | null;
	/** Whether retry bytes matched the original payload hash. */
	retryPayloadMatches: boolean | null;
	/** Whether successor bytes matched the edited payload. */
	successorPayloadMatches: boolean | null;
	/** Whether the retry repeated the first conditional-write precondition. */
	retryPreconditionMatches: boolean | null;
	/** Whether every retry receipt field matched the first response. */
	retryReceiptMatches: boolean | null;
	/** Queue state sampled when the final assertion failed. */
	queue: SafeAc30QueueDiagnostic;
}

/** Safe expected and observed values for one failed final AC-30 assertion. */
interface SafeAc30FinalAssertion {
	/** Allowlisted final assertion code that matches the safe failure reason. */
	code: (typeof AC30_FINAL_ASSERTION_CODES)[number];
	/** Safe expected scalar or state label. */
	expected: SafeAc30ObservationValue;
	/** Safe observed scalar or state label. */
	observed: SafeAc30ObservationValue;
	/** Bounded call and queue facts when the host requested diagnostic output. */
	diagnostic?: SafeAc30Diagnostic;
}

/** Projects one bounded safe diagnostic without returning host identities or payloads. */
function safeAc30Diagnostic(value: unknown): SafeAc30Diagnostic | null {
	if (value === null || typeof value !== "object") return null;
	try {
		const rawCalls = readRecordProperty(value, "calls").value;
		const calls = Array.isArray(rawCalls)
			? rawCalls
					.slice(0, AC30_DIAGNOSTIC_SAMPLE_LIMIT)
					.flatMap((item, index) => {
						if (item === null || typeof item !== "object") return [];
						const ordinal = AC30_DIAGNOSTIC_CALL_ORDINALS[index];
						if (!ordinal) return [];
						return [
							{
								ordinal,
								status: safeDiagnosticInteger(
									readRecordProperty(item, "status").value,
									100,
									599,
								),
								revision: safeDiagnosticInteger(
									readRecordProperty(item, "revision").value,
									1,
									Number.MAX_SAFE_INTEGER,
								),
							},
						];
					})
			: [];
		const rawQueue = readRecordProperty(value, "queue").value;
		const queue =
			rawQueue !== null && typeof rawQueue === "object" ? rawQueue : null;
		const rawOperations = queue
			? readRecordProperty(queue, "fixtureOperations").value
			: null;
		const fixtureOperations = Array.isArray(rawOperations)
			? rawOperations.slice(0, AC30_DIAGNOSTIC_SAMPLE_LIMIT).flatMap((item) => {
					if (item === null || typeof item !== "object") return [];
					const rawOrdinal = readRecordProperty(item, "ordinal").value;
					const ordinal: SafeAc30QueueOperationDiagnostic["ordinal"] =
						rawOrdinal === "first" ||
						rawOrdinal === "retry" ||
						rawOrdinal === "successor"
							? rawOrdinal
							: "other";
					const state = AC30_DIAGNOSTIC_OPERATION_STATES.find(
						(candidate) =>
							candidate === readRecordProperty(item, "state").value,
					);
					const operation = AC30_DIAGNOSTIC_OPERATION_KINDS.find(
						(candidate) =>
							candidate === readRecordProperty(item, "operation").value,
					);
					const preconditionKind = readRecordProperty(
						item,
						"preconditionKind",
					).value;
					if (
						!state ||
						!operation ||
						(preconditionKind !== "match" && preconditionKind !== "absent")
					)
						return [];
					const safePreconditionKind: "match" | "absent" =
						preconditionKind === "match" ? "match" : "absent";
					return [
						{
							ordinal,
							state,
							operation,
							preconditionKind: safePreconditionKind,
						},
					];
				})
			: [];
		/** Keeps only boolean diagnostic facts from untrusted host evidence. */
		const booleanValue = (key: string): boolean | null => {
			const candidate = readRecordProperty(value, key).value;
			return typeof candidate === "boolean" ? candidate : null;
		};
		return {
			callCount: safeDiagnosticInteger(
				readRecordProperty(value, "callCount").value,
				0,
				100,
			),
			calls,
			retryIdentityMatches: booleanValue("retryIdentityMatches"),
			successorIdentityDistinct: booleanValue("successorIdentityDistinct"),
			retryPayloadMatches: booleanValue("retryPayloadMatches"),
			successorPayloadMatches: booleanValue("successorPayloadMatches"),
			retryPreconditionMatches: booleanValue("retryPreconditionMatches"),
			retryReceiptMatches: booleanValue("retryReceiptMatches"),
			queue: {
				pendingOperationCount: safeDiagnosticInteger(
					queue
						? readRecordProperty(queue, "pendingOperationCount").value
						: null,
					0,
					100_000,
				),
				pendingApplyCount: safeDiagnosticInteger(
					queue ? readRecordProperty(queue, "pendingApplyCount").value : null,
					0,
					100_000,
				),
				attentionCount: safeDiagnosticInteger(
					queue ? readRecordProperty(queue, "attentionCount").value : null,
					0,
					100_000,
				),
				fixtureOperationCount: safeDiagnosticInteger(
					queue
						? readRecordProperty(queue, "fixtureOperationCount").value
						: null,
					0,
					100_000,
				),
				otherPathOperationCount: safeDiagnosticInteger(
					queue
						? readRecordProperty(queue, "otherPathOperationCount").value
						: null,
					0,
					100_000,
				),
				fixtureOperations,
			},
		};
	} catch {
		return null;
	}
}

/** Returns a bounded integer or null for malformed and out-of-range host data. */
function safeDiagnosticInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
		? value
		: null;
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

/** Guarded action and local recovery for the dev-2 AC-19 service case. */
export interface Ac19CaseScripts {
	/** Seeds one fresh source and measures simulated eviction against its baseline. */
	action: string;
	/** Restores the synthetic local source and leaves dev-2 paused. */
	cleanup: string;
}

/** Builds the dev-2 AC-19 case for the exact authorized synthetic vault path. */
export function createAc19CaseScripts(
	id: DesktopVaultId,
	resolvedPath: string,
	home = homedir(),
): Ac19CaseScripts {
	if (id !== "dev-2") throw new Error("AC-19 service case requires dev-2");
	const target = assertAuthorizedVault(id, resolvedPath, home);
	const fixture = createAc19FixturePaths(id);
	const action = `
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw new Error("AC19_ASSERT_TARGET_VAULT");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.journal?.snapshot || !plugin.desktopSync || !plugin.coexistence || !plugin.composition?.publication || !plugin.settingsTab?.syncActions?.pause || !plugin.settingsTab?.syncActions?.resume || !plugin.settingsValue?.coexistenceMode || plugin.settingsValue?.deviceName !== "oab-10.1 dev-2") throw new Error("AC19_ASSERT_PLUGIN_CONTROLS");
		if (plugin.sessionStatus !== "connected" || plugin.desktopSync.isBusy || plugin.syncPaused || plugin.syncActive) throw new Error("AC19_ASSERT_INITIAL_STATE");
		const adapter = app.vault.adapter;
		const source = ${JSON.stringify(fixture.source)};
		const placeholder = ${JSON.stringify(fixture.placeholder)};
		if (app.vault.getAbstractFileByPath(source) || await adapter.stat(source) || await adapter.stat(placeholder)) throw new Error("AC19_ASSERT_FIXTURE_COLLISION");
		const remote = Reflect.get(plugin.composition.publication, "remote");
		if (!remote?.readCurrentAuthority) throw new Error("AC19_ASSERT_REMOTE_AUTHORITY");
		let servicePathAbsent = false;
		try { await withCaseBoundary("AC19_READ_SERVICE_ABSENCE", () => remote.readCurrentAuthority(source)); } catch (error) { servicePathAbsent = readBoundaryDetails(error)?.status === 404; if (!servicePathAbsent) throw error; }
		if (!servicePathAbsent) throw new Error("AC19_ASSERT_SERVICE_PATH_ABSENT");
		const initial = plugin.journal.snapshot();
		if (!initial.epoch || initial.base?.[source] || initial.base?.[placeholder] || initial.pending_ops?.length || initial.pending_apply?.length || initial.coexistence_confirmations?.length) throw new Error("AC19_ASSERT_INITIAL_STATE");
		const initialCounts = { pendingOperations: initial.pending_ops.length, pendingApplies: initial.pending_apply.length, attention: initial.attention.length, confirmations: initial.coexistence_confirmations.length };
		ac19Cleanup.initialCounts = initialCounts;
		ac19Cleanup.initialAttention = structuredClone(initial.attention);
		ac19Cleanup.remote = remote;
		ac19Cleanup.started = true;
		const waitFor = async (test) => {
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) {
				if (test()) return true;
				await new Promise((resolve) => window.setTimeout(resolve, 50));
			}
			return test();
		};
		if (!(await adapter.stat("oab-10.1"))) await adapter.mkdir("oab-10.1");
		if (!(await adapter.stat(${JSON.stringify(fixture.root)}))) await adapter.mkdir(${JSON.stringify(fixture.root)});
		const file = await app.vault.create(source, "OAB-10.1 synthetic coexistence fixture\\n");
		ac19Cleanup.sourceCreated = true;
		await withCaseBoundary("AC19_SEED_BASELINE", () => plugin.desktopSync.syncNow());
		await withCaseBoundary("AC19_WAIT_BASELINE_IDLE", () => plugin.desktopSync.waitForIdle());
		const seeded = plugin.journal.snapshot();
		const baseline = seeded.base?.[source];
		if (!baseline || baseline.deleted || !seeded.epoch || seeded.pending_ops.length !== initialCounts.pendingOperations || seeded.pending_apply.length !== initialCounts.pendingApplies || JSON.stringify(seeded.attention) !== JSON.stringify(ac19Cleanup.initialAttention)) throw new Error("AC19_ASSERT_BASELINE_SYNC");
		const serviceBefore = await withCaseBoundary("AC19_READ_SERVICE_AUTHORITY", () => remote.readCurrentAuthority(source));
		ac19Cleanup.serviceAuthority = { deleted: serviceBefore.deleted, epoch: serviceBefore.epoch, rev: serviceBefore.rev, hash: serviceBefore.hash };
		if (serviceBefore.deleted || serviceBefore.epoch !== seeded.epoch || serviceBefore.rev !== baseline.rev || serviceBefore.hash !== baseline.hash) throw new Error("AC19_ASSERT_BASELINE_SYNC");
		caseEvidence.ac19 = { captureReload: false, attentionUnchanged: false, baselineSynced: true, confirmationVisible: false, placeholderExcluded: false, serviceSourceLive: false, deleteOrRenameOperationCount: 0, initialPendingOperationCount: initialCounts.pendingOperations, initialPendingApplyCount: initialCounts.pendingApplies, initialAttentionCount: initialCounts.attention, initialConfirmationCount: initialCounts.confirmations, pendingOperationDelta: 0, pendingApplyDelta: 0, attentionDelta: 0, confirmationDelta: 0 };
		plugin.settingsTab.syncActions.pause();
		ac19Cleanup.pausedByCase = true;
		if (!(await waitFor(() => plugin.syncPaused && plugin.composition === null))) throw new Error("AC19_ASSERT_PAUSE");
		await app.vault.trash(file, false);
		await app.vault.createBinary(placeholder, new ArrayBuffer(0));
		if (!(await waitFor(() => plugin.journal.snapshot().coexistence_confirmations?.some((item) => item.path === source)))) throw new Error("AC19_ASSERT_CONFIRMATION");
		const captured = plugin.journal.snapshot();
		const confirmation = captured.coexistence_confirmations.find((item) => item.path === source);
		const unavailable = captured.unavailable_paths?.includes(source) ?? false;
		const placeholderExcluded = !Object.prototype.hasOwnProperty.call(captured.base ?? {}, placeholder) && !captured.pending_ops?.some((operation) => operation.path === placeholder || operation.to === placeholder);
		const deleteOrRenameOperationCount = captured.pending_ops?.filter((operation) => (operation.op === "delete" || operation.op === "rename") && (operation.path === source || operation.to === source)).length ?? 0;
		if (!confirmation || !unavailable || !placeholderExcluded) throw new Error("AC19_ASSERT_PLACEHOLDER_EXCLUDED");
		if (!(await waitFor(() => !plugin.desktopSync.isBusy))) throw new Error("AC19_ASSERT_CONFIRMATION");
		const settled = plugin.journal.snapshot();
		const serviceAfter = await withCaseBoundary("AC19_READ_SERVICE_AUTHORITY", () => remote.readCurrentAuthority(source));
		const serviceSourceLive = Boolean(!serviceAfter.deleted && serviceAfter.epoch === serviceBefore.epoch && serviceAfter.rev === serviceBefore.rev && serviceAfter.hash === serviceBefore.hash && deleteOrRenameOperationCount === 0);
		const attentionUnchanged = JSON.stringify(settled.attention) === JSON.stringify(ac19Cleanup.initialAttention);
		const deltas = { pendingOperationDelta: settled.pending_ops.length - initialCounts.pendingOperations, pendingApplyDelta: settled.pending_apply.length - initialCounts.pendingApplies, attentionDelta: settled.attention.length - initialCounts.attention, confirmationDelta: settled.coexistence_confirmations.length - initialCounts.confirmations };
		if (deltas.pendingOperationDelta !== 0 || deltas.pendingApplyDelta !== 0 || deltas.attentionDelta !== 0 || deltas.confirmationDelta !== 1 || !attentionUnchanged || !serviceSourceLive) throw new Error("AC19_ASSERT_BASELINE_DELTAS");
		caseEvidence.ac19 = { captureReload: false, attentionUnchanged, baselineSynced: true, confirmationVisible: Boolean(confirmation), placeholderExcluded, serviceSourceLive, deleteOrRenameOperationCount, initialPendingOperationCount: initialCounts.pendingOperations, initialPendingApplyCount: initialCounts.pendingApplies, initialAttentionCount: initialCounts.attention, initialConfirmationCount: initialCounts.confirmations, ...deltas };
	`;
	const cleanup = `
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw new Error("AC19_CLEANUP_RESTORE_FAILED");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.journal?.snapshot || !plugin.desktopSync || !plugin.coexistence) throw new Error("AC19_CLEANUP_RESTORE_FAILED");
		if (ac19Cleanup.started && ac19Cleanup.sourceCreated && !ac19Cleanup.pausedByCase) {
			plugin.settingsTab.syncActions.pause();
			ac19Cleanup.pausedByCase = true;
			const pauseDeadline = Date.now() + 15000;
			while ((!plugin.syncPaused || plugin.composition !== null) && Date.now() < pauseDeadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
			if (!plugin.syncPaused || plugin.composition !== null) throw new Error("AC19_CLEANUP_PAUSE_FAILED");
			const sourceFile = app.vault.getAbstractFileByPath(${JSON.stringify(fixture.source)});
			if (sourceFile) await app.vault.trash(sourceFile, false);
			if (!app.vault.getAbstractFileByPath(${JSON.stringify(fixture.placeholder)})) await app.vault.createBinary(${JSON.stringify(fixture.placeholder)}, new ArrayBuffer(0));
			const deadline = Date.now() + 15000;
			while (!plugin.journal.snapshot().coexistence_confirmations.some((item) => item.path === ${JSON.stringify(fixture.source)}) && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
			if (!plugin.journal.snapshot().coexistence_confirmations.some((item) => item.path === ${JSON.stringify(fixture.source)})) throw new Error("AC19_CLEANUP_CONFIRMATION_MISSING");
		}
		if (ac19Cleanup.started && ac19Cleanup.sourceCreated && !ac19Cleanup.serviceAuthority) throw new Error("AC19_CLEANUP_AUTHORITY_UNKNOWN");
		if (ac19Cleanup.started && ac19Cleanup.sourceCreated) {
			const placeholder = app.vault.getAbstractFileByPath(${JSON.stringify(fixture.placeholder)});
			if (placeholder) await app.vault.trash(placeholder, false);
			const unavailableDeadline = Date.now() + 15000;
			while (plugin.journal.snapshot().unavailable_paths.includes(${JSON.stringify(fixture.source)}) && Date.now() < unavailableDeadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
			if (plugin.journal.snapshot().unavailable_paths.includes(${JSON.stringify(fixture.source)})) throw new Error("AC19_CLEANUP_PLACEHOLDER_BLOCKED");
			for (const item of plugin.journal.snapshot().coexistence_confirmations ?? []) if (item.path === ${JSON.stringify(fixture.source)}) await plugin.coexistence.keepServerState(item.id);
			if (ac19Cleanup.pausedByCase) {
				try {
					plugin.settingsTab.syncActions.resume();
					const resumeDeadline = Date.now() + 15000;
					while ((plugin.syncPaused || !plugin.composition || plugin.desktopSync.isBusy) && Date.now() < resumeDeadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
					await plugin.desktopSync.waitForIdle();
					if (plugin.syncPaused || !plugin.composition || !app.vault.getAbstractFileByPath(${JSON.stringify(fixture.source)})) throw new Error("AC19_CLEANUP_RESTORE_FAILED");
					const finalState = plugin.journal.snapshot();
					if (finalState.pending_ops.length !== ac19Cleanup.initialCounts.pendingOperations || finalState.pending_apply.length !== ac19Cleanup.initialCounts.pendingApplies || JSON.stringify(finalState.attention) !== JSON.stringify(ac19Cleanup.initialAttention) || finalState.coexistence_confirmations.length !== ac19Cleanup.initialCounts.confirmations) throw new Error("AC19_CLEANUP_HISTORICAL_STATE_CHANGED");
					const finalAuthority = await withCaseBoundary("AC19_READ_SERVICE_AUTHORITY", () => ac19Cleanup.remote.readCurrentAuthority(${JSON.stringify(fixture.source)}));
					if (finalAuthority.deleted || finalAuthority.epoch !== ac19Cleanup.serviceAuthority.epoch || finalAuthority.rev !== ac19Cleanup.serviceAuthority.rev || finalAuthority.hash !== ac19Cleanup.serviceAuthority.hash) throw new Error("AC19_CLEANUP_SERVICE_CHANGED");
				} finally {
					plugin.settingsTab.syncActions.pause();
					const pauseDeadline = Date.now() + 15000;
					while ((!plugin.syncPaused || plugin.composition !== null) && Date.now() < pauseDeadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
					if (!plugin.syncPaused || plugin.composition !== null) throw new Error("AC19_CLEANUP_PAUSE_FAILED");
					ac19Cleanup.pausedByCase = false;
				}
			}
		}
	`;
	return { action, cleanup };
}

/** Builds dev-1 capture and reload checks around a latest-bundle installation. */
export interface Ac19CaptureReloadScripts {
	/** Captures a fresh local deletion while the existing controller stays paused. */
	capture: string;
	/** Checks durable state after the caller installs and enables the new bundle. */
	reloadVerification: string;
}

/** Builds guarded dev-1 scripts that never issue a Resume action. */
export function createAc19CaptureReloadScripts(
	resolvedPath: string,
	home = homedir(),
): Ac19CaptureReloadScripts {
	const target = assertAuthorizedVault("dev-1", resolvedPath, home);
	const fixture = createAc19FixturePaths("dev-1");
	const capture = `
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw new Error("AC19_CAPTURE_ASSERT_TARGET_VAULT");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.journal?.snapshot || !plugin.desktopSync || !plugin.coexistence || !plugin.settingsValue?.coexistenceMode || plugin.settingsValue?.deviceName !== "oab-10.1 dev-1") throw new Error("AC19_CAPTURE_ASSERT_PLUGIN_CONTROLS");
		if (plugin.sessionStatus !== "connected" || !plugin.syncPaused || plugin.syncStatus?.().state !== "paused" || plugin.desktopSync.isBusy || plugin.syncActive) throw new Error("AC19_CAPTURE_ASSERT_PAUSED");
		if (globalThis.__oab10Ac19Capture) throw new Error("AC19_CAPTURE_ASSERT_ALREADY_ACTIVE");
		const source = ${JSON.stringify(fixture.source)};
		const placeholder = ${JSON.stringify(fixture.placeholder)};
		const adapter = app.vault.adapter;
		if (app.vault.getAbstractFileByPath(source) || await adapter.stat(source) || await adapter.stat(placeholder)) throw new Error("AC19_CAPTURE_ASSERT_FIXTURE_COLLISION");
		const initial = plugin.journal.snapshot();
		if (initial.coexistence_confirmations.some((item) => item.path === source) || initial.base?.[source] || initial.base?.[placeholder]) throw new Error("AC19_CAPTURE_ASSERT_INITIAL_STATE");
		const history = { pending_ops: structuredClone(initial.pending_ops), pending_apply: structuredClone(initial.pending_apply), attention: structuredClone(initial.attention) };
		const counts = { pendingOperations: history.pending_ops.length, pendingApplies: history.pending_apply.length, attention: history.attention.length, confirmations: initial.coexistence_confirmations.length };
		const waitFor = async (test) => {
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) { if (test()) return true; await new Promise((resolve) => window.setTimeout(resolve, 50)); }
			return test();
		};
		if (!(await adapter.stat("oab-10.1"))) await adapter.mkdir("oab-10.1");
		if (!(await adapter.stat(${JSON.stringify(fixture.root)}))) await adapter.mkdir(${JSON.stringify(fixture.root)});
		const file = await app.vault.create(source, "OAB-10.1 capture-only fixture\\n");
		await app.vault.trash(file, false);
		await app.vault.createBinary(placeholder, new ArrayBuffer(0));
		if (!(await waitFor(() => plugin.journal.snapshot().coexistence_confirmations.some((item) => item.path === source)))) throw new Error("AC19_CAPTURE_ASSERT_CONFIRMATION");
		const captured = plugin.journal.snapshot();
		const confirmation = captured.coexistence_confirmations.find((item) => item.path === source);
		const placeholderExcluded = !Object.prototype.hasOwnProperty.call(captured.base ?? {}, placeholder) && !captured.pending_ops.some((item) => item.path === placeholder || item.to === placeholder);
		const historyUnchanged = JSON.stringify({ pending_ops: captured.pending_ops, pending_apply: captured.pending_apply, attention: captured.attention }) === JSON.stringify(history);
		if (!confirmation || !captured.unavailable_paths.includes(source) || !placeholderExcluded || !historyUnchanged) throw new Error("AC19_CAPTURE_ASSERT_CAPTURE_ONLY");
		globalThis.__oab10Ac19Capture = { source, placeholder, history, counts, confirmationId: confirmation.id };
		const deltas = { pendingOperationDelta: captured.pending_ops.length - counts.pendingOperations, pendingApplyDelta: captured.pending_apply.length - counts.pendingApplies, attentionDelta: captured.attention.length - counts.attention, confirmationDelta: captured.coexistence_confirmations.length - counts.confirmations };
		if (deltas.pendingOperationDelta !== 0 || deltas.pendingApplyDelta !== 0 || deltas.attentionDelta !== 0 || deltas.confirmationDelta !== 1) throw new Error("AC19_CAPTURE_ASSERT_BASELINE_DELTAS");
		caseEvidence.ac19 = { captureReload: false, attentionUnchanged: historyUnchanged, baselineSynced: false, confirmationVisible: true, placeholderExcluded, serviceSourceLive: null, deleteOrRenameOperationCount: 0, initialPendingOperationCount: counts.pendingOperations, initialPendingApplyCount: counts.pendingApplies, initialAttentionCount: counts.attention, initialConfirmationCount: counts.confirmations, ...deltas };
	`;
	const reloadVerification = `
		if (app.vault.adapter.getBasePath() !== ${JSON.stringify(target)}) throw new Error("AC19_RELOAD_ASSERT_TARGET_VAULT");
		const baseline = globalThis.__oab10Ac19Capture;
		if (!baseline) throw new Error("AC19_RELOAD_ASSERT_BASELINE_MISSING");
		const plugin = app.plugins.plugins?.["ai-bridge"];
		if (!plugin?.journal?.snapshot || !plugin.desktopSync || !plugin.settingsValue?.coexistenceMode || plugin.settingsValue?.deviceName !== "oab-10.1 dev-1") throw new Error("AC19_RELOAD_ASSERT_PLUGIN_CONTROLS");
		const waitFor = async (test) => {
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) { if (test()) return true; await new Promise((resolve) => window.setTimeout(resolve, 50)); }
			return test();
		};
		if (!(await waitFor(() => plugin.sessionStatus === "connected" && !plugin.desktopSync.isBusy))) throw new Error("AC19_RELOAD_ASSERT_CONNECTED");
		const after = plugin.journal.snapshot();
		const unchanged = JSON.stringify({ pending_ops: after.pending_ops, pending_apply: after.pending_apply, attention: after.attention }) === JSON.stringify(baseline.history);
		const confirmationVisible = after.coexistence_confirmations.some((item) => item.id === baseline.confirmationId && item.path === baseline.source);
		const placeholderExcluded = !Object.prototype.hasOwnProperty.call(after.base ?? {}, baseline.placeholder) && !after.pending_ops.some((item) => item.path === baseline.placeholder || item.to === baseline.placeholder);
		const fixtureOperationCount = after.pending_ops.filter((item) => (item.op === "delete" || item.op === "rename") && (item.path === baseline.source || item.to === baseline.source)).length;
		const deltas = { pendingOperationDelta: after.pending_ops.length - baseline.counts.pendingOperations, pendingApplyDelta: after.pending_apply.length - baseline.counts.pendingApplies, attentionDelta: after.attention.length - baseline.counts.attention, confirmationDelta: after.coexistence_confirmations.length - baseline.counts.confirmations };
		if (!unchanged || !confirmationVisible || !after.unavailable_paths.includes(baseline.source) || !app.vault.getAbstractFileByPath(baseline.placeholder) || !placeholderExcluded || fixtureOperationCount !== 0 || deltas.pendingOperationDelta !== 0 || deltas.pendingApplyDelta !== 0 || deltas.attentionDelta !== 0 || deltas.confirmationDelta !== 1) throw new Error("AC19_RELOAD_ASSERT_HISTORY_CHANGED");
		caseEvidence.ac19 = { captureReload: true, attentionUnchanged: unchanged, baselineSynced: false, confirmationVisible, placeholderExcluded, serviceSourceLive: null, deleteOrRenameOperationCount: fixtureOperationCount, initialPendingOperationCount: baseline.counts.pendingOperations, initialPendingApplyCount: baseline.counts.pendingApplies, initialAttentionCount: baseline.counts.attention, initialConfirmationCount: baseline.counts.confirmations, ...deltas };
		delete globalThis.__oab10Ac19Capture;
	`;
	return { capture, reloadVerification };
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
		const ac30FinalAssertionCodes = ${JSON.stringify(AC30_FINAL_ASSERTION_CODES)};
		const ac30DiagnosticCallOrdinals = ${JSON.stringify(AC30_DIAGNOSTIC_CALL_ORDINALS)};
		const ac30SafeObservationStates = ${JSON.stringify(AC30_SAFE_OBSERVATION_STATES)};
		const ac30DiagnosticOperationStates = ${JSON.stringify(AC30_DIAGNOSTIC_OPERATION_STATES)};
		const ac30DiagnosticOperationKinds = ${JSON.stringify(AC30_DIAGNOSTIC_OPERATION_KINDS)};
		const boundaryDetailsKey = Symbol("case-boundary-details");
		const caseEvidence = {};
		const ac19Cleanup = { pausedByCase: false, started: false, sourceCreated: false, initialCounts: null, initialAttention: null, remote: null, serviceAuthority: null };
		const safeAc30ObservationValue = (value) => {
			if (typeof value === "boolean" || value === null) return value;
			if (typeof value === "number" && Number.isSafeInteger(value)) return value;
			return ac30SafeObservationStates.includes(value) ? value : "other";
		};
		const safeDiagnosticInteger = (value, minimum, maximum) =>
			Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
		const safeAc30Diagnostic = (value) => {
			if (!value || typeof value !== "object") return null;
			try {
				const queue = value.queue && typeof value.queue === "object" ? value.queue : {};
				const calls = Array.isArray(value.calls) ? value.calls.slice(0, 3).flatMap((call, index) => {
					if (!call || typeof call !== "object") return [];
					return [{ ordinal: ac30DiagnosticCallOrdinals[index], status: safeDiagnosticInteger(call.status, 100, 599), revision: safeDiagnosticInteger(call.revision, 1, Number.MAX_SAFE_INTEGER) }];
				}) : [];
				const fixtureOperations = Array.isArray(queue.fixtureOperations) ? queue.fixtureOperations.slice(0, 3).flatMap((operation) => {
					if (!operation || typeof operation !== "object") return [];
					const ordinal = ac30DiagnosticCallOrdinals.includes(operation.ordinal) ? operation.ordinal : "other";
					const state = ac30DiagnosticOperationStates.find((item) => item === operation.state);
					const kind = ac30DiagnosticOperationKinds.find((item) => item === operation.operation);
					const preconditionKind = operation.preconditionKind;
					if (!state || !kind || (preconditionKind !== "match" && preconditionKind !== "absent")) return [];
					return [{ ordinal, state, operation: kind, preconditionKind }];
				}) : [];
				const safeBoolean = (candidate) => typeof candidate === "boolean" ? candidate : null;
				return {
					callCount: safeDiagnosticInteger(value.callCount, 0, 100), calls,
					retryIdentityMatches: safeBoolean(value.retryIdentityMatches),
					successorIdentityDistinct: safeBoolean(value.successorIdentityDistinct),
					retryPayloadMatches: safeBoolean(value.retryPayloadMatches),
					successorPayloadMatches: safeBoolean(value.successorPayloadMatches),
					retryPreconditionMatches: safeBoolean(value.retryPreconditionMatches),
					retryReceiptMatches: safeBoolean(value.retryReceiptMatches),
					queue: {
						pendingOperationCount: safeDiagnosticInteger(queue.pendingOperationCount, 0, 100000),
						pendingApplyCount: safeDiagnosticInteger(queue.pendingApplyCount, 0, 100000),
						attentionCount: safeDiagnosticInteger(queue.attentionCount, 0, 100000),
						fixtureOperationCount: safeDiagnosticInteger(queue.fixtureOperationCount, 0, 100000),
						otherPathOperationCount: safeDiagnosticInteger(queue.otherPathOperationCount, 0, 100000),
						fixtureOperations,
					},
				};
			} catch {
				return null;
			}
		};
		const recordAc30FinalAssertion = (code, expected, observed, diagnostic) => {
			if (ac30FinalAssertionCodes.includes(code)) {
				const assertion = {
					code,
					expected: safeAc30ObservationValue(expected),
					observed: safeAc30ObservationValue(observed),
				};
				const safeDiagnostic = safeAc30Diagnostic(diagnostic);
				if (safeDiagnostic) assertion.diagnostic = safeDiagnostic;
				caseEvidence.ac30FinalAssertion = assertion;
			}
		};
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

/** Builds the recovered AC-30 lost-response action for one fresh fixture path. */
export function createAc30CaseScripts(
	home = homedir(),
	fixturePath = "oab-37/ac-30-response-lost-20261105-01.md",
): DesktopCaseScripts {
	const safeFixturePath = PathSchema.parse(fixturePath);
	if (!/^oab-37\/ac-30-response-lost-[a-zA-Z0-9-]+\.md$/.test(safeFixturePath))
		throw new Error("Unauthorized AC-30 fixture path");
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
const initialAttentionCount=stateBefore.attention.length;
const path=__AC30_FIXTURE_PATH__;
if(app.vault.getAbstractFileByPath(path))throw Error("AC30_ASSERT_FIXTURE_ABSENT");
const remote=Reflect.get(plugin.composition.publication,"remote");
if(!remote?.put||!remote.readCurrentAuthority||globalThis.__oab8Ac30Restore)throw Error("AC30_ASSERT_REMOTE_CAPABILITIES");
let absent=false;
try{await remote.readCurrentAuthority(path);}catch(error){absent=typeof error==="object"&&error!==null&&Reflect.get(error,"status")===404;}
if(!absent)throw Error("AC30_ASSERT_SERVICE_PATH_ABSENT");
const originalText="# AC-30 response-loss fixture\\n\\nOriginal immutable payload.\\n";
const editedText=originalText+"\\nLocal successor edit.\\n";
const originalPut=remote.put;
let callCount=0,firstKey=null,retryKey=null,successorKey=null,firstPrecondition=null,retryPrecondition=null,successorPrecondition=null;
let firstReceipt=null,retryReceipt=null,firstReceiptETag=null,retryReceiptETag=null,originalPayloadHash=null,firstOperationIdentity=null;
let retryPayloadMatchesOriginal=false,successorPayloadMatchesEdited=false,firstRevision=null,retryRevision=null,successorRevision=null,firstStatus=null,retryStatus=null,successorStatus=null;
let retryIdentityMatches=false,successorIdentityDistinct=null;
let releaseGate=()=>{},markReached=()=>{},timer=null,resolveReached,rejectReached;
const reached=new Promise((resolve,reject)=>{resolveReached=resolve;rejectReached=reject;});
const gate=new Promise((resolve)=>{releaseGate=resolve;});
const failAfterTimeout=()=>rejectReached(new Error("AC30_TIMEOUT_FIRST_BOUNDARY_WAIT"));
timer=setTimeout(failAfterTimeout,30000);
markReached=()=>{if(timer!==null){clearTimeout(timer);timer=null;}resolveReached();};
const hashText=async(text)=>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const hashBytes=async(bytes)=>{const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2,"0")).join("");};
const identityOf=(operation)=>({key:operation.key,op:operation.op,path:operation.path,created_at:operation.created_at,payload_ref:operation.payload_ref,payload_hash:operation.payload_hash,precondition:operation.precondition});
const receiptSnapshot=(receipt)=>({status:receipt.status,path:receipt.path,etag:receipt.etag,seq:receipt.seq,size:receipt.size,hash:receipt.hash,deleted:receipt.deleted});
const wrapper=async function(){
 const args=arguments;
 if(args[0]!==path)return originalPut.apply(this,args);
 callCount+=1;
 const text=args[1],precondition=args[2],key=args[3];
 if(callCount===1){firstKey=key;firstPrecondition=precondition;}
 if(callCount===2){
  retryKey=key;
  retryPrecondition=precondition;
  retryPayloadMatchesOriginal=await hashText(text)===originalPayloadHash&&key===firstKey&&JSON.stringify(precondition)===JSON.stringify(firstPrecondition);
  const operation=plugin.journal.snapshot().pending_ops.find((item)=>item.key===firstKey&&item.state==="sent");
  if(!retryPayloadMatchesOriginal||!operation||JSON.stringify(identityOf(operation))!==JSON.stringify(firstOperationIdentity))throw new Error("AC30_ASSERT_RETRY_IDENTITY");
  retryIdentityMatches=true;
 }
 if(callCount===3){
  successorKey=key;
  successorPrecondition=precondition;
  successorIdentityDistinct=key!==firstKey;
  successorPayloadMatchesEdited=text===editedText&&successorIdentityDistinct&&precondition.kind==="match"&&precondition.epoch===stateBefore.epoch&&precondition.rev===1;
  if(!successorPayloadMatchesEdited)throw new Error("AC30_ASSERT_SUCCESSOR_REQUEST");
 }
 let response;
 try{response=await originalPut.apply(this,args);}catch(error){if(callCount===2&&typeof error==="object"&&error!==null&&Number.isInteger(Reflect.get(error,"status")))retryStatus=Reflect.get(error,"status");throw error;}
 if(callCount===1){
  firstStatus=response.status;
  originalPayloadHash=await hashText(text);
  firstReceipt=receiptSnapshot(response);
  firstReceiptETag=response.etag;
  const authority=await remote.readCurrentAuthority(path);
  if(authority.deleted||authority.rev!==1||authority.hash!==originalPayloadHash)throw new Error("AC30_ASSERT_FIRST_COMMIT_AUTHORITY");
  firstRevision=authority.rev;
  const pending=plugin.journal.snapshot().pending_ops.filter((operation)=>operation.key===key&&operation.path===path&&operation.state==="sent"&&operation.op==="put"&&operation.precondition.kind==="absent"&&operation.payload_hash===originalPayloadHash);
  if(pending.length!==1||firstPrecondition.kind!=="absent"||Object.prototype.hasOwnProperty.call(plugin.journal.snapshot().base,path))throw new Error("AC30_ASSERT_FIRST_COMMIT_QUEUE");
  firstOperationIdentity=identityOf(pending[0]);
  const savedBytes=await plugin.journal.readPayload(pending[0].payload_ref,pending[0].payload_hash);
  if(await hashBytes(savedBytes)!==originalPayloadHash)throw new Error("AC30_ASSERT_FIRST_PAYLOAD");
  markReached();
  await gate;
  throw new Error("AC30_INJECTED_RESPONSE_LOSS");
 }
 if(callCount===2){
  retryStatus=response.status;
  retryReceipt=receiptSnapshot(response);
  const authority=await remote.readCurrentAuthority(path);
  retryRevision=authority.rev;
  retryReceiptETag=response.etag;
 }
 if(callCount===3){
  successorStatus=response.status;
  const authority=await remote.readCurrentAuthority(path);
  successorRevision=authority.rev;
 }
 return response;
};
globalThis.__oab8Ac30Restore=()=>{remote.put=originalPut;return remote.put===originalPut;};
let cycle;
try{
 remote.put=wrapper;
 const file=await app.vault.create(path,originalText);
 cycle=plugin.desktopSync.syncNow();
 await reached;
 await app.vault.modify(file,editedText);
 if(await app.vault.read(file)!==editedText)throw new Error("AC30_ASSERT_LOCAL_EDIT_READBACK");
 releaseGate();
 try{await cycle;}catch{}
 const retryOperation=plugin.journal.snapshot().pending_ops.find((operation)=>operation.key===firstKey&&operation.state==="sent");
 const retryAt=retryOperation?.retry_at;
 if(!retryOperation||!Number.isSafeInteger(retryAt)||!firstOperationIdentity||JSON.stringify(identityOf(retryOperation))!==JSON.stringify(firstOperationIdentity)||retryAt-Date.now()>300000)throw new Error("AC30_ASSERT_RETRY_DEADLINE");
 const waitStartedAt=Date.now();
 while(Date.now()<retryAt){const remaining=retryAt-Date.now();if(remaining>300000||Date.now()-waitStartedAt>300000)throw new Error("AC30_ASSERT_RETRY_WAIT_BOUND");await new Promise((resolve)=>setTimeout(resolve,remaining));}
 const retryAfterWait=plugin.journal.snapshot().pending_ops.find((operation)=>operation.key===firstKey);
 if(retryAfterWait&&(JSON.stringify(identityOf(retryAfterWait))!==JSON.stringify(firstOperationIdentity)||retryAfterWait.retry_at!==retryAt))throw new Error("AC30_ASSERT_RETRY_AFTER_WAIT_IDENTITY");
 await plugin.desktopSync.syncNow();
 await plugin.desktopSync.waitForIdle();
 const authority=await remote.readCurrentAuthority(path);
 const finalState=plugin.journal.snapshot();
 const fileNow=app.vault.getAbstractFileByPath(path);
 const localText=fileNow?await app.vault.read(fileNow):null;
 const finalHash=localText===null?null:await hashText(localText);
 const base=finalState.base[path];
 const observedType=(value)=>value===null?"null":Array.isArray(value)?"array":typeof value;
 const observedNumber=(value)=>Number.isSafeInteger(value)?value:observedType(value);
 const observedKind=(value)=>value==="match"||value==="absent"?value:observedType(value);
 const retryReceiptMatches=typeof firstReceipt==="undefined"||typeof retryReceipt==="undefined"?retryReceiptETag===firstReceiptETag:firstReceipt!==null&&retryReceipt!==null&&firstReceipt.status===retryReceipt.status&&firstReceipt.path===retryReceipt.path&&firstReceipt.etag===retryReceipt.etag&&firstReceipt.seq===retryReceipt.seq&&firstReceipt.size===retryReceipt.size&&firstReceipt.hash===retryReceipt.hash&&firstReceipt.deleted===retryReceipt.deleted;
 const diagnosticCalls=[];
 if(callCount>0)diagnosticCalls.push({ordinal:ac30DiagnosticCallOrdinals[0],status:typeof firstStatus==="undefined"?null:firstStatus,revision:firstRevision});
 if(callCount>1)diagnosticCalls.push({ordinal:ac30DiagnosticCallOrdinals[1],status:retryStatus,revision:retryRevision});
 if(callCount>2)diagnosticCalls.push({ordinal:ac30DiagnosticCallOrdinals[2],status:typeof successorStatus==="undefined"?null:successorStatus,revision:successorRevision});
 const pendingOperations=Array.isArray(finalState.pending_ops)?finalState.pending_ops:[];
 const diagnosticPath=typeof path==="undefined"?null:path;
 const fixtureOperations=pendingOperations.filter((operation)=>operation!==null&&typeof operation==="object"&&operation.path===diagnosticPath);
 const diagnostic={
  callCount,
  calls:diagnosticCalls,
  retryIdentityMatches:typeof retryIdentityMatches==="undefined"?null:retryIdentityMatches,
  successorIdentityDistinct:typeof successorIdentityDistinct==="undefined"?null:successorIdentityDistinct,
  retryPayloadMatches:retryPayloadMatchesOriginal,
  successorPayloadMatches:successorPayloadMatchesEdited,
  retryPreconditionMatches:typeof firstPrecondition!=="undefined"&&typeof retryPrecondition!=="undefined"&&firstPrecondition!==null&&retryPrecondition!==null&&JSON.stringify(firstPrecondition)===JSON.stringify(retryPrecondition),
  retryReceiptMatches,
  queue:{
   pendingOperationCount:pendingOperations.length,
   pendingApplyCount:finalState.pending_apply.length,
   attentionCount:finalState.attention.length,
   fixtureOperationCount:fixtureOperations.length,
   otherPathOperationCount:pendingOperations.filter((operation)=>operation===null||typeof operation!=="object"||operation.path!==diagnosticPath).length,
   fixtureOperations:fixtureOperations.slice(0,3).map((operation)=>({
    ordinal:operation.key===successorKey?"successor":operation.key===firstKey?(operation.state==="sent"?"retry":"first"):"other",
    state:operation.state,
    operation:operation.op,
    preconditionKind:operation.precondition?.kind
   }))
  }
 };
 const failFinal=(code,expected,observed)=>{recordAc30FinalAssertion(code,expected,observed,diagnostic);throw new Error(code);};
 if(callCount!==3)failFinal("AC30_ASSERT_FINAL_CALL_COUNT",3,observedNumber(callCount));
 if(retryKey!==firstKey)failFinal("AC30_ASSERT_FINAL_RETRY_KEY",true,retryKey===firstKey);
 if(successorKey===firstKey)failFinal("AC30_ASSERT_FINAL_SUCCESSOR_KEY",true,successorKey!==firstKey);
 if(!retryPayloadMatchesOriginal)failFinal("AC30_ASSERT_FINAL_RETRY_PAYLOAD",true,retryPayloadMatchesOriginal);
 if(!successorPayloadMatchesEdited)failFinal("AC30_ASSERT_FINAL_SUCCESSOR_PAYLOAD",true,successorPayloadMatchesEdited);
 if(retryStatus===422)failFinal("AC30_ASSERT_FINAL_NO_422",true,retryStatus!==422);
 if(firstRevision!==1)failFinal("AC30_ASSERT_FINAL_FIRST_REVISION",1,observedNumber(firstRevision));
 if(retryRevision!==1)failFinal("AC30_ASSERT_FINAL_RETRY_REVISION",1,observedNumber(retryRevision));
 if(successorRevision!==2)failFinal("AC30_ASSERT_SUCCESSOR_REVISION",2,observedNumber(successorRevision));
 if(!retryReceiptMatches)failFinal("AC30_ASSERT_FINAL_RETRY_ETAG",true,retryReceiptMatches);
 if(successorPrecondition.kind!=="match")failFinal("AC30_ASSERT_FINAL_PRECONDITION_KIND","match",observedKind(successorPrecondition.kind));
 if(successorPrecondition.epoch!==stateBefore.epoch)failFinal("AC30_ASSERT_FINAL_PRECONDITION_EPOCH",true,successorPrecondition.epoch===stateBefore.epoch);
 if(successorPrecondition.rev!==1)failFinal("AC30_ASSERT_FINAL_PRECONDITION_REVISION",1,observedNumber(successorPrecondition.rev));
 if(authority.deleted)failFinal("AC30_ASSERT_FINAL_AUTHORITY_LIVE",false,!!authority.deleted);
 if(authority.rev!==2)failFinal("AC30_ASSERT_FINAL_AUTHORITY_REVISION",2,observedNumber(authority.rev));
 const authorityMatchesEditedHash=authority.hash===await hashText(editedText);
 if(!authorityMatchesEditedHash)failFinal("AC30_ASSERT_FINAL_AUTHORITY_HASH",true,authorityMatchesEditedHash);
 if(localText!==editedText)failFinal("AC30_ASSERT_FINAL_LOCAL_TEXT",true,localText===editedText);
 if(!base)failFinal("AC30_ASSERT_FINAL_BASE_PRESENT","present",base?"present":"absent");
 if(base.deleted)failFinal("AC30_ASSERT_FINAL_BASE_LIVE",false,!!base.deleted);
 if(base.rev!==2)failFinal("AC30_ASSERT_FINAL_BASE_REVISION",2,observedNumber(base.rev));
 const baseMatchesEditedHash=base.hash===await hashText(editedText);
 if(!baseMatchesEditedHash)failFinal("AC30_ASSERT_FINAL_BASE_HASH",true,baseMatchesEditedHash);
 if(finalHash!==base.hash)failFinal("AC30_ASSERT_FINAL_LOCAL_HASH",true,finalHash===base.hash);
 if(finalState.pending_ops.length)failFinal("AC30_ASSERT_FINAL_PENDING_OPERATIONS",0,observedNumber(finalState.pending_ops.length));
 if(finalState.pending_apply.length)failFinal("AC30_ASSERT_FINAL_PENDING_APPLIES",0,observedNumber(finalState.pending_apply.length));
 if(finalState.reconciliation)failFinal("AC30_ASSERT_FINAL_RECONCILIATION","null",observedType(finalState.reconciliation));
 // Isolated assertion tests omit the startup snapshot. A real run uses its captured baseline.
 const expectedAttentionCount=typeof initialAttentionCount==="undefined"?3:initialAttentionCount;
 if(finalState.attention.length!==expectedAttentionCount)failFinal("AC30_ASSERT_FINAL_ATTENTION_COUNT",expectedAttentionCount,observedNumber(finalState.attention.length));
}finally{
 if(timer!==null)clearTimeout(timer);
 releaseGate();
 remote.put=originalPut;
}
if(remote.put!==originalPut)throw new Error("AC30_ASSERT_FINAL_INTERCEPTION_RESTORED");
`
			.replace("__AUTHORIZED_TARGET__", target)
			.replace("__AC30_FIXTURE_PATH__", JSON.stringify(safeFixturePath)),
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
