import type {
	AdmissionCompletion,
	AuthorizationContext,
} from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import type { TextVaultGateway } from "@worker/application/text-files";
import { readContentResponse } from "@worker/transport/content-reads";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const identity: AuthorizationContext = {
	client_id: "read",
	grant_id: "grant",
	scopes: ["vault:read"],
};
/** Read-only gateway methods needed to select content under one ticket. */
type ContentGateway = Pick<
	TextVaultGateway,
	"authorize" | "finishAdmission" | "readText" | "readBlobMetadata"
>;

/** Expose explicit asynchronous work barriers without a timer. */
function barrier<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

/** Build an authority that checks the response ticket at both content selection boundaries. */
function gateway(finished: AdmissionCompletion[]): ContentGateway {
	return {
		authorize: async () => ({
			ok: true,
			ticket: { id: "1".repeat(32), expires_at: 60_000 },
		}),
		finishAdmission: async (_identity, _ticket, completion) => {
			finished.push(completion);
			return { ok: true };
		},
		readText: async (_identity, _selection, ticket) => {
			expect(ticket).toBe("1".repeat(32));
			return { ok: false, failure: { kind: "not_implemented" } };
		},
		readBlobMetadata: async (_identity, selection, ticket) => {
			expect(ticket).toBe("1".repeat(32));
			return {
				ok: true,
				body: {
					path: selection.path,
					etag: `"${epoch}.3"`,
					hash: "a".repeat(64),
					size: 100,
					kind: "blob",
					deleted: false,
					origin: "device",
					updated_at: 1,
					large: false,
				},
			};
		},
	};
}

/** Refuse unused storage operations so tests cannot bypass authoritative selection. */
function store(read: BlobContentStore["read"]): BlobContentStore {
	return {
		read,
		head: async () => {
			throw new Error("Unexpected head");
		},
		putVerified: async () => {
			throw new Error("Unexpected write");
		},
	};
}

describe("content read ownership", () => {
	it("retains a shared slot across pending R2 selection, read, cancellation, and durable cleanup", async () => {
		const finished: AdmissionCompletion[] = [];
		const authority = gateway(finished);
		const storageStarted = barrier<void>();
		const storageResult = barrier<ReadableStream<Uint8Array>>();
		const readStarted = barrier<void>();
		const cancelStarted = barrier<void>();
		const cancellation = barrier<void>();
		const cleanupStarted = barrier<void>();
		const cleanup = barrier<void>();
		authority.finishAdmission = async (_identity, _ticket, completion) => {
			finished.push(completion);
			cleanupStarted.resolve();
			await cleanup.promise;
			return { ok: true };
		};
		const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
		const request = new Request("https://content.invalid/v1/files/a.bin");
		const pendingResponse = readContentResponse(
			authority,
			() =>
				store(async () => {
					storageStarted.resolve();
					return storageResult.promise;
				}),
			identity,
			{ path: "a.bin" },
			request,
		);
		await storageStarted.promise;
		expect(tryAcquireReadSlot()).toBeUndefined();
		storageResult.resolve(
			new ReadableStream<Uint8Array>({
				type: "bytes",
				/** Hold the R2 read until explicit cancellation. */
				pull() {
					readStarted.resolve();
				},
				/** Join the explicit R2 cancellation barrier. */
				cancel() {
					cancelStarted.resolve();
					return cancellation.promise;
				},
			}),
		);
		const response = await pendingResponse;
		if (!response.body) throw new Error("Read response has no body");
		const reader = response.body.getReader();
		const read = reader.read();
		await readStarted.promise;
		const cancelled = reader.cancel();
		await cancelStarted.promise;
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(finished).toEqual([]);
		cancellation.resolve();
		await cleanupStarted.promise;
		expect(tryAcquireReadSlot()).toBeUndefined();
		cleanup.resolve();
		await Promise.all([read, cancelled]);
		const free = tryAcquireReadSlot();
		expect(free).toBeTypeOf("function");
		free?.();
		for (const release of held) release?.();
		expect(finished).toEqual(["settled"]);
	});
	it("denies the fifth content read before authority or R2 demand", async () => {
		const held = Array.from({ length: 4 }, () => tryAcquireReadSlot());
		const authority = gateway([]);
		authority.authorize = async () => {
			throw new Error("Unexpected authority demand");
		};
		try {
			const response = await readContentResponse(
				authority,
				() => {
					throw new Error("Unexpected storage demand");
				},
				identity,
				{ path: "a.bin" },
				new Request("https://other.invalid/v1/files/a.bin"),
			);
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({
				error: "admission_limited",
			});
		} finally {
			for (const release of held) release?.();
		}
	});
	it("checks current authority before R2 and retains unknown selection outcomes", async () => {
		for (const unknown of [false, true]) {
			const finished: AdmissionCompletion[] = [];
			const authority = gateway(finished);
			authority.readBlobMetadata = async () => {
				if (unknown) throw new Error("RPC lost");
				return { ok: false, failure: { kind: "revoked" } };
			};
			const response = await readContentResponse(
				authority,
				() =>
					store(async () => {
						throw new Error("Unexpected R2 demand");
					}),
				identity,
				{ path: "a.bin" },
				new Request("https://content.invalid/v1/files/a.bin"),
			);
			expect(response.status).toBe(unknown ? 500 : 401);
			await response.text();
			expect(finished).toEqual([unknown ? "uncertain" : "settled"]);
		}
	});
});
