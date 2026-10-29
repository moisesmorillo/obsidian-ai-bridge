import { describe, expect, it } from "vitest";
import {
	DeviceStateSchema,
	PendingApplySchema,
	PendingOperationSchema,
} from "../src/schemas/device-state";

const uuid = "018f47b2-5c00-7000-8000-000000000001";
const common = {
	key: uuid,
	payload_hash: "a".repeat(64),
	payload_ref: `.ai-bridge/pending/${uuid}`,
	created_at: 1,
	attempts: 0,
	state: "queued" as const,
};

describe("device journal protocol schemas", () => {
	it("reads old journal documents with defaults for remote apply state", () => {
		const oldState = { version: 1, device_id: uuid, pending_ops: [] };
		const parsed = DeviceStateSchema.parse(oldState);
		expect(parsed).toMatchObject({
			pending_apply: [],
			base: {},
			expected_writes: {},
			attention: [],
		});
		expect(DeviceStateSchema.safeParse(oldState).success).toBe(true);
		expect(
			DeviceStateSchema.safeParse({
				...oldState,
				client_id: "registered-client",
			}).success,
		).toBe(true);
		expect(
			DeviceStateSchema.safeParse({ ...oldState, client_id: "" }).success,
		).toBe(false);
	});

	it.each([
		{
			...common,
			op: "put",
			path: "notes/a.md",
			precondition: { kind: "match", epoch: "b".repeat(32), rev: 2 },
		},
		{
			...common,
			op: "delete",
			path: "notes/a.md",
			precondition: { kind: "match", epoch: "b".repeat(32), rev: 2 },
		},
		{
			...common,
			op: "rename",
			path: "notes/a.md",
			to: "notes/b.md",
			precondition: { kind: "match", epoch: "b".repeat(32), rev: 2 },
		},
	])("accepts a valid $op operation", (operation) => {
		expect(PendingOperationSchema.safeParse(operation).success).toBe(true);
	});

	it("rejects incomplete or invalid durable apply steps", () => {
		const change = {
			seq: 1,
			op: "put",
			path: "notes/a.md",
			etag: `"${"b".repeat(32)}.2"`,
			hash: "c".repeat(64),
			origin: "remote",
			at: 1,
		};
		const state = { version: 1, device_id: uuid, pending_ops: [] };
		expect(
			DeviceStateSchema.safeParse({
				...state,
				pending_apply: [{ change, step: "copied" }],
			}).success,
		).toBe(false);
		expect(
			DeviceStateSchema.safeParse({
				...state,
				pending_apply: [{ change, step: "unknown" }],
			}).success,
		).toBe(false);
	});

	it("accepts and rejects only recoverable persisted apply state combinations", () => {
		const put = {
			seq: 1,
			op: "put" as const,
			path: "notes/a.md",
			etag: `"${"b".repeat(32)}.2"`,
			hash: "c".repeat(64),
			origin: "remote",
			at: 1,
		};
		const deletion = { ...put, seq: 2, op: "delete" as const, hash: "" };
		const rename = {
			...put,
			seq: 3,
			op: "rename" as const,
			path: "notes/b.md",
			from_path: "notes/a.md",
			from_etag: `"${"b".repeat(32)}.1"`,
		};
		const localCopy = {
			conflict_path: "notes/a (conflict Device 2026-10-29 0000 r2).md",
			conflict_source: "notes/a.md",
			conflict_mode: "local" as const,
			conflict_device_name: "Moises Mac",
			conflict_hash: "d".repeat(64),
		};
		const accepted = [
			{ change: put, step: "prepared" },
			{ change: put, step: "named", ...localCopy },
			{ change: deletion, step: "copied", ...localCopy },
			{ change: rename, step: "named", ...localCopy },
			{
				change: put,
				step: "copied",
				...localCopy,
				conflict_mode: "remote" as const,
			},
		];
		for (const pending of accepted)
			expect(PendingApplySchema.safeParse(pending).success).toBe(true);
		const { conflict_device_name: _legacyName, ...legacyCopy } = localCopy;
		expect(
			PendingApplySchema.safeParse({
				change: put,
				step: "named",
				...legacyCopy,
			}).success,
		).toBe(true);
		expect(
			PendingApplySchema.safeParse({
				change: put,
				step: "copied",
				...legacyCopy,
			}).success,
		).toBe(true);
		for (const pending of [
			{
				change: deletion,
				step: "named",
				...localCopy,
				conflict_mode: "remote",
			},
			{ change: rename, step: "copied", ...localCopy, conflict_mode: "remote" },
			{ change: put, step: "effect_confirmed" },
			{ change: put, step: "prepared", ...localCopy },
			{ change: put, step: "prepared", conflict_device_name: "Moises Mac" },
		])
			expect(PendingApplySchema.safeParse(pending).success).toBe(false);
	});

	it("rejects epochs and revisions outside the canonical safe range", () => {
		const operation = {
			...common,
			op: "put",
			path: "notes/a.md",
			precondition: { kind: "match", epoch: "0".repeat(32), rev: 1 },
		};
		expect(PendingOperationSchema.safeParse(operation).success).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...operation,
				precondition: {
					kind: "match",
					epoch: "b".repeat(32),
					rev: Number.MAX_SAFE_INTEGER + 1,
				},
			}).success,
		).toBe(false);
	});

	it("requires exact epoch-bearing preconditions and operation fields", () => {
		expect(
			PendingOperationSchema.safeParse({
				...common,
				op: "put",
				path: "a.md",
				precondition: { kind: "match", rev: 1 },
			}).success,
		).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...common,
				op: "put",
				path: "a.md",
				to: "b.md",
				precondition: { kind: "create" },
			}).success,
		).toBe(false);
	});

	it("rejects a rename whose source and destination are the same path", () => {
		expect(
			PendingOperationSchema.safeParse({
				...common,
				op: "rename",
				path: "notes/a.md",
				to: "notes/a.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
	});

	it("rejects unsafe payload refs, invalid keys, hashes, duplicate keys, and unsupported versions", () => {
		expect(
			PendingOperationSchema.safeParse({
				...common,
				key: "bad",
				op: "put",
				path: "a.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...common,
				payload_ref: "../../outside",
				op: "put",
				path: "a.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...common,
				payload_hash: "bad",
				op: "put",
				path: "a.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...common,
				payload_ref: `.ai-bridge/pending/018f47b2-5c00-7000-8000-000000000002`,
				op: "put",
				path: "a.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
		expect(
			PendingOperationSchema.safeParse({
				...common,
				op: "put",
				path: "notes/e\u0301.md",
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
		const operation = {
			...common,
			op: "put",
			path: "a.md",
			precondition: { kind: "absent" },
		};
		const singleOperationState = {
			version: 1,
			device_id: uuid,
			pending_ops: [operation],
		};
		expect(DeviceStateSchema.safeParse(singleOperationState).success).toBe(
			true,
		);
		expect(
			DeviceStateSchema.safeParse({
				...singleOperationState,
				pending_ops: [operation, operation],
			}).success,
		).toBe(false);
		expect(
			DeviceStateSchema.safeParse({
				version: 99,
				device_id: uuid,
				pending_ops: [],
			}).success,
		).toBe(false);
	});
});
