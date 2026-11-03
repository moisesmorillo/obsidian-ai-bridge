import type {
	DeviceState,
	VaultReadResult,
} from "@obsidian-ai-bridge/protocol";

/** Confirmed feed boundary; null means no validated observation exists. */
export interface RemoteHeadObservation {
	epoch: string;
	head_seq: number;
}

/** Inputs that distinguish durable authority from lifecycle and presentation state. */
export interface SyncStatusInput {
	state: DeviceState;
	session: "disconnected" | "connecting" | "connected" | "reconnect";
	head: RemoteHeadObservation | null;
	persisted: boolean;
	active: boolean;
	failure?: string | null;
	paused: boolean;
	revoked: boolean;
}

/** Plain-language vault state and safe path-specific attention for the status view. */
export interface SyncStatusProjection {
	state:
		| "disconnected"
		| "syncing"
		| "settled"
		| "pending"
		| "attention"
		| "revoked"
		| "paused"
		| "backup failed";
	attention: Array<{ path: string; reason: string; action: "open" }>;
	pendingPaths: string[];
	backup: "unknown";
	capacity: "unknown" | { used: number; limit: number };
	storageFailure: boolean;
	failure: string | null;
	counts: { live: number; deleted: number } | null;
	capacityWarnings: string[];
}

/** Projects state from verified journal data and a validated feed observation only. */
export function projectSyncStatus(
	input: SyncStatusInput,
	remoteSummary: VaultReadResult | null = null,
): SyncStatusProjection {
	const { state } = input;
	let status: SyncStatusProjection["state"];
	if (input.revoked) status = "revoked";
	else if (input.paused) status = "paused";
	else if (input.session !== "connected") status = "disconnected";
	else if (!input.persisted || state.attention.length > 0) status = "attention";
	else if (input.active) status = "syncing";
	else if (
		state.pending_ops.length === 0 &&
		state.pending_apply.length === 0 &&
		state.reconciliation === null &&
		input.head !== null &&
		input.head.epoch === state.epoch &&
		state.cursor === input.head.head_seq
	)
		status = "settled";
	else if (
		state.pending_ops.length > 0 ||
		state.pending_apply.length > 0 ||
		input.head !== null
	)
		status = "pending";
	else status = "pending";
	return {
		state: status,
		attention: state.attention.map((item) => ({
			path: item.path,
			reason: item.reason,
			action: "open",
		})),
		pendingPaths: [
			...new Set(state.pending_ops.map((operation) => operation.path)),
		],
		backup: "unknown",
		capacity: remoteSummary
			? {
					used: remoteSummary.capacity.database_bytes,
					limit: remoteSummary.capacity.database_limit_bytes,
				}
			: "unknown",
		storageFailure: !input.persisted,
		failure: input.failure ?? null,
		counts: remoteSummary ? remoteSummary.counts : null,
		capacityWarnings: remoteSummary ? [...remoteSummary.attention] : [],
	};
}
