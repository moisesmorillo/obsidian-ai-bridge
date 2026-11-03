import type {
	DeviceState,
	VaultReadResult,
} from "@obsidian-ai-bridge/protocol";
import type { DeviceJournalFailureStage } from "@plugin/sync/device-journal";

/** Confirmed feed boundary; null means no validated observation exists. */
export interface RemoteHeadObservation {
	epoch: string;
	head_seq: number;
}

/** Inputs that distinguish durable authority from lifecycle and presentation state. */
export interface SyncStatusInput {
	/** Validated journal snapshot that carries local revision and operation authority. */
	state: DeviceState;
	/** Current authorization state, separate from synchronization health. */
	session: "disconnected" | "connecting" | "connected" | "reconnect";
	/** Last successfully validated remote feed head, or null when none exists. */
	head: RemoteHeadObservation | null;
	/** True only when local journal state passes its persistence and payload checks. */
	persisted: boolean;
	/** Fixed non-secret stage for the current blocking journal failure, if any. */
	storageFailureStage?: DeviceJournalFailureStage | null;
	/** True while a serialized cycle or event owns synchronization work. */
	active: boolean;
	/** Safe recent cycle failure; it blocks settled until a later successful cycle. */
	failure?: string | null;
	/** True when the user paused effects while queued local intent remains durable. */
	paused: boolean;
	/** True only after a validated revocation response fenced the current session. */
	revoked: boolean;
}

/** Plain-language vault state and safe path-specific attention for the status view. */
export interface SyncStatusProjection {
	/** Projected user state after applying authorization, persistence, and work precedence. */
	state:
		| "disconnected"
		| "syncing"
		| "settled"
		| "pending"
		| "attention"
		| "revoked"
		| "paused"
		| "backup failed";
	/** Durable per-path reasons that require a user-visible action. */
	attention: Array<{ path: string; reason: string; action: "open" }>;
	/** Paths with unresolved persisted operations, unique in journal order. */
	pendingPaths: string[];
	/** Always unknown because the service contract has no backup-export telemetry. */
	backup: "unknown";
	/** Latest validated server database usage and limit, in bytes, or unknown. */
	capacity: "unknown" | { used: number; limit: number };
	/** True when journal persistence or payload integrity cannot be verified. */
	storageFailure: boolean;
	/** Fixed non-secret journal failure stage, or null when no stage is recorded. */
	storageFailureStage: DeviceJournalFailureStage | null;
	/** Safe latest synchronization failure; it cannot establish settled state. */
	failure: string | null;
	/** Live-file and tombstone counts from the latest validated server summary. */
	counts: { live: number; deleted: number } | null;
	/** Capacity warning codes from the latest validated server summary. */
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
	else if (input.failure) status = "pending";
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
		storageFailureStage: input.storageFailureStage ?? null,
		failure: input.failure ?? null,
		counts: remoteSummary ? remoteSummary.counts : null,
		capacityWarnings: remoteSummary ? [...remoteSummary.attention] : [],
	};
}
