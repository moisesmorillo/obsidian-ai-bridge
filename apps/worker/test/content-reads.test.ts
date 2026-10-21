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
	it.each(["authorize", "readText", "readBlobMetadata"] as const)(
		"stops content demand after abort during %s and waits for cleanup",
		async (stage) => {
			const finished: AdmissionCompletion[] = [];
			const authority = gateway(finished);
			const started = barrier<void>();
			const work = barrier<void>();
			const finishing = barrier<void>();
			const cleanup = barrier<void>();
			const demands: string[] = [];
			for (const method of [
				"authorize",
				"readText",
				"readBlobMetadata",
			] as const) {
				// Each wrapper keeps its method's exact call signature.
				if (method === "authorize") {
					const call = authority.authorize;
					authority.authorize = async (...args) => {
						demands.push(method);
						if (stage === method) {
							started.resolve();
							await work.promise;
						}
						return call(...args);
					};
				} else if (method === "readText") {
					const call = authority.readText;
					authority.readText = async (...args) => {
						demands.push(method);
						if (stage === method) {
							started.resolve();
							await work.promise;
						}
						return call(...args);
					};
				} else {
					const call = authority.readBlobMetadata;
					authority.readBlobMetadata = async (...args) => {
						demands.push(method);
						if (stage === method) {
							started.resolve();
							await work.promise;
						}
						return call(...args);
					};
				}
			}
			authority.finishAdmission = async (_identity, _ticket, completion) => {
				finished.push(completion);
				finishing.resolve();
				await cleanup.promise;
				return { ok: true };
			};
			const abort = new AbortController();
			const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
			const pending = readContentResponse(
				authority,
				() =>
					store(async () => {
						demands.push("storage");
						return new Blob(["bytes"]).stream();
					}),
				identity,
				{ path: "a.bin" },
				new Request("https://content.invalid/v1/files/a.bin", {
					signal: abort.signal,
				}),
			);
			await started.promise;
			abort.abort();
			expect(tryAcquireReadSlot()).toBeUndefined();
			expect(finished).toEqual([]);
			work.resolve();
			await finishing.promise;
			expect(tryAcquireReadSlot()).toBeUndefined();
			cleanup.resolve();
			const response = await pending;
			await response.body?.cancel();
			const free = tryAcquireReadSlot();
			try {
				const expected = ["authorize", "readText", "readBlobMetadata"];
				expect(demands).toEqual(expected.slice(0, expected.indexOf(stage) + 1));
				expect(finished).toEqual(["settled"]);
				expect(free).toBeTypeOf("function");
			} finally {
				free?.();
				for (const release of held) release?.();
			}
		},
	);
	it("does not authorize already-aborted content input", async () => {
		const finished: AdmissionCompletion[] = [];
		const authority = gateway(finished);
		let demanded = false;
		authority.authorize = async () => {
			demanded = true;
			return { ok: false, failure: { kind: "revoked" } };
		};
		const abort = new AbortController();
		abort.abort();
		const response = await readContentResponse(
			authority,
			() =>
				store(async () => {
					throw new Error("Unexpected storage");
				}),
			identity,
			{ path: "a.bin" },
			new Request("https://content.invalid/v1/files/a.bin", {
				signal: abort.signal,
			}),
		);
		await response.body?.cancel();
		expect(demanded).toBe(false);
		expect(finished).toEqual([]);
	});

	it.each(["authorize", "readText", "readBlobMetadata", "storage"] as const)(
		"does not convert an unknown %s fault into a known abort",
		async (stage) => {
			const finished: AdmissionCompletion[] = [];
			const authority = gateway(finished);
			const started = barrier<void>();
			const work = barrier<void>();
			const finishing = barrier<void>();
			const cleanup = barrier<void>();
			authority.finishAdmission = async (_identity, _ticket, completion) => {
				finished.push(completion);
				finishing.resolve();
				await cleanup.promise;
				return { ok: true };
			};
			if (stage !== "storage")
				authority[stage] = async () => {
					started.resolve();
					await work.promise;
					throw new Error("Unknown authority result");
				};
			const abort = new AbortController();
			const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
			const pending = readContentResponse(
				authority,
				() =>
					store(async () => {
						if (stage === "storage") {
							started.resolve();
							await work.promise;
						}
						throw new Error("Unknown storage result");
					}),
				identity,
				{ path: "a.bin" },
				new Request("https://content.invalid/v1/files/a.bin", {
					signal: abort.signal,
				}),
			);
			await started.promise;
			abort.abort();
			expect(tryAcquireReadSlot()).toBeUndefined();
			expect(finished).toEqual([]);
			work.resolve();
			if (stage !== "authorize") {
				await finishing.promise;
				expect(tryAcquireReadSlot()).toBeUndefined();
				cleanup.resolve();
			}
			const response = await pending;
			await response.text();
			for (const release of held) release?.();
			expect(finished).toEqual(stage === "authorize" ? [] : ["uncertain"]);
		},
	);
	it("joins storage that starts before abort without demanding response bytes", async () => {
		const finished: AdmissionCompletion[] = [];
		const authority = gateway(finished);
		const started = barrier<void>();
		const storage = barrier<ReadableStream<Uint8Array>>();
		const cancelling = barrier<void>();
		const cancellation = barrier<void>();
		const finishing = barrier<void>();
		const cleanup = barrier<void>();
		let reads = 0;
		authority.finishAdmission = async (_identity, _ticket, completion) => {
			finished.push(completion);
			finishing.resolve();
			await cleanup.promise;
			return { ok: true };
		};
		const abort = new AbortController();
		const held = Array.from({ length: 3 }, () => tryAcquireReadSlot());
		const pending = readContentResponse(
			authority,
			() =>
				store(async () => {
					started.resolve();
					return storage.promise;
				}),
			identity,
			{ path: "a.bin" },
			new Request("https://content.invalid/v1/files/a.bin", {
				signal: abort.signal,
			}),
		);
		await started.promise;
		abort.abort();
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(finished).toEqual([]);
		storage.resolve(
			new ReadableStream<Uint8Array>({
				type: "bytes",
				/** Count any byte demand after the request aborts. */
				pull() {
					reads++;
				},
				/** Hold cancellation cleanup behind an explicit barrier. */
				cancel() {
					cancelling.resolve();
					return cancellation.promise;
				},
			}),
		);
		const response = await pending;
		await cancelling.promise;
		expect(tryAcquireReadSlot()).toBeUndefined();
		expect(finished).toEqual([]);
		cancellation.resolve();
		await finishing.promise;
		expect(tryAcquireReadSlot()).toBeUndefined();
		cleanup.resolve();
		await expect(response.arrayBuffer()).rejects.toThrow();
		const free = tryAcquireReadSlot();
		try {
			expect(reads).toBe(0);
			expect(finished).toEqual(["settled"]);
			expect(free).toBeTypeOf("function");
		} finally {
			free?.();
			for (const release of held) release?.();
		}
	});
	it("preserves a known policy failure that completes after abort", async () => {
		const finished: AdmissionCompletion[] = [];
		const authority = gateway(finished);
		const started = barrier<void>();
		const work = barrier<void>();
		authority.readText = async () => {
			started.resolve();
			await work.promise;
			return { ok: false, failure: { kind: "revoked" } };
		};
		const abort = new AbortController();
		const pending = readContentResponse(
			authority,
			() =>
				store(async () => {
					throw new Error("Unexpected storage demand");
				}),
			identity,
			{ path: "a.bin" },
			new Request("https://content.invalid/v1/files/a.bin", {
				signal: abort.signal,
			}),
		);
		await started.promise;
		abort.abort();
		work.resolve();
		const response = await pending;
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ error: "revoked" });
		expect(finished).toEqual(["settled"]);
	});

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
