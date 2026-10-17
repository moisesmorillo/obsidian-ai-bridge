import type {
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
} from "@obsidian-ai-bridge/protocol";
import {
	AdmissionDenied,
	assertAdmissionAllowed,
	prepareDescriptor,
	prepareOperation,
	requiredScope,
} from "@worker/application/admission";
import { describe, expect, it } from "vitest";

const epoch = "0000000000000000000000000000000a";
const hash = "0".repeat(64);
const context: AuthorizationContext = {
	client_id: "client",
	grant_id: "grant",
	scopes: ["vault:write"],
};
const put: OperationIntent = {
	op: "put",
	epoch,
	paths: ["note.md"],
	precondition: { kind: "absent" },
	payload_hash: "0".repeat(64),
	size: 0,
};
const descriptor: OperationDescriptor = {
	op: "read",
	paths: ["note.md"],
	precondition: { kind: "none" },
};

describe("admission rules", () => {
	it.each([
		["read", "vault:read"],
		["put", "vault:write"],
		["delete", "vault:delete"],
		["rename", "vault:write"],
		["append", "vault:write"],
		["restore", "vault:write"],
	] as const)("maps %s to its minimum scope", (op, scope) => {
		expect(requiredScope(op)).toBe(scope);
	});
	it("denies read when context has only vault:write", async () => {
		const prepared = await prepareDescriptor(context, descriptor);
		expect(() => assertAdmissionAllowed(context, prepared, epoch)).toThrow(
			AdmissionDenied,
		);
	});
	it("denies delete when context has only vault:write", async () => {
		const del: OperationDescriptor = {
			op: "delete",
			paths: ["note.md"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
		};
		const prepared = await prepareDescriptor(context, del);
		expect(() => assertAdmissionAllowed(context, prepared, epoch)).toThrow(
			AdmissionDenied,
		);
	});
	it("denies read and delete when the exact scope is absent", async () => {
		await expect(
			prepareDescriptor(context, descriptor).then((prepared) =>
				assertAdmissionAllowed(context, prepared, epoch),
			),
		).rejects.toMatchObject({ failure: { kind: "forbidden_scope" } });
		const del: OperationDescriptor = {
			op: "delete",
			paths: ["note.md"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
		};
		await expect(
			prepareDescriptor(context, del).then((prepared) =>
				assertAdmissionAllowed(context, prepared, epoch),
			),
		).rejects.toBeInstanceOf(AdmissionDenied);
	});
	it("allows read and delete only with their exact scopes", async () => {
		const readContext: AuthorizationContext = {
			...context,
			scopes: ["vault:read"],
		};
		assertAdmissionAllowed(
			readContext,
			await prepareDescriptor(readContext, descriptor),
			epoch,
		);
		const delContext: AuthorizationContext = {
			...context,
			scopes: ["vault:delete"],
		};
		const del: OperationDescriptor = {
			op: "delete",
			paths: ["note.md"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
		};
		assertAdmissionAllowed(
			delContext,
			await prepareDescriptor(delContext, del),
			epoch,
		);
	});
	it("rejects a stale explicit epoch", async () => {
		await expect(
			prepareOperation(context, put).then((p) =>
				assertAdmissionAllowed(context, p, "0000000000000000000000000000000b"),
			),
		).rejects.toMatchObject({ failure: { kind: "epoch_mismatch" } });
	});
	it("rejects a stale epoch derived from the ETag", async () => {
		const match: OperationDescriptor = {
			op: "restore",
			paths: ["note.md"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
		};
		await expect(
			prepareDescriptor(context, match).then((p) =>
				assertAdmissionAllowed(context, p, "0000000000000000000000000000000b"),
			),
		).rejects.toMatchObject({ failure: { kind: "epoch_mismatch" } });
	});
	it("allows bootstrap reads without a known epoch", async () => {
		const readContext: AuthorizationContext = {
			...context,
			scopes: ["vault:read"],
		};
		assertAdmissionAllowed(
			readContext,
			await prepareDescriptor(readContext, {
				op: "read",
				paths: [],
				precondition: { kind: "none" },
			}),
			"0000000000000000000000000000000b",
		);
	});
	const fingerprintFor = async (
		intent: OperationIntent,
		auth: AuthorizationContext = context,
	) => (await prepareOperation(auth, intent)).fingerprint;
	const descriptorFingerprintFor = async (
		value: OperationDescriptor,
		auth: AuthorizationContext = context,
	) => (await prepareDescriptor(auth, value)).descriptorFingerprint;
	it("keeps the operation descriptor fingerprint on the known six-item vector", async () => {
		expect((await prepareOperation(context, put)).descriptorFingerprint).toBe(
			"41cbf62d63139540b580923a57d742452abe8d15aca9952dbec32d7fbfc284b6",
		);
	});
	it("uses the same descriptor fingerprint for both preparation entry points", async () => {
		const putDescriptor: OperationDescriptor = {
			op: "put",
			epoch,
			paths: ["note.md"],
			precondition: { kind: "absent" },
		};
		expect((await prepareOperation(context, put)).descriptorFingerprint).toBe(
			await descriptorFingerprintFor(putDescriptor),
		);
	});
	it("hashes the versioned descriptor tuple to its known digest", async () => {
		expect(
			await descriptorFingerprintFor({
				op: "put",
				epoch,
				paths: ["note.md"],
				precondition: { kind: "absent" },
			}),
		).toBe("41cbf62d63139540b580923a57d742452abe8d15aca9952dbec32d7fbfc284b6");
	});
	it("binds client identity in the descriptor fingerprint", async () => {
		expect(await descriptorFingerprintFor(descriptor)).not.toBe(
			await descriptorFingerprintFor(descriptor, {
				...context,
				client_id: "other",
			}),
		);
	});
	it("binds path metadata in the descriptor fingerprint", async () => {
		expect(await descriptorFingerprintFor(descriptor)).not.toBe(
			await descriptorFingerprintFor({ ...descriptor, paths: ["other.md"] }),
		);
	});
	it("normalizes descriptor paths to the same fingerprint", async () => {
		const decomposed = await descriptorFingerprintFor({
			...descriptor,
			paths: ["cafe\u0301.md"],
		});
		expect(decomposed).toMatch(/^[0-9a-f]{64}$/);
		expect(decomposed).toBe(
			await descriptorFingerprintFor({ ...descriptor, paths: ["café.md"] }),
		);
	});
	it("returns a lowercase SHA-256 operation fingerprint", async () => {
		expect(await fingerprintFor(put)).toMatch(/^[0-9a-f]{64}$/);
	});
	it("binds the client identifier in the operation fingerprint", async () => {
		expect(await fingerprintFor({ ...put })).not.toBe(
			await fingerprintFor(put, { ...context, client_id: "other" }),
		);
	});
	it("binds the epoch in the operation fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({
				...put,
				epoch: "0000000000000000000000000000000b",
			}),
		);
	});
	it("binds the operation in the fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({
				...put,
				op: "append",
				precondition: { kind: "none" },
			}),
		);
	});
	it("binds the path in the fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({ ...put, paths: ["other.md"] }),
		);
	});
	it("binds the condition in the fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({
				...put,
				precondition: { kind: "match", etag: `"${epoch}.1"` },
			}),
		);
	});
	it("binds the payload hash in the fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({ ...put, payload_hash: "1".repeat(64) }),
		);
	});
	it("binds the declared size in the fingerprint", async () => {
		expect(await fingerprintFor(put)).not.toBe(
			await fingerprintFor({ ...put, size: 1 }),
		);
	});
	it("binds the rename destination in the fingerprint", async () => {
		const rename: OperationIntent = {
			op: "rename",
			paths: ["note.md", "destination.md"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
			payload_hash: hash,
			size: 0,
		};
		expect(await fingerprintFor(rename)).not.toBe(
			await fingerprintFor({ ...rename, paths: ["note.md", "other.md"] }),
		);
	});
	it("keeps delimiter-containing rename paths unambiguous", async () => {
		const rename: OperationIntent = {
			op: "rename",
			paths: ["x", "y|z"],
			precondition: { kind: "match", etag: `"${epoch}.1"` },
			payload_hash: hash,
			size: 0,
		};
		expect(await fingerprintFor(rename)).not.toBe(
			await fingerprintFor({ ...rename, paths: ["x|y", "z"] }),
		);
	});
	it("returns NFC-normalized operation paths", async () => {
		const prepared = await prepareOperation(context, {
			...put,
			paths: ["cafe\u0301.md"],
		});
		expect(prepared.intent.paths).toEqual(["café.md"]);
	});
	it("returns NFC-normalized descriptor paths", async () => {
		const prepared = await prepareDescriptor(context, {
			...descriptor,
			paths: ["cafe\u0301.md"],
		});
		expect(prepared.descriptor.paths).toEqual(["café.md"]);
	});
	it("freezes operation preconditions", async () => {
		const prepared = await prepareOperation(context, put);
		expect(Object.isFrozen(prepared.intent.precondition)).toBe(true);
	});
	it("freezes descriptor preconditions", async () => {
		const prepared = await prepareDescriptor(context, descriptor);
		expect(Object.isFrozen(prepared.descriptor.precondition)).toBe(true);
	});
	it("freezes operation paths and preconditions", async () => {
		const prepared = await prepareOperation(context, put);
		expect(Object.isFrozen(prepared.intent.paths)).toBe(true);
		expect(Object.isFrozen(prepared.intent.precondition)).toBe(true);
	});
	it("freezes descriptor paths and preconditions", async () => {
		const prepared = await prepareDescriptor(context, descriptor);
		expect(Object.isFrozen(prepared.descriptor.paths)).toBe(true);
		expect(Object.isFrozen(prepared.descriptor.precondition)).toBe(true);
	});
	it("hashes the versioned operation tuple to its known digest", async () => {
		expect(await fingerprintFor(put)).toBe(
			"41226092fa00c44a1f1f15aef0c2b1c6a37bc68df57860ed7fd03dd3ac2048f8",
		);
	});
	it("normalizes NFC paths to the same fingerprint", async () => {
		const decomposed: OperationIntent = { ...put, paths: ["cafe\u0301.md"] };
		const composed: OperationIntent = { ...put, paths: ["café.md"] };
		expect(await fingerprintFor(decomposed)).toMatch(/^[0-9a-f]{64}$/);
		expect(await fingerprintFor(decomposed)).toBe(
			await fingerprintFor(composed),
		);
	});
	it("copies caller fields before asynchronous hashing", async () => {
		const mutable = { ...put, paths: ["before.md"] } as OperationIntent & {
			paths: string[];
		};
		const pending = prepareOperation(context, mutable);
		queueMicrotask(() => {
			mutable.paths[0] = "after.md";
		});
		const prepared = await pending;
		expect(prepared.intent.paths[0]).toBe("before.md");
		expect(Object.isFrozen(prepared.intent.paths)).toBe(true);
	});
	it("maps oversized descriptor envelopes to invalid_request", async () => {
		const largeContext: AuthorizationContext = {
			...context,
			client_id: "\u0000".repeat(2048),
			grant_id: "\u0000".repeat(2048),
		};
		await expect(
			prepareDescriptor(largeContext, descriptor),
		).rejects.toMatchObject({ failure: { kind: "invalid_request" } });
	});
	it("maps oversized operation envelopes to invalid_request", async () => {
		const largeContext: AuthorizationContext = {
			...context,
			client_id: "\u0000".repeat(2048),
			grant_id: "\u0000".repeat(2048),
		};
		await expect(prepareOperation(largeContext, put)).rejects.toMatchObject({
			failure: { kind: "invalid_request" },
		});
	});
	it("rejects oversized preparation envelopes", async () => {
		const largeContext: AuthorizationContext = {
			...context,
			client_id: "\u0000".repeat(2048),
			grant_id: "\u0000".repeat(2048),
		};
		await expect(
			prepareDescriptor(largeContext, descriptor),
		).rejects.toMatchObject({ failure: { kind: "invalid_request" } });
		await expect(prepareOperation(largeContext, put)).rejects.toMatchObject({
			failure: { kind: "invalid_request" },
		});
	});
});
