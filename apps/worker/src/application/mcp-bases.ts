import {
	type AuthorizationContext,
	classifyFilePath,
	type McpCreateBaseInput,
	type McpDeleteBaseInput,
	type McpListBasesResult,
	type McpReadBaseInput,
	type McpUpdateBaseInput,
	type McpValidateBaseInput,
	type McpValidateBaseResult,
	parseETag,
	validateBaseContent,
} from "@vaultwire/protocol";
import type { AdmissionByteReservation } from "@worker/application/admission-budget";
import type { BlobContentStore } from "@worker/application/blobs";
import {
	createMcpNote,
	deleteMcpNote,
	type McpMutationGateway,
	type McpMutationOutcome,
	updateMcpNote,
} from "@worker/application/mcp-mutations";
import {
	currentMcpEpoch,
	type McpNotesGateway,
	type McpReadOutcome,
	type McpReadOwner,
	readMcpNote,
	settleMcpRead,
} from "@worker/application/mcp-notes";
import { openManifestRead } from "@worker/application/reads";

/** Bound structured Base listing results to the shared MCP list budget. */
const MCP_BASE_LIST_RESULT_BYTES_LIMIT = 65_536;
/** Limit durable manifest traversal while retaining only bounded Base rows. */
const MCP_BASE_MANIFEST_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

/** Failure-free current mutation authority and epoch before Base content parsing. */
type BaseMutationPrecheck =
	| { ok: true; epoch: string }
	| { ok: false; outcome: McpMutationOutcome };

/** Verify one canonical vault path names a Base file by its final suffix. */
function isBasePath(path: string): boolean {
	return classifyFilePath(path) === "base";
}

/** List only Base metadata while transferring the durable read owner to the response. */
export async function listMcpBases(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	prefix?: string,
	includeLarge = false,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Pick<McpListBasesResult, "entries">>> {
	const opened = await openManifestRead(
		gateway,
		identity,
		undefined,
		signal,
		MCP_BASE_MANIFEST_SCAN_LIMIT,
	);
	if (!opened.ok) return { ok: false, failure: opened.failure };
	return settleMcpRead(opened.body, async () => {
		const entries: McpListBasesResult["entries"][number][] = [];
		let estimatedBytes = 128;
		for (;;) {
			const batch = await opened.body.readBatch();
			for (const row of batch.rows) {
				if (
					row.deleted ||
					!isBasePath(row.path) ||
					(!includeLarge && row.large) ||
					(prefix !== undefined && !row.path.startsWith(prefix))
				)
					continue;
				if (row.updated_at === undefined)
					return { ok: false, failure: { kind: "internal_error" } };
				const entry = {
					path: row.path,
					etag: row.etag,
					size: row.size,
					updated_at: row.updated_at,
					large: row.large,
				};
				const nextBytes =
					estimatedBytes +
					new TextEncoder().encode(JSON.stringify(entry)).byteLength +
					(entries.length > 0 ? 1 : 0);
				if (
					entries.length >= 256 ||
					nextBytes > MCP_BASE_LIST_RESULT_BYTES_LIMIT
				)
					return { ok: false, failure: { kind: "result_too_large" } };
				entries.push(entry);
				estimatedBytes = nextBytes;
			}
			if (batch.next_page !== null)
				return { ok: false, failure: { kind: "result_too_large" } };
			if (batch.done)
				return { ok: true, epoch: opened.body.body.epoch, value: { entries } };
		}
	});
}

/** Read one Base path through the existing revision-pinned text and blob operation. */
export function readMcpBase(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	input: McpReadBaseInput,
	store: BlobContentStore,
	signal?: AbortSignal,
) {
	if (!isBasePath(input.path))
		return Promise.resolve({
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		});
	return readMcpNote(gateway, identity, input, store, signal);
}

/** Create a Base only when its path is absent in the supplied vault epoch. */
export async function createMcpBase(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpCreateBaseInput,
	responseProduction: Promise<void>,
	byteReservation?: AdmissionByteReservation,
): Promise<McpMutationOutcome> {
	const precheck = await authorizeBaseMutation(
		gateway,
		identity,
		"vault:write",
		"put",
		input.epoch,
	);
	if (!precheck.ok) return precheck.outcome;
	if (!isBasePath(input.path) || !validateBaseContent(input.content).valid)
		return {
			ok: false,
			failure: { kind: "invalid_request" },
			epoch: precheck.epoch,
			owner: noSourceOwner(),
		};
	return createMcpNote(
		gateway,
		identity,
		input,
		responseProduction,
		byteReservation,
	);
}

/** Replace a Base only at the exact ETag supplied by the caller. */
export async function updateMcpBase(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpUpdateBaseInput,
	responseProduction: Promise<void>,
	byteReservation?: AdmissionByteReservation,
): Promise<McpMutationOutcome> {
	const precheck = await authorizeBaseMutation(
		gateway,
		identity,
		"vault:write",
		"put",
		parseETag(input.etag).epoch,
	);
	if (!precheck.ok) return precheck.outcome;
	if (!isBasePath(input.path) || !validateBaseContent(input.content).valid)
		return {
			ok: false,
			failure: { kind: "invalid_request" },
			epoch: precheck.epoch,
			owner: noSourceOwner(),
		};
	return updateMcpNote(
		gateway,
		identity,
		input,
		responseProduction,
		byteReservation,
	);
}

/** Tombstone a Base only at the exact ETag supplied by the caller. */
export async function deleteMcpBase(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpDeleteBaseInput,
	responseProduction: Promise<void>,
): Promise<McpMutationOutcome> {
	const precheck = await authorizeBaseMutation(
		gateway,
		identity,
		"vault:delete",
		"delete",
		parseETag(input.etag).epoch,
	);
	if (!precheck.ok) return precheck.outcome;
	if (!isBasePath(input.path))
		return {
			ok: false,
			failure: { kind: "invalid_request" },
			epoch: precheck.epoch,
			owner: noSourceOwner(),
		};
	return deleteMcpNote(gateway, identity, input, responseProduction);
}

/** Check Base mutation scope and current vault epoch before parsing client text. */
async function authorizeBaseMutation(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	scope: "vault:write" | "vault:delete",
	operation: "put" | "delete",
	expectedEpoch: string,
): Promise<BaseMutationPrecheck> {
	const owner = noSourceOwner();
	if (!identity.scopes.includes(scope))
		return {
			ok: false,
			outcome: { ok: false, failure: { kind: "forbidden_scope" }, owner },
		};
	const current = await gateway.getCurrentEpoch(identity, operation);
	if (!current.ok)
		return {
			ok: false,
			outcome: { ok: false, failure: current.failure, owner },
		};
	if (current.current_epoch !== expectedEpoch)
		return {
			ok: false,
			outcome: {
				ok: false,
				failure: {
					kind: "epoch_mismatch",
					current_epoch: current.current_epoch,
				},
				epoch: current.current_epoch,
				owner,
			},
		};
	return { ok: true, epoch: current.current_epoch };
}

/** Validate current-epoch Base syntax without storage access or parsed-content output. */
export async function validateMcpBase(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	input: McpValidateBaseInput,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Omit<McpValidateBaseResult, "epoch">>> {
	const owner = noSourceOwner();
	if (!identity.scopes.includes("vault:read"))
		return { ok: false, failure: { kind: "forbidden_scope" }, owner };
	const current = await currentMcpEpoch(gateway, identity);
	if (!current.ok) return { ok: false, failure: current.failure, owner };
	if (signal?.aborted)
		return { ok: false, failure: { kind: "invalid_request" }, owner };
	const result = validateBaseContent(input.content);
	if (signal?.aborted)
		return { ok: false, failure: { kind: "invalid_request" }, owner };
	return {
		ok: true,
		epoch: current.epoch,
		value: result,
		owner,
	};
}

/** Hold only the HTTP response lease for validation, which creates no storage owner. */
function noSourceOwner(): McpReadOwner {
	let finished: Promise<{ ok: true }> | undefined;
	return {
		completion: "settled",
		/** No storage work exists to cancel for validation. */
		async cancel() {},
		/** Return one idempotent settlement result for the HTTP response owner. */
		finish() {
			finished ??= Promise.resolve({ ok: true });
			return finished;
		},
	};
}
