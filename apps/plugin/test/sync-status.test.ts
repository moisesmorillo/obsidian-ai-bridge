import type { DeviceState } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import { projectSyncStatus } from "../src/sync/sync-status";

const state: DeviceState = {
	version: 1,
	device_id: "018f0000-0000-7000-8000-000000000001",
	cursor: 4,
	epoch: "epoch",
	pending_ops: [],
	base: {},
	stale_base_paths: [],
	pending_apply: [],
	expected_writes: {},
	reconciliation: null,
	attention: [],
};

describe("projectSyncStatus", () => {
	it("does not report settled until a successful poll confirms the saved cursor", () => {
		const input = {
			state,
			session: "connected" as const,
			head: null,
			persisted: true,
			active: false,
			paused: false,
			revoked: false,
		};
		expect(projectSyncStatus(input).state).not.toBe("settled");
		expect(projectSyncStatus(input).deleteResponseDiagnostic).toBeNull();
		expect(
			projectSyncStatus({ ...input, head: { epoch: "epoch", head_seq: 4 } })
				.state,
		).toBe("settled");
		expect(
			projectSyncStatus({ ...input, head: { epoch: "epoch", head_seq: 5 } })
				.state,
		).toBe("pending");
	});

	it("does not call a previously confirmed head settled after a failed poll", () => {
		const input = {
			state,
			session: "connected" as const,
			head: { epoch: "epoch", head_seq: 4 },
			persisted: true,
			active: false,
			failure: "The latest poll failed",
			paused: false,
			revoked: false,
		};

		expect(projectSyncStatus(input).state).not.toBe("settled");
		expect(projectSyncStatus(input).failure).toBe("The latest poll failed");
	});

	it("projects safe DELETE response classes without raw response values", () => {
		const diagnostic = {
			statusClass: "4xx" as const,
			errorKind: "invalid_request" as const,
			responseETagClass: "strong" as const,
		};
		const projected = projectSyncStatus({
			state,
			session: "connected",
			head: null,
			persisted: true,
			deleteResponseDiagnostic: diagnostic,
			active: false,
			paused: true,
			revoked: false,
		});

		expect(projected.state).toBe("paused");
		expect(projected.deleteResponseDiagnostic).toEqual(diagnostic);
	});

	it("projects a fixed journal failure stage without changing attention", () => {
		const projected = projectSyncStatus({
			state,
			session: "connected",
			head: null,
			persisted: false,
			storageFailureStage: "payload_read",
			active: false,
			paused: false,
			revoked: false,
		});

		expect(projected.state).toBe("attention");
		expect(projected.storageFailureStage).toBe("payload_read");
	});

	it("prioritizes safe attention and persistence failure states", () => {
		const input = {
			state,
			session: "connected" as const,
			head: { epoch: "epoch", head_seq: 4 },
			persisted: false,
			active: false,
			paused: false,
			revoked: false,
		};
		expect(projectSyncStatus(input).state).toBe("attention");
		expect(
			projectSyncStatus({ ...input, persisted: true, revoked: true }).state,
		).toBe("revoked");
	});
});
