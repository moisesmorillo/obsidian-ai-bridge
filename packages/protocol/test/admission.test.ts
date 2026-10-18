import {
	AdmissionCompletionSchema,
	AdmissionFailureSchema,
	AdmissionFinishResultSchema,
	AdmissionResultSchema,
	AuthorizationContextSchema,
	DescriptorPreparationSchema,
	OperationDescriptorSchema,
	OperationIntentSchema,
	OperationPreparationSchema,
	OperationTicketSchema,
	RequestAdmissionLeaseSchema,
	RequestAdmissionResultSchema,
} from "@protocol/schemas/admission";
import { describe, expect, it } from "vitest";

const epoch = "0000000000000000000000000000000a";
const hash = "0".repeat(64);
const emptyHash =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ctx = {
	client_id: "client",
	grant_id: "grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
} as const;
const cases = [
	{ op: "read", paths: [], precondition: { kind: "none" } },
	{ op: "put", epoch, paths: ["a.md"], precondition: { kind: "absent" } },
	{
		op: "delete",
		paths: ["a.md"],
		precondition: { kind: "match", etag: `"${epoch}.1"` },
	},
	{
		op: "rename",
		paths: ["a.md", "b.md"],
		precondition: { kind: "match", etag: `"${epoch}.1"` },
	},
	{ op: "append", epoch, paths: ["a.md"], precondition: { kind: "none" } },
	{
		op: "restore",
		paths: ["a.md"],
		precondition: { kind: "match", etag: `"${epoch}.1"` },
	},
] as const;

describe("admission contracts", () => {
	it.each(cases)("accepts valid $op descriptor and intent", (descriptor) => {
		expect(OperationDescriptorSchema.safeParse(descriptor).success).toBe(true);
		expect(
			OperationIntentSchema.safeParse({
				...descriptor,
				payload_hash:
					descriptor.op === "read" || descriptor.op === "delete"
						? emptyHash
						: hash,
				size: 0,
			}).success,
		).toBe(true);
	});
	it("rejects put descriptors with two paths", () => {
		expect(
			OperationDescriptorSchema.safeParse({
				op: "put",
				epoch,
				paths: ["a", "b"],
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
	});
	it("rejects explicit epochs that disagree with the ETag epoch", () => {
		expect(
			OperationDescriptorSchema.safeParse({
				op: "put",
				epoch: "0000000000000000000000000000000b",
				paths: ["a"],
				precondition: { kind: "match", etag: `"${epoch}.1"` },
			}).success,
		).toBe(false);
	});
	it("rejects non-empty read payload declarations", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[0],
				payload_hash: emptyHash,
				size: 1,
			}).success,
		).toBe(false);
	});
	it("rejects nonzero read size with the empty digest", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[0],
				payload_hash: emptyHash,
				size: 1,
			}).success,
		).toBe(false);
	});
	it("rejects a non-empty digest for a zero-size read", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[0],
				payload_hash: hash,
				size: 0,
			}).success,
		).toBe(false);
	});
	it("rejects nonzero delete size with the empty digest", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[2],
				payload_hash: emptyHash,
				size: 1,
			}).success,
		).toBe(false);
	});
	it("rejects a non-empty digest for a zero-size delete", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[2],
				payload_hash: hash,
				size: 0,
			}).success,
		).toBe(false);
	});
	it("accepts append declarations at one million bytes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[4],
				payload_hash: hash,
				size: 1_000_000,
			}).success,
		).toBe(true);
	});
	it("rejects append declarations above one million bytes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[4],
				payload_hash: hash,
				size: 1_000_001,
			}).success,
		).toBe(false);
	});
	it("accepts non-put metadata at the request-body limit", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[3],
				payload_hash: hash,
				size: 26_000_000,
			}).success,
		).toBe(true);
	});
	it("rejects non-put metadata above the request-body limit", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[3],
				payload_hash: hash,
				size: 26_000_001,
			}).success,
		).toBe(false);
	});
	it("accepts put declarations at the blob limit", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: hash,
				size: 25_000_000,
			}).success,
		).toBe(true);
	});
	it("rejects put declarations above the blob limit", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: hash,
				size: 25_000_001,
			}).success,
		).toBe(false);
	});
	it("rejects payload hashes outside lowercase hexadecimal", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[0],
				payload_hash: "z".repeat(64),
				size: 0,
			}).success,
		).toBe(false);
	});
	it("rejects uppercase payload hashes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: "A".repeat(64),
				size: 0,
			}).success,
		).toBe(false);
	});
	it("rejects short payload hashes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: "a".repeat(63),
				size: 0,
			}).success,
		).toBe(false);
	});
	it("rejects non-hex payload hashes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: "g".repeat(64),
				size: 0,
			}).success,
		).toBe(false);
	});
	it("rejects negative sizes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[3],
				payload_hash: hash,
				size: -1,
			}).success,
		).toBe(false);
	});
	it("rejects fractional sizes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[3],
				payload_hash: hash,
				size: 1.5,
			}).success,
		).toBe(false);
	});
	it("rejects unsafe sizes", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[3],
				payload_hash: hash,
				size: Number.MAX_SAFE_INTEGER + 1,
			}).success,
		).toBe(false);
	});
	it("rejects caller-supplied storage kinds", () => {
		expect(
			OperationIntentSchema.safeParse({
				...cases[1],
				payload_hash: hash,
				size: 0,
				kind: "text",
			}).success,
		).toBe(false);
	});
	it.each([
		[
			"read with absent precondition",
			{ op: "read", paths: ["a"], precondition: { kind: "absent" } },
		],
		[
			"put with no precondition",
			{ op: "put", epoch, paths: ["a"], precondition: { kind: "none" } },
		],
		[
			"delete with absent precondition",
			{ op: "delete", paths: ["a"], precondition: { kind: "absent" } },
		],
		[
			"rename with absent precondition",
			{ op: "rename", paths: ["a", "b"], precondition: { kind: "absent" } },
		],
		[
			"append with revision precondition",
			{
				op: "append",
				epoch,
				paths: ["a"],
				precondition: { kind: "match", etag: `"${epoch}.1"` },
			},
		],
		[
			"restore with no precondition",
			{ op: "restore", paths: ["a"], precondition: { kind: "none" } },
		],
	] as const)("rejects $0", (_label, invalid) => {
		expect(OperationDescriptorSchema.safeParse(invalid).success).toBe(false);
	});
	it("requires an explicit epoch for put", () => {
		expect(
			OperationDescriptorSchema.safeParse({
				op: "put",
				paths: ["a"],
				precondition: { kind: "absent" },
			}).success,
		).toBe(false);
	});
	it("requires an explicit epoch for append", () => {
		expect(
			OperationDescriptorSchema.safeParse({
				op: "append",
				paths: ["a"],
				precondition: { kind: "none" },
			}).success,
		).toBe(false);
	});
	it("accepts bootstrap reads without an epoch", () => {
		expect(OperationDescriptorSchema.safeParse(cases[0]).success).toBe(true);
	});
	it("checks normalized path byte and segment boundaries", () => {
		expect(
			OperationDescriptorSchema.safeParse({
				op: "read",
				paths: ["a".repeat(512)],
				precondition: { kind: "none" },
			}).success,
		).toBe(true);
		expect(
			OperationDescriptorSchema.safeParse({
				op: "read",
				paths: ["a".repeat(513)],
				precondition: { kind: "none" },
			}).success,
		).toBe(false);
		expect(
			OperationDescriptorSchema.safeParse({
				op: "read",
				paths: [Array(32).fill("a").join("/")],
				precondition: { kind: "none" },
			}).success,
		).toBe(true);
		expect(
			OperationDescriptorSchema.safeParse({
				op: "read",
				paths: [Array(33).fill("a").join("/")],
				precondition: { kind: "none" },
			}).success,
		).toBe(false);
	});
	it("accepts a 2,048-byte client identifier", () => {
		expect(
			AuthorizationContextSchema.safeParse({
				...ctx,
				client_id: "a".repeat(2048),
			}).success,
		).toBe(true);
	});
	it("rejects a 2,049-byte client identifier", () => {
		expect(
			AuthorizationContextSchema.safeParse({
				...ctx,
				client_id: "a".repeat(2049),
			}).success,
		).toBe(false);
	});
	it("accepts a 2,048-byte multibyte grant identifier", () => {
		expect(
			AuthorizationContextSchema.safeParse({
				...ctx,
				grant_id: "é".repeat(1024),
			}).success,
		).toBe(true);
	});
	it("rejects a 2,049-byte multibyte grant identifier", () => {
		expect(
			AuthorizationContextSchema.safeParse({
				...ctx,
				grant_id: `${"é".repeat(1024)}a`,
			}).success,
		).toBe(false);
	});
	it("sorts two normalized scopes into canonical order", () => {
		const parsed = AuthorizationContextSchema.parse({
			...ctx,
			scopes: ["vault:write", "vault:read"],
		});
		expect(parsed.scopes).toEqual(["vault:read", "vault:write"]);
	});
	it("sorts normalized scopes into canonical order without changing caller input", () => {
		const scopes = ["vault:write", "vault:delete", "vault:read"];
		const parsed = AuthorizationContextSchema.parse({ ...ctx, scopes });
		expect(parsed.scopes).toEqual([
			"vault:delete",
			"vault:read",
			"vault:write",
		]);
		expect(scopes).toEqual(["vault:write", "vault:delete", "vault:read"]);
	});
	it("requires unique scopes", () => {
		expect(
			AuthorizationContextSchema.safeParse({
				...ctx,
				scopes: ["vault:write", "vault:write"],
			}).success,
		).toBe(false);
	});
	it.each(["vault:read", "vault:write", "vault:delete"])(
		"accepts scope %s",
		(scope) => {
			expect(
				AuthorizationContextSchema.safeParse({ ...ctx, scopes: [scope] })
					.success,
			).toBe(true);
		},
	);
	it("rejects scopes outside the vault scope set", () => {
		expect(
			AuthorizationContextSchema.safeParse({ ...ctx, scopes: ["vault:admin"] })
				.success,
		).toBe(false);
	});
	it("bounds descriptor and intent envelopes at 16 KiB", () => {
		/** Pad identity fields so context-plus-member JSON reaches an exact UTF-8 byte target. */
		const makeContext = (
			target: number,
			member: { descriptor: unknown } | { intent: unknown },
		) => {
			const baseline = {
				...ctx,
				client_id: "a".repeat(2048),
				grant_id: "g".repeat(2048),
			};
			const baseBytes = new TextEncoder().encode(
				JSON.stringify({ context: baseline, ...member }),
			).byteLength;
			const delta = target - baseBytes;
			const nullCount = Math.floor(delta / 5);
			const tabCount = delta - nullCount * 5;
			if (nullCount + tabCount > 4096)
				throw new Error("envelope target cannot fit");
			const a = Math.min(2048, nullCount);
			const b = nullCount - a;
			const tabsA = Math.min(tabCount, 2048 - a);
			const tabsB = tabCount - tabsA;
			return {
				...ctx,
				client_id:
					"\u0000".repeat(a) +
					"\t".repeat(tabsA) +
					"a".repeat(2048 - a - tabsA),
				grant_id:
					"\u0000".repeat(b) +
					"\t".repeat(tabsB) +
					"g".repeat(2048 - b - tabsB),
			};
		};
		const atLimitContext = makeContext(16_384, { descriptor: cases[0] });
		const overContext = makeContext(16_385, { descriptor: cases[0] });
		const intent = { ...cases[0], payload_hash: emptyHash, size: 0 };
		const intentAtLimit = makeContext(16_384, { intent });
		const intentOverLimit = makeContext(16_385, { intent });
		const descEnvelope = { context: atLimitContext, descriptor: cases[0] };
		const descOverEnvelope = { context: overContext, descriptor: cases[0] };
		const opEnvelope = { context: intentAtLimit, intent };
		const opOverEnvelope = { context: intentOverLimit, intent };
		expect(
			new TextEncoder().encode(JSON.stringify(descEnvelope)).byteLength,
		).toBe(16_384);
		expect(
			new TextEncoder().encode(JSON.stringify(descOverEnvelope)).byteLength,
		).toBe(16_385);
		expect(
			new TextEncoder().encode(JSON.stringify(opEnvelope)).byteLength,
		).toBe(16_384);
		expect(
			new TextEncoder().encode(JSON.stringify(opOverEnvelope)).byteLength,
		).toBe(16_385);
		expect(DescriptorPreparationSchema.safeParse(descEnvelope).success).toBe(
			true,
		);
		expect(
			DescriptorPreparationSchema.safeParse(descOverEnvelope).success,
		).toBe(false);
		expect(OperationPreparationSchema.safeParse(opEnvelope).success).toBe(true);
		expect(OperationPreparationSchema.safeParse(opOverEnvelope).success).toBe(
			false,
		);
	});
	it("rejects descriptor envelopes above 16 KiB", () => {
		const context = {
			...ctx,
			client_id: "\u0000".repeat(2048),
			grant_id: "\u0000".repeat(2048),
		};
		const envelope = { context, descriptor: cases[0] };
		expect(
			new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
		).toBeGreaterThan(16_384);
		expect(DescriptorPreparationSchema.safeParse(envelope).success).toBe(false);
	});
	it("rejects operation envelopes above 16 KiB", () => {
		const context = {
			...ctx,
			client_id: "\u0000".repeat(2048),
			grant_id: "\u0000".repeat(2048),
		};
		const envelope = {
			context,
			intent: { ...cases[0], payload_hash: emptyHash, size: 0 },
		};
		expect(
			new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
		).toBeGreaterThan(16_384);
		expect(OperationPreparationSchema.safeParse(envelope).success).toBe(false);
	});
	it("rejects string lease expirations", () => {
		expect(
			RequestAdmissionLeaseSchema.safeParse({
				admission_id: "a".repeat(32),
				expires_at: "soon",
			}).success,
		).toBe(false);
	});
	it("rejects fractional lease expirations", () => {
		expect(
			RequestAdmissionLeaseSchema.safeParse({
				admission_id: "a".repeat(32),
				expires_at: 1.5,
			}).success,
		).toBe(false);
	});
	it("accepts a valid request admission lease", () => {
		expect(
			RequestAdmissionLeaseSchema.safeParse({
				admission_id: "a".repeat(32),
				expires_at: 1,
			}).success,
		).toBe(true);
	});
	it("rejects malformed request admission results", () => {
		expect(
			RequestAdmissionResultSchema.safeParse({
				ok: "yes",
				failure: { kind: "invalid_request" },
			}).success,
		).toBe(false);
	});
	it("accepts successful request admission results", () => {
		expect(
			RequestAdmissionResultSchema.safeParse({
				ok: true,
				lease: { admission_id: "a".repeat(32), expires_at: 1 },
			}).success,
		).toBe(true);
	});
	it("accepts failed request admission results", () => {
		expect(
			RequestAdmissionResultSchema.safeParse({
				ok: false,
				failure: { kind: "invalid_request" },
			}).success,
		).toBe(true);
	});
	it("rejects ticket identifiers outside 32 lowercase hex characters", () => {
		expect(
			OperationTicketSchema.safeParse({ id: "a".repeat(31), expires_at: 1 })
				.success,
		).toBe(false);
	});
	it("accepts a 32-character lowercase hexadecimal ticket identifier", () => {
		expect(
			OperationTicketSchema.safeParse({ id: "a".repeat(32), expires_at: 1 })
				.success,
		).toBe(true);
	});
	it("rejects unknown admission failure kinds", () => {
		expect(AdmissionFailureSchema.safeParse({ kind: "unknown" }).success).toBe(
			false,
		);
	});
	it("accepts valid admission failure variants", () => {
		const variants = [
			{ kind: "invalid_request" },
			{ kind: "revoked" },
			{ kind: "forbidden_scope" },
			{ kind: "epoch_mismatch", current_epoch: epoch },
			{ kind: "text_too_large" },
			{ kind: "blob_too_large" },
			{ kind: "admission_limited", retry_after_seconds: 1 },
			{ kind: "invalid_ticket" },
			{ kind: "precondition_failed" },
		];
		for (const failure of variants)
			expect(AdmissionFailureSchema.safeParse(failure).success).toBe(true);
	});
	it("requires a valid current epoch for epoch mismatch", () => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "epoch_mismatch",
				current_epoch: "z".repeat(32),
			}).success,
		).toBe(false);
	});
	it("requires a positive retry delay for admission limits", () => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "admission_limited",
				retry_after_seconds: 0,
			}).success,
		).toBe(false);
	});
	it("rejects partial current revision metadata for precondition failures", () => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "precondition_failed",
				etag: `"${epoch}.1"`,
			}).success,
		).toBe(false);
	});
	it.each([
		["hash only", { hash }],
		["deleted only", { deleted: false }],
		["etag and hash", { etag: `"${epoch}.1"`, hash }],
		["etag and deleted", { etag: `"${epoch}.1"`, deleted: false }],
		["hash and deleted", { hash, deleted: false }],
	] as const)("rejects partial current metadata: %s", (_label, current) => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "precondition_failed",
				...current,
			}).success,
		).toBe(false);
	});
	it("accepts complete current tombstone metadata with an empty hash", () => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "precondition_failed",
				etag: `"${epoch}.1"`,
				hash: "",
				deleted: true,
			}).success,
		).toBe(true);
	});
	it("rejects an empty hash for a live current row", () => {
		expect(
			AdmissionFailureSchema.safeParse({
				kind: "precondition_failed",
				etag: `"${epoch}.1"`,
				hash: "",
				deleted: false,
			}).success,
		).toBe(false);
	});
	it("carries current revision metadata for precondition failures", () => {
		const parsed = AdmissionFailureSchema.parse({
			kind: "precondition_failed",
			etag: `"${epoch}.1"`,
			hash,
			deleted: false,
		});
		expect(parsed).toMatchObject({
			etag: `"${epoch}.1"`,
			hash,
			deleted: false,
		});
	});
	it("accepts a successful admission result", () => {
		expect(
			AdmissionResultSchema.safeParse({
				ok: true,
				ticket: { id: "a".repeat(32), expires_at: 1 },
			}).success,
		).toBe(true);
	});
	it("accepts a failed admission result", () => {
		expect(
			AdmissionResultSchema.safeParse({
				ok: false,
				failure: { kind: "invalid_ticket" },
			}).success,
		).toBe(true);
	});
	it("rejects malformed admission results", () => {
		expect(
			AdmissionResultSchema.safeParse({
				ok: true,
				ticket: { id: "bad", expires_at: 1 },
			}).success,
		).toBe(false);
	});
	it.each(["settled", "uncertain"] as const)(
		"accepts completion %s",
		(completion) => {
			expect(AdmissionCompletionSchema.safeParse(completion).success).toBe(
				true,
			);
		},
	);
	it("rejects unknown completion states", () => {
		expect(AdmissionCompletionSchema.safeParse("unknown").success).toBe(false);
	});
	it("rejects malformed finish results", () => {
		expect(AdmissionFinishResultSchema.safeParse({ ok: "yes" }).success).toBe(
			false,
		);
	});
	it("accepts successful finish results", () => {
		expect(AdmissionFinishResultSchema.safeParse({ ok: true }).success).toBe(
			true,
		);
	});
	it("accepts failed finish results", () => {
		expect(
			AdmissionFinishResultSchema.safeParse({
				ok: false,
				failure: { kind: "invalid_ticket" },
			}).success,
		).toBe(true);
	});
	it("normalizes path Unicode before envelope serialization", () => {
		const parsed = DescriptorPreparationSchema.parse({
			context: ctx,
			descriptor: {
				op: "read",
				paths: ["cafe\u0301.md"],
				precondition: { kind: "none" },
			},
		});
		expect(parsed.descriptor.paths[0]).toBe("café.md");
	});
});
