import { env } from "cloudflare:test";
import type { BlobDeclaration } from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { describe, expect, it, vi } from "vitest";

/** A stream-only PUT fixture. Tests never pass strings or multipart bodies. */
type ControlledPut = (
	key: string,
	body: ReadableStream<Uint8Array>,
	options?: R2PutOptions,
) => Promise<R2Object | null>;

/** Adapt controlled timing to the overloaded SDK boundary. Unused bucket methods stay absent. */
function makeBucket(
	put: ControlledPut,
	head: R2Bucket["head"] = async () => null,
): R2Bucket {
	return { head, put } as unknown as R2Bucket;
}

/** Hash exact binary fixture bytes independently from the streaming adapter. */
async function declaration(bytes: Uint8Array): Promise<BlobDeclaration> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
	);
	return {
		payload_hash: Array.from(digest, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
		size: bytes.byteLength,
	};
}

/** Minimal result metadata for fault injection. Native tests use actual R2Object results. */
function checksumObject(input: BlobDeclaration): R2Object {
	return {
		key: `blobs/${input.payload_hash}`,
		size: input.size,
		checksums: {
			sha256: Uint8Array.from(input.payload_hash.match(/../g) ?? [], (byte) =>
				Number.parseInt(byte, 16),
			).buffer,
		},
	} as R2Object;
}

/** Independent stored-evidence faults that must never authorize successful reuse. */
type EvidenceFault = "checksum" | "digest" | "checksum-length" | "key" | "size";

/** Corrupt one field of a minimal storage fixture without changing incoming bytes. */
function corruptEvidence(
	input: BlobDeclaration,
	fault: EvidenceFault,
): R2Object {
	const result = checksumObject(input);
	switch (fault) {
		case "checksum":
			return Object.assign(result, { checksums: {} });
		case "digest":
			return Object.assign(result, {
				checksums: { sha256: new ArrayBuffer(32) },
			});
		case "checksum-length":
			return Object.assign(result, {
				checksums: { sha256: new ArrayBuffer(31) },
			});
		case "key":
			return Object.assign(result, { key: "other" });
		case "size":
			return Object.assign(result, { size: input.size + 1 });
	}
}

/** A manually settled wait injects storage timing without an internal adapter retry. */
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Bound a test wait. A deadline failure never counts as adapter completion. */
async function deadline<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("test deadline")), 1500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Wait for a specific observed interleaving, not an assumed promise order. */
async function until(predicate: () => boolean): Promise<void> {
	await deadline(
		(async () => {
			while (!predicate())
				await new Promise((resolve) => setTimeout(resolve, 1));
		})(),
	);
}

/** Produce bytes on demand with zero source queue capacity and measured BYOB view sizes. */
function source(size: number, fill = 0) {
	const observations = {
		reads: 0,
		bytes: 0,
		maxView: 0,
		canceled: false,
		eof: false,
	};
	const body = new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Fill one requested view. A separate zero-byte response proves EOF. */
		pull(controller) {
			observations.reads++;
			if (!("byobRequest" in controller))
				throw new Error("expected a byte controller");
			const request = controller.byobRequest;
			if (!request?.view) throw new Error("expected native BYOB demand");
			observations.maxView = Math.max(
				observations.maxView,
				request.view.byteLength,
			);
			const length = Math.min(
				request.view.byteLength,
				size - observations.bytes,
			);
			if (!length) {
				observations.eof = true;
				controller.close();
				request.respond(0);
				return;
			}
			new Uint8Array(request.view.buffer, request.view.byteOffset, length).fill(
				fill,
			);
			observations.bytes += length;
			request.respond(length);
		},
		/** Record cancellation without more source demand. */
		cancel() {
			observations.canceled = true;
		},
	});
	return { body, observations };
}

/** Hold actual EOF after a correct prefix so tests can inspect storage before verification. */
function heldEof(size: number, fill: number) {
	const requested = gate();
	let count = 0;
	let close: (() => void) | undefined;
	const body = new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Supply the prefix, then hold the separate EOF probe. */
		pull(controller) {
			if (!("byobRequest" in controller) || !controller.byobRequest?.view)
				throw new Error("expected BYOB demand");
			const request = controller.byobRequest;
			const view = request.view;
			if (!view) throw new Error("expected a BYOB view");
			const length = Math.min(view.byteLength, size - count);
			if (length) {
				new Uint8Array(view.buffer, view.byteOffset, length).fill(fill);
				count += length;
				request.respond(length);
				return;
			}
			close = () => {
				controller.close();
				request.respond(0);
			};
			requested.resolve();
		},
	});
	return {
		body,
		requested: requested.promise,
		/** Release observed EOF only after the test inspects the pending storage state. */
		finish() {
			if (!close) throw new Error("EOF demand is absent");
			close();
		},
	};
}

/** Run an upload with a fresh signal unless a test owns cancellation. */
function upload(
	bucket: R2Bucket,
	input: BlobDeclaration,
	body: ReadableStream<Uint8Array>,
	signal = new AbortController().signal,
) {
	return new R2BlobStore(bucket).putVerified(input, body, signal);
}

/** Inspect exact stored bytes after a failed or conflicting invocation. */
async function storedBytes(input: BlobDeclaration): Promise<Uint8Array> {
	const stored = await env.R2_BUCKET.get(`blobs/${input.payload_hash}`);
	if (!stored) throw new Error("expected stored native bytes");
	return new Uint8Array(await stored.arrayBuffer());
}

describe("R2BlobStore.putVerified native R2", () => {
	it.each([0, 4, 1_000_000, 1_000_001, 1_500_000, 25_000_000])(
		"stores %i raw bytes with actual SHA-256 evidence and bounded reads",
		async (size) => {
			const input = await declaration(new Uint8Array(size));
			const incoming = source(size);
			await expect(
				upload(env.R2_BUCKET, input, incoming.body),
			).resolves.toEqual({ hash: input.payload_hash, size });
			const stored = await env.R2_BUCKET.head(`blobs/${input.payload_hash}`);
			expect(stored?.size).toBe(size);
			expect(stored?.checksums.sha256).toEqual(
				checksumObject(input).checksums.sha256,
			);
			expect(incoming.observations.bytes).toBe(size);
			expect(incoming.observations.maxView).toBeLessThanOrEqual(65_536);
			if (size <= 4)
				expect(await storedBytes(input)).toEqual(new Uint8Array(size));
		},
	);

	it.each([0, 8])(
		"does not finish a native %i-byte object before actual incoming EOF",
		async (size) => {
			const input = await declaration(new Uint8Array(size).fill(18));
			const incoming = heldEof(size, 18);
			let first = true;
			/** Force one stale negative observation while native R2 owns all storage effects. */
			const head: R2Bucket["head"] = async (key) => {
				if (first) {
					first = false;
					return null;
				}
				return env.R2_BUCKET.head(key);
			};
			const put = vi.fn<ControlledPut>((key, body, options) =>
				env.R2_BUCKET.put(key, body, options),
			);
			const result = upload(makeBucket(put, head), input, incoming.body);
			await deadline(incoming.requested);
			expect(put).toHaveBeenCalledTimes(size === 0 ? 0 : 1);
			if (size > 0)
				expect(
					await env.R2_BUCKET.head(`blobs/${input.payload_hash}`),
				).toBeNull();
			incoming.finish();
			await expect(deadline(result)).resolves.toEqual({
				hash: input.payload_hash,
				size,
			});
			expect(put).toHaveBeenCalledOnce();
		},
	);

	it("cancels native R2 storage while a source read remains pending", async () => {
		const input = await declaration(new Uint8Array(200_000).fill(7));
		const controller = new AbortController();
		let reads = 0;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Supply one chunk, then hold the next source read. */
			pull(stream) {
				reads++;
				if (
					reads === 1 &&
					"byobRequest" in stream &&
					stream.byobRequest?.view
				) {
					const request = stream.byobRequest;
					const view = request.view;
					if (!view) throw new Error("expected a BYOB view");
					new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(7);
					request.respond(view.byteLength);
				}
			},
			/** Record source cancellation from the adapter signal. */
			cancel() {
				canceled = true;
			},
		});
		const result = upload(env.R2_BUCKET, input, body, controller.signal);
		await until(() => reads === 2);
		controller.abort();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
		expect(canceled).toBe(true);
		expect(reads).toBe(2);
		expect(await env.R2_BUCKET.head(`blobs/${input.payload_hash}`)).toBeNull();
	});

	it("keeps binary bytes exact without transport length or text decoding", async () => {
		const bytes = Uint8Array.of(
			0xef,
			0xbb,
			0xbf,
			0,
			0xff,
			0xc0,
			0x80,
			0xf0,
			0x9f,
			0x92,
			0xa9,
		);
		const input = await declaration(bytes);
		await upload(env.R2_BUCKET, input, new Blob([bytes]).stream());
		expect(await storedBytes(input)).toEqual(bytes);
	});

	it.each(["digest", "underflow", "overflow"])(
		"rejects measured %s before storage publication",
		async (kind) => {
			const input = await declaration(Uint8Array.of(10, 20, 30));
			const body =
				kind === "digest"
					? Uint8Array.of(30, 20, 10)
					: kind === "underflow"
						? Uint8Array.of(10, 20)
						: Uint8Array.of(10, 20, 30, 40);
			await expect(
				upload(env.R2_BUCKET, input, new Blob([body]).stream()),
			).rejects.toThrow("blob_integrity_mismatch");
			expect(
				await env.R2_BUCKET.head(`blobs/${input.payload_hash}`),
			).toBeNull();
		},
	);

	it("rejects declared 25,000,001 bytes without storage I/O or source demand", async () => {
		const incoming = source(25_000_001);
		const put = vi.fn<ControlledPut>(async () => null);
		const head = vi.fn(async () => null);
		await expect(
			upload(
				makeBucket(put, head),
				{ payload_hash: "a".repeat(64), size: 25_000_001 },
				incoming.body,
			),
		).rejects.toThrow("blob_too_large");
		expect(put).not.toHaveBeenCalled();
		expect(head).not.toHaveBeenCalled();
		expect(incoming.observations.reads).toBe(0);
	});

	it("rejects measured 25,000,001 bytes and leaves no object", async () => {
		const input = await declaration(new Uint8Array(25_000_000).fill(1));
		await expect(
			upload(env.R2_BUCKET, input, source(25_000_001, 1).body),
		).rejects.toThrow("blob_too_large");
		expect(await env.R2_BUCKET.head(`blobs/${input.payload_hash}`)).toBeNull();
	});

	it("reuses verified native objects but still rejects forged incoming bytes", async () => {
		const bytes = Uint8Array.of(41, 42, 43);
		const input = await declaration(bytes);
		await env.R2_BUCKET.put(`blobs/${input.payload_hash}`, bytes, {
			sha256: checksumObject(input).checksums.sha256,
		});
		const put = vi.fn<ControlledPut>((key, body, options) =>
			env.R2_BUCKET.put(key, body, options),
		);
		const bucket = makeBucket(put, env.R2_BUCKET.head.bind(env.R2_BUCKET));
		await expect(
			upload(bucket, input, new Blob([bytes]).stream()),
		).resolves.toEqual({ hash: input.payload_hash, size: 3 });
		await expect(
			upload(bucket, input, new Blob([Uint8Array.of(9, 9, 9)]).stream()),
		).rejects.toThrow("blob_integrity_mismatch");
		expect(put).not.toHaveBeenCalled();
		expect(await storedBytes(input)).toEqual(bytes);
	});

	it.each(["checksum", "size"] as const)(
		"preserves a same-key object with conflicting native %s evidence",
		async (kind) => {
			const bytes =
				kind === "size" ? Uint8Array.of(61, 62, 64) : Uint8Array.of(61, 62, 63);
			const input = await declaration(bytes);
			const conflicting =
				kind === "size" ? Uint8Array.of(81, 82) : Uint8Array.of(81, 82, 83);
			const other = await declaration(conflicting);
			await env.R2_BUCKET.put(`blobs/${input.payload_hash}`, conflicting, {
				sha256: checksumObject(other).checksums.sha256,
			});
			await expect(
				upload(env.R2_BUCKET, input, new Blob([bytes]).stream()),
			).rejects.toThrow("blob_storage_unavailable");
			expect(await storedBytes(input)).toEqual(conflicting);
		},
	);

	it("settles two same-hash native creates without replacement", async () => {
		const bytes = Uint8Array.of(71, 72, 73, 74);
		const input = await declaration(bytes);
		const arrived = gate();
		let heads = 0;
		/** Hold both initial observations before either native create starts. */
		const head: R2Bucket["head"] = async (key) => {
			if (heads < 2) {
				heads++;
				if (heads === 2) arrived.resolve();
				await arrived.promise;
				return null;
			}
			return env.R2_BUCKET.head(key);
		};
		const put = vi.fn<ControlledPut>((key, body, options) =>
			env.R2_BUCKET.put(key, body, options),
		);
		const bucket = makeBucket(put, head);
		const results = await Promise.all([
			upload(bucket, input, new Blob([bytes]).stream()),
			upload(bucket, input, new Blob([bytes]).stream()),
		]);
		expect(results).toEqual([
			{ hash: input.payload_hash, size: 4 },
			{ hash: input.payload_hash, size: 4 },
		]);
		expect(put).toHaveBeenCalledTimes(2);
		for (const call of put.mock.calls)
			expect(call[2]?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
		expect(await storedBytes(input)).toEqual(bytes);
	});

	it.each(["matching", "conflicting"] as const)(
		"checks %s native evidence after conditional refusal and an earlier negative HEAD",
		async (kind) => {
			const bytes =
				kind === "matching"
					? Uint8Array.of(91, 92, 93)
					: Uint8Array.of(91, 92, 94);
			const input = await declaration(bytes);
			const competitor = kind === "matching" ? bytes : Uint8Array.of(1, 2, 9);
			const competitorDeclaration = await declaration(competitor);
			let first = true;
			/** Simulate a stale negative HEAD after a competitor creates the native object. */
			const head: R2Bucket["head"] = async (key) => {
				if (first) {
					first = false;
					await env.R2_BUCKET.put(key, competitor, {
						sha256: checksumObject(competitorDeclaration).checksums.sha256,
					});
					return null;
				}
				return env.R2_BUCKET.head(key);
			};
			const put = vi.fn<ControlledPut>((key, body, options) =>
				env.R2_BUCKET.put(key, body, options),
			);
			const result = upload(
				makeBucket(put, head),
				input,
				new Blob([bytes]).stream(),
			);
			if (kind === "matching")
				await expect(result).resolves.toEqual({
					hash: input.payload_hash,
					size: 3,
				});
			else await expect(result).rejects.toThrow("blob_storage_unavailable");
			expect(put).toHaveBeenCalledOnce();
			expect(await storedBytes(input)).toEqual(competitor);
		},
	);

	it("does not retry or reconcile a lost native success result within one invocation", async () => {
		const bytes = Uint8Array.of(101, 102, 103);
		const input = await declaration(bytes);
		const head = vi.fn(env.R2_BUCKET.head.bind(env.R2_BUCKET));
		const put = vi.fn<ControlledPut>(async (key, body, options) => {
			await env.R2_BUCKET.put(key, body, options);
			throw new Error("lost result");
		});
		const bucket = makeBucket(put, head);
		await expect(
			upload(bucket, input, new Blob([bytes]).stream()),
		).rejects.toThrow("blob_storage_unavailable");
		expect(put).toHaveBeenCalledOnce();
		expect(head).toHaveBeenCalledOnce();
		expect(await storedBytes(input)).toEqual(bytes);
		await expect(
			upload(bucket, input, new Blob([bytes]).stream()),
		).resolves.toEqual({ hash: input.payload_hash, size: 3 });
		expect(put).toHaveBeenCalledOnce();
	});
});

describe("pinned native R2 and FixedLengthStream contracts", () => {
	it("rejects an incorrect R2 SHA-256 checksum without creating an object", async () => {
		const key = "native-checksum-rejection";
		await expect(
			env.R2_BUCKET.put(key, Uint8Array.of(1, 2, 3), {
				sha256: new Uint8Array(32),
			}),
		).rejects.toThrow(/checksum/i);
		expect(await env.R2_BUCKET.head(key)).toBeNull();
	});
	it("rejects an incorrect checksum from a native fixed-length R2 stream", async () => {
		const key = "native-stream-checksum-rejection";
		const fixed = new FixedLengthStream(3);
		const writer = fixed.writable.getWriter();
		void writer.closed.catch(() => undefined);
		const put = env.R2_BUCKET.put(key, fixed.readable, {
			sha256: new Uint8Array(32),
		});
		const produced = (async () => {
			await writer.write(Uint8Array.of(1, 2, 3));
			await writer.close();
		})();
		void produced.catch(() => undefined);
		await expect(put).rejects.toThrow(/checksum/i);
		await produced;
		expect(await env.R2_BUCKET.head(key)).toBeNull();
	});

	it("settles native R2 rejection after an aborted fixed-length request without adapter code", async () => {
		const fixed = new FixedLengthStream(20);
		const writer = fixed.writable.getWriter();
		const closed = writer.closed;
		void closed.catch(() => undefined);
		const put = env.R2_BUCKET.put("native-aborted-stream", fixed.readable);
		void put.catch(() => undefined);
		await writer.write(Uint8Array.of(1, 2, 3));
		await writer.abort(new Error("test source stopped"));
		const outcomes = await Promise.allSettled([put, closed]);
		expect(outcomes[0]?.status).toBe("rejected");
		expect(outcomes[1]?.status).toBe("rejected");
		expect(await env.R2_BUCKET.head("native-aborted-stream")).toBeNull();
	});

	it("returns null for create-only refusal and preserves native bytes", async () => {
		const key = "native-create-only";
		await env.R2_BUCKET.put(key, Uint8Array.of(1, 2, 3));
		expect(
			await env.R2_BUCKET.put(key, Uint8Array.of(9, 8, 7), {
				onlyIf: { etagDoesNotMatch: "*" },
			}),
		).toBeNull();
		const stored = await env.R2_BUCKET.get(key);
		if (!stored) throw new Error("expected the original native object");
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(
			Uint8Array.of(1, 2, 3),
		);
	});
	it.each([2, 4])(
		"rejects native R2 input of %i bytes through a three-byte FixedLengthStream",
		async (size) => {
			const fixed = new FixedLengthStream(3);
			const writer = fixed.writable.getWriter();
			void writer.closed.catch(() => undefined);
			const key = `native-fixed-length-${size}`;
			const consumed = env.R2_BUCKET.put(key, fixed.readable);
			const produced = (async () => {
				await writer.write(new Uint8Array(size));
				await writer.close();
			})();
			const results = await Promise.allSettled([consumed, produced]);
			expect(results[0]?.status).toBe("rejected");
			if (size > 3) expect(results[1]?.status).toBe("rejected");
			expect(await env.R2_BUCKET.head(key)).toBeNull();
		},
	);
});

describe("R2BlobStore controlled storage timing", () => {
	it.each(["digest", "size", "storage"] as const)(
		"returns an application-owned canonical %s failure",
		async (kind) => {
			const input = await declaration(Uint8Array.of(1));
			if (kind === "size") input.size = 25_000_001;
			const bucket = makeBucket(async () => {
				throw new Error("private storage detail");
			});
			const result = upload(
				kind === "digest" ? env.R2_BUCKET : bucket,
				input,
				new Blob([Uint8Array.of(2)]).stream(),
			);
			await expect(result).rejects.toBeInstanceOf(FileOperationDenied);
			await expect(result).rejects.toMatchObject({
				failure:
					kind === "digest"
						? { kind: "blob_integrity_mismatch" }
						: kind === "size"
							? { kind: "blob_too_large" }
							: { kind: "blob_storage_unavailable", retry_after_seconds: 1 },
			});
		},
	);

	it("retains the initial test's consuming success fixture and create-only assertion", async () => {
		const bytes = new TextEncoder().encode("blob");
		const input = await declaration(bytes);
		const put = vi.fn<ControlledPut>(async (_key, body) => {
			expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(
				bytes,
			);
			return checksumObject(input);
		});
		await expect(
			upload(makeBucket(put), input, new Blob([bytes]).stream()),
		).resolves.toEqual({ hash: input.payload_hash, size: 4 });
		expect(put).toHaveBeenCalledOnce();
		expect(put.mock.calls[0]?.[0]).toBe(`blobs/${input.payload_hash}`);
		expect(put.mock.calls[0]?.[2]?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
	});

	it("rejects a successful storage result that arrives before verified close", async () => {
		const input = await declaration(new Uint8Array(200_000));
		const incoming = source(input.size);
		const put = vi.fn<ControlledPut>(async () => checksumObject(input));
		await expect(
			deadline(upload(makeBucket(put), input, incoming.body)),
		).rejects.toThrow("blob_storage_unavailable");
		expect(incoming.observations.canceled).toBe(true);
		expect(put).toHaveBeenCalledOnce();
	});

	it.each(["missing", "matching", "forged", "underflow", "overflow"])(
		"verifies incoming bytes after immediate null with %s evidence or input",
		async (kind) => {
			const size = 200_000;
			const input = await declaration(new Uint8Array(size));
			const incoming = source(
				kind === "underflow" ? size - 1 : kind === "overflow" ? size + 1 : size,
				kind === "forged" ? 1 : 0,
			);
			const put = vi.fn<ControlledPut>(async () => null);
			const head = vi
				.fn()
				.mockResolvedValueOnce(null)
				.mockResolvedValue(kind === "matching" ? checksumObject(input) : null);
			const result = deadline(
				upload(makeBucket(put, head), input, incoming.body),
			);
			if (kind === "matching")
				await expect(result).resolves.toEqual({
					hash: input.payload_hash,
					size,
				});
			else
				await expect(result).rejects.toThrow(
					kind === "missing"
						? "blob_storage_unavailable"
						: "blob_integrity_mismatch",
				);
			expect(put).toHaveBeenCalledOnce();
			expect(incoming.observations.bytes).toBe(
				kind === "underflow" ? size - 1 : kind === "overflow" ? size + 1 : size,
			);
			expect(incoming.observations.maxView).toBeLessThanOrEqual(65_536);
			if (kind !== "overflow") expect(incoming.observations.eof).toBe(true);
		},
	);

	it("verifies stored evidence after a consuming conditional refusal near final close", async () => {
		const input = await declaration(new Uint8Array(200_000));
		const incoming = source(input.size);
		const put = vi.fn<ControlledPut>(async (_key, body) => {
			await new Response(body).arrayBuffer();
			return null;
		});
		const head = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValue(checksumObject(input));
		await expect(
			deadline(upload(makeBucket(put, head), input, incoming.body)),
		).resolves.toEqual({ hash: input.payload_hash, size: input.size });
		expect(incoming.observations.eof).toBe(true);
		expect(head).toHaveBeenCalledTimes(2);
		expect(put).toHaveBeenCalledOnce();
	});

	it("unblocks a pending write when a non-consuming PUT later returns null", async () => {
		const input = await declaration(new Uint8Array(200_000));
		const incoming = source(input.size);
		const refusal = gate();
		const put = vi.fn<ControlledPut>(async () => {
			await refusal.promise;
			return null;
		});
		const head = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValue(checksumObject(input));
		const result = upload(makeBucket(put, head), input, incoming.body);
		await until(() => incoming.observations.reads === 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(incoming.observations.reads).toBe(1);
		refusal.resolve();
		await expect(deadline(result)).resolves.toEqual({
			hash: input.payload_hash,
			size: input.size,
		});
		expect(incoming.observations.eof).toBe(true);
		expect(incoming.observations.bytes).toBe(input.size);
		expect(put).toHaveBeenCalledOnce();
	});

	it("stops a non-consuming locked sink after conditional null without another read", async () => {
		const input = await declaration(new Uint8Array(200_000));
		const incoming = source(input.size);
		const refusal = gate();
		let storageReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const put = vi.fn<ControlledPut>(async (_key, body) => {
			storageReader = body.getReader();
			void storageReader.closed.catch(() => undefined);
			await refusal.promise;
			return null;
		});
		const head = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValue(checksumObject(input));
		const result = upload(makeBucket(put, head), input, incoming.body);
		await until(() => incoming.observations.reads === 1);
		refusal.resolve();
		try {
			await expect(deadline(result)).resolves.toEqual({
				hash: input.payload_hash,
				size: input.size,
			});
			expect(incoming.observations.eof).toBe(true);
			expect(put).toHaveBeenCalledOnce();
		} finally {
			await storageReader?.cancel().catch(() => undefined);
			storageReader?.releaseLock();
		}
	});

	it.each([
		"checksum",
		"digest",
		"checksum-length",
		"key",
		"size",
		"absent",
	] as const)("rejects %s evidence after a conditional race", async (kind) => {
		const input = await declaration(Uint8Array.of(5, 6, 7));
		const invalid = kind === "absent" ? null : corruptEvidence(input, kind);
		const head = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(invalid);
		await expect(
			upload(
				makeBucket(async () => null, head),
				input,
				new Blob([Uint8Array.of(5, 6, 7)]).stream(),
			),
		).rejects.toThrow("blob_storage_unavailable");
	});

	it.each(["checksum", "digest", "checksum-length", "key", "size"] as const)(
		"rejects %s in a successful storage result",
		async (kind) => {
			const bytes = Uint8Array.of(8, 9, 10);
			const input = await declaration(bytes);
			const invalid = corruptEvidence(input, kind);
			const put = vi.fn<ControlledPut>(async (_key, body) => {
				await new Response(body).arrayBuffer();
				return invalid;
			});
			await expect(
				upload(makeBucket(put), input, new Blob([bytes]).stream()),
			).rejects.toThrow("blob_storage_unavailable");
			expect(put).toHaveBeenCalledOnce();
		},
	);

	it("bounds source demand while a storage consumer stops, then resumes", async () => {
		const input = await declaration(new Uint8Array(500_000));
		const incoming = source(input.size);
		const resume = gate();
		let consumed = 0;
		const put = vi.fn<ControlledPut>(async (_key, body) => {
			const reader = body.getReader();
			const first = await reader.read();
			consumed += first.value?.byteLength ?? 0;
			await resume.promise;
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				consumed += next.value.byteLength;
			}
			return checksumObject(input);
		});
		const result = upload(makeBucket(put), input, incoming.body);
		await until(() => consumed > 0);
		const firstBytes = consumed;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(incoming.observations.bytes).toBe(65_536);
		expect(consumed).toBe(firstBytes);
		expect(firstBytes).toBeLessThanOrEqual(65_536);
		expect(incoming.observations.reads).toBe(1);
		resume.resolve();
		await expect(deadline(result)).resolves.toEqual({
			hash: input.payload_hash,
			size: input.size,
		});
		expect(consumed).toBe(input.size);
	});

	it("cancels a pending source read and observes the storage rejection", async () => {
		const input = await declaration(new Uint8Array(1));
		const controller = new AbortController();
		let reads = 0;
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			type: "bytes",
			/** Hold the BYOB read until cancellation. */
			pull() {
				reads++;
			},
			cancel,
		});
		const put = vi.fn<ControlledPut>(async (_key, stream) => {
			await new Response(stream).arrayBuffer();
			return null;
		});
		const result = upload(makeBucket(put), input, body, controller.signal);
		await until(() => reads === 1);
		controller.abort();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
		expect(cancel).toHaveBeenCalledOnce();
		expect(reads).toBe(1);
	});

	it("keeps a delayed native digest write result owned after cancellation", async () => {
		const nativeCrypto = crypto as Crypto & {
			DigestStream: typeof DigestStream;
		};
		const original = nativeCrypto.DigestStream.prototype.getWriter;
		const entered = gate();
		const release = gate();
		let settled = false;
		const spy = vi
			.spyOn(nativeCrypto.DigestStream.prototype, "getWriter")
			.mockImplementation(function (this: DigestStream) {
				const writer = original.call(this);
				/** Preserve native hashing but delay its result for cancellation ordering. */
				const write = writer.write.bind(writer);
				vi.spyOn(writer, "write").mockImplementation(async (value) => {
					await write(value);
					entered.resolve();
					await release.promise;
				});
				return writer;
			});
		try {
			const input = await declaration(new Uint8Array(200_000));
			const incoming = source(input.size);
			const controller = new AbortController();
			const result = upload(
				makeBucket(async () => null),
				input,
				incoming.body,
				controller.signal,
			);
			void result.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await deadline(entered.promise);
			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(settled).toBe(false);
			expect(incoming.observations.canceled).toBe(true);
			expect(incoming.observations.reads).toBe(1);
			release.resolve();
			await expect(deadline(result)).rejects.toThrow(
				"blob_storage_unavailable",
			);
		} finally {
			release.resolve();
			spy.mockRestore();
			vi.restoreAllMocks();
		}
	});

	it("cancels a pending storage write but waits for its non-cancellable result", async () => {
		const input = await declaration(new Uint8Array(500_000));
		const incoming = source(input.size);
		const controller = new AbortController();
		const storage = gate();
		let settled = false;
		const put = vi.fn<ControlledPut>(async () => {
			await storage.promise;
			return null;
		});
		const result = upload(
			makeBucket(put),
			input,
			incoming.body,
			controller.signal,
		);
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await until(() => incoming.observations.reads === 1);
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		expect(incoming.observations.canceled).toBe(true);
		expect(incoming.observations.reads).toBe(1);
		storage.resolve();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
	});

	it("keeps a blocked write owned until the storage consumer cancels its locked reader", async () => {
		const input = await declaration(new Uint8Array(500_000));
		const incoming = source(input.size);
		const controller = new AbortController();
		const resume = gate();
		let canceled = false;
		let paused = false;
		const put = vi.fn<ControlledPut>(async (_key, body) => {
			const reader = body.getReader({ mode: "byob" });
			void reader.closed.catch(() => undefined);
			await reader.read(new Uint8Array(4096));
			paused = true;
			await resume.promise;
			await reader.cancel();
			canceled = true;
			return null;
		});
		const result = upload(
			makeBucket(put),
			input,
			incoming.body,
			controller.signal,
		);
		await until(() => paused);
		controller.abort();
		expect(incoming.observations.canceled).toBe(true);
		resume.resolve();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
		expect(canceled).toBe(true);
		expect(incoming.observations.reads).toBe(1);
	});

	it("keeps a pending HEAD owned after abort and never starts PUT", async () => {
		const input = await declaration(new Uint8Array(10));
		const incoming = source(input.size);
		const controller = new AbortController();
		const headWait = gate();
		let settled = false;
		const head = vi.fn(async () => {
			await headWait.promise;
			return null;
		});
		const put = vi.fn<ControlledPut>(async () => null);
		const result = upload(
			makeBucket(put, head),
			input,
			incoming.body,
			controller.signal,
		);
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await until(() => head.mock.calls.length === 1);
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		expect(incoming.observations.canceled).toBe(true);
		expect(incoming.observations.reads).toBe(0);
		headWait.resolve();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
		expect(put).not.toHaveBeenCalled();
	});

	it("keeps a post-refusal HEAD owned after cancellation without another PUT", async () => {
		const input = await declaration(new Uint8Array(100));
		const incoming = source(input.size);
		const waiting = gate();
		const controller = new AbortController();
		let heads = 0;
		let settled = false;
		const head = vi.fn(async () => {
			heads++;
			if (heads === 1) return null;
			await waiting.promise;
			return checksumObject(input);
		});
		const put = vi.fn<ControlledPut>(async () => null);
		const result = upload(
			makeBucket(put, head),
			input,
			incoming.body,
			controller.signal,
		);
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await until(() => heads === 2);
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		expect(incoming.observations.eof).toBe(true);
		waiting.resolve();
		await expect(deadline(result)).rejects.toThrow("blob_storage_unavailable");
		expect(head).toHaveBeenCalledTimes(2);
		expect(put).toHaveBeenCalledOnce();
	});

	it.each(["HEAD", "PUT", "source"])(
		"maps %s failures to retryable storage failure without retries",
		async (kind) => {
			const input = await declaration(new Uint8Array(10));
			const head = vi.fn(async () => {
				if (kind === "HEAD") throw new Error("head failure");
				return null;
			});
			const put = vi.fn<ControlledPut>(async (_key, body) => {
				if (kind === "PUT") throw new Error("put failure");
				await new Response(body).arrayBuffer();
				return null;
			});
			const body =
				kind === "source"
					? new ReadableStream<Uint8Array>({
							type: "bytes",
							/** Fail source demand before any bytes arrive. */
							pull(controller) {
								controller.error(new Error("source failure"));
							},
						})
					: source(10).body;
			await expect(
				deadline(upload(makeBucket(put, head), input, body)),
			).rejects.toThrow("blob_storage_unavailable");
			expect(head).toHaveBeenCalledOnce();
			expect(put).toHaveBeenCalledTimes(kind === "HEAD" ? 0 : 1);
		},
	);

	it("fails closed for a non-BYOB source without storage I/O", async () => {
		const input = await declaration(new Uint8Array(1));
		const put = vi.fn<ControlledPut>(async () => null);
		const head = vi.fn(async () => null);
		await expect(
			upload(makeBucket(put, head), input, new ReadableStream()),
		).rejects.toThrow("blob_storage_unavailable");
		expect(head).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it("does not read a source or start storage for an already aborted request", async () => {
		const input = await declaration(new Uint8Array(1));
		const incoming = source(1);
		const controller = new AbortController();
		controller.abort();
		const put = vi.fn<ControlledPut>(async () => null);
		const head = vi.fn(async () => null);
		await expect(
			upload(makeBucket(put, head), input, incoming.body, controller.signal),
		).rejects.toThrow("blob_storage_unavailable");
		expect(incoming.observations.reads).toBe(0);
		expect(incoming.observations.canceled).toBe(true);
		expect(head).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});
});

it("settles a native writer abort when the consumer cancels its owned reader", async () => {
	const fixed = new FixedLengthStream(500000);
	const writer = fixed.writable.getWriter();
	const reader = fixed.readable.getReader();
	void writer.closed.catch(() => undefined);
	void reader.closed.catch(() => undefined);
	const writing = writer.write(new Uint8Array(65536));
	void writing.catch(() => undefined);
	await reader.read();
	const aborting = writer.abort();
	void aborting.catch(() => undefined);
	const canceled = reader.cancel();
	void canceled.catch(() => undefined);
	const results = await Promise.allSettled([writing, aborting, canceled]);
	expect(results[0]?.status).toBe("rejected");
	expect(results[1]?.status).toBe("fulfilled");
	expect(results[2]?.status).toBe("fulfilled");
});

it("observes exposed promises after cancellation of a pending native BYOB read", async () => {
	const fixed = new FixedLengthStream(1);
	const writer = fixed.writable.getWriter();
	void writer.closed.catch(() => undefined);
	const body = fixed.readable;
	const reader = body.getReader({ mode: "byob" });
	const closed = reader.closed;
	void closed.catch(() => undefined);
	const reading = reader.read(new Uint8Array(1));
	void reading.catch(() => undefined);
	const canceled = reader.cancel();
	void canceled.catch(() => undefined);
	await writer.abort();
	const outcomes = await Promise.allSettled([closed, reading, canceled]);
	expect(outcomes.map((result) => result.status)).toEqual([
		"fulfilled",
		"rejected",
		"fulfilled",
	]);
});
