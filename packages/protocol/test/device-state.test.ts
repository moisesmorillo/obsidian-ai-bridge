import { describe, expect, it } from "vitest";
import {
	DeviceStateSchema,
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
		expect(
			DeviceStateSchema.safeParse({
				version: 2,
				device_id: uuid,
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
