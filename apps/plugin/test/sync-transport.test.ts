import { describe, expect, it, vi } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";
import {
	SyncTransportError,
	UnsupportedRemoteTextError,
} from "../src/sync/remote-text";

/** Captures authenticated transport URLs and returns controlled protocol responses. */
class ResponseSession {
	calls: Array<{ path: string; options?: Record<string, unknown> }> = [];
	responses: Array<{
		status: number;
		headers: Record<string, string>;
		text: string;
		arrayBuffer?: ArrayBuffer;
	}> = [];

	/** Returns the next response without changing its text representation. */
	async requestResponse(path: string, options?: Record<string, unknown>) {
		this.calls.push({ path, options });
		const response = this.responses.shift();
		if (!response) throw new Error("missing response");
		return response;
	}
}

const epoch = "a".repeat(32);

describe("SyncTransport", () => {
	it("classifies a rejected delete response without retaining raw response data", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 400,
			headers: { etag: `"${epoch}.4"` },
			text: JSON.stringify({
				error: "invalid_request",
				message: "The request is not valid.",
			}),
		});
		const diagnostics: unknown[] = [];
		const transport = new SyncTransport(
			"https://service.test",
			session,
			undefined,
			(diagnostic) => diagnostics.push(diagnostic),
		);

		const error = await transport
			.delete(
				"oab-8.8/ac-04/shared.md",
				{ kind: "match", epoch, rev: 1 },
				"private-operation-key",
			)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SyncTransportError);
		expect(error).toMatchObject({
			statusClass: "4xx",
			code: "invalid_request",
			responseETagClass: "strong",
			message: "Sync request failed",
		});
		expect(Object.keys(error as object)).not.toContain("text");
		expect(JSON.stringify(error)).not.toContain("private-operation-key");
		expect(diagnostics).toEqual([
			{
				statusClass: "4xx",
				errorKind: "invalid_request",
				responseETagClass: "strong",
			},
		]);
		expect(JSON.stringify(diagnostics)).not.toContain("private-operation-key");
		expect(JSON.stringify(diagnostics)).not.toContain(
			"oab-8.8/ac-04/shared.md",
		);
	});

	it("captures strong ETag class for a successful delete receipt", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: { etag: `"${epoch}.2"` },
			text: JSON.stringify({
				path: "oab-8.8/ac-04/shared.md",
				etag: `"${epoch}.2"`,
				seq: 2,
				size: 0,
				hash: "",
				deleted: true,
			}),
		});
		const diagnostics: unknown[] = [];
		const transport = new SyncTransport(
			"https://service.test",
			session,
			undefined,
			(diagnostic) => diagnostics.push(diagnostic),
		);

		await expect(
			transport.delete(
				"oab-8.8/ac-04/shared.md",
				{ kind: "match", epoch, rev: 1 },
				"private-operation-key",
			),
		).resolves.toMatchObject({ status: 200, deleted: true });
		expect(diagnostics).toEqual([
			{
				statusClass: "2xx",
				errorKind: null,
				responseETagClass: "strong",
			},
		]);
	});

	it("redacts a noncanonical response body and classifies a weak ETag", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 400,
			headers: { etag: 'W/"private-value"' },
			text: JSON.stringify({
				error: "invalid_request",
				message: "private token must not appear",
			}),
		});
		const transport = new SyncTransport("https://service.test", session);

		const error = await transport
			.delete(
				"oab-8.8/ac-04/shared.md",
				{ kind: "match", epoch, rev: 1 },
				"private-operation-key",
			)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			statusClass: "4xx",
			code: null,
			responseETagClass: "weak",
			message: "Sync request failed",
		});
		expect(JSON.stringify(error)).not.toContain("private token");
		expect(JSON.stringify(error)).not.toContain("private-value");
	});

	it("reads and validates exact current blob bytes for rename recovery", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 254, 7]);
		const result = await crypto.subtle.digest("SHA-256", bytes);
		const hash = [...new Uint8Array(result)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
				"content-length": String(bytes.byteLength),
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readCurrentBlobAuthority("assets/a.png"),
		).resolves.toEqual({
			kind: "blob",
			bytes,
			epoch,
			rev: 4,
			hash,
		});
		expect(session.calls[0]?.path).toContain("/v1/files/assets/a.png");
	});

	it("reads current blob authority when Content-Length is absent", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 254, 7]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readCurrentBlobAuthority("assets/a.png"),
		).resolves.toEqual({ kind: "blob", bytes, epoch, rev: 4, hash });
	});

	it.each(["", "3x", "02", "2"])(
		"rejects a present invalid Content-Length %j",
		async (contentLength) => {
			const session = new ResponseSession();
			const bytes = new Uint8Array([0, 254, 7]);
			session.responses.push({
				status: 200,
				headers: {
					etag: `"${epoch}.4"`,
					"content-type": "application/octet-stream",
					"content-length": contentLength,
				},
				text: "",
				arrayBuffer: bytes.slice().buffer,
			});
			const transport = new SyncTransport("https://service.test", session);

			await expect(
				transport.readCurrentBlobAuthority("assets/a.png"),
			).rejects.toThrow("Current blob authority metadata is invalid");
		},
	);

	it("rejects current blob authority without response bytes", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "",
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readCurrentBlobAuthority("assets/a.png"),
		).rejects.toThrow("Current blob authority metadata is invalid");
	});

	it("rejects oversized current blob authority without Content-Length", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "",
			arrayBuffer: new ArrayBuffer(25_000_001),
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readCurrentBlobAuthority("assets/a.png"),
		).rejects.toThrow("Current blob authority metadata is invalid");
	});

	it("reads exact pinned text with epoch and revision metadata", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: { etag: `"${epoch}.4"` },
			text: JSON.stringify({
				path: "notes/a.md",
				etag: `"${epoch}.4"`,
				hash: "f21b0b2a0b8adfd546237044de0a277601f25f9304d916e1922d4e59decf6e0f",
				size: 12,
				kind: "text",
				deleted: false,
				origin: "client",
				updated_at: 0,
				content: "\ufeffone\r\ntwo\n",
				offset: 0,
				length: 10,
				truncated: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(transport.readPinned("notes/a.md", epoch, 4)).resolves.toEqual(
			{
				text: "\ufeffone\r\ntwo\n",
				epoch,
				rev: 4,
			},
		);
		expect(session.calls[0]?.path).toContain("rev=4");
		expect(session.calls[0]?.options?.headers).toEqual({
			"x-vault-epoch": epoch,
		});
	});

	it("rejects a partial JSON read as a full pinned revision", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: { etag: `"${epoch}.4"` },
			text: JSON.stringify({
				path: "notes/a.md",
				etag: `"${epoch}.4"`,
				hash: "c".repeat(64),
				size: 7,
				kind: "text",
				deleted: false,
				origin: "device",
				updated_at: 1,
				content: "art",
				offset: 1,
				length: 3,
				truncated: true,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(transport.readPinned("notes/a.md", epoch, 4)).rejects.toThrow(
			"Pinned text revision does not match its request",
		);
	});

	it("classifies blob reads from authoritative response headers without decoding bytes", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "\\xff\\xfe\\x00",
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.readPinned("notes/file.pdf", epoch, 4),
		).rejects.toBeInstanceOf(UnsupportedRemoteTextError);
	});

	it("rejects current text when its declared digest does not match its bytes", async () => {
		const session = new ResponseSession();
		const etag = `"${epoch}.8"`;
		session.responses.push({
			status: 200,
			headers: { etag },
			text: JSON.stringify({
				path: "notes/a.md",
				etag,
				hash: "d".repeat(64),
				size: 5,
				kind: "text",
				deleted: false,
				origin: "client",
				updated_at: 0,
				content: "bytes",
				offset: 0,
				length: 5,
				truncated: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(transport.readCurrentAuthority("notes/a.md")).rejects.toThrow(
			"Current text metadata is invalid",
		);
	});

	it("replaces a pruned pinned read with current text identity", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: {},
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		session.responses.push({
			status: 200,
			headers: { etag: `"${epoch}.8"` },
			text: JSON.stringify({
				path: "notes/a.md",
				etag: `"${epoch}.8"`,
				hash: "576d3aa0ea3c7f6c576bb1f2d1d3764a25ba31cb4c475f199a69173db1dde243",
				size: 19,
				kind: "text",
				deleted: false,
				origin: "client",
				updated_at: 0,
				content: "current exact bytes",
				offset: 0,
				length: 19,
				truncated: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		const readResolved = Reflect.get(transport, "readResolved") as (
			path: string,
			epoch: string,
			rev: number,
		) => Promise<unknown>;
		await expect(
			readResolved.call(transport, "notes/a.md", epoch, 4),
		).resolves.toMatchObject({
			text: "current exact bytes",
			epoch,
			rev: 8,
		});
		expect(session.calls).toHaveLength(2);
	});

	it("accepts a canonical current text tombstone after a pruned pinned read", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: {},
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		const etag = `"${epoch}.8"`;
		session.responses.push({
			status: 200,
			headers: { etag, "content-type": "application/json" },
			text: JSON.stringify({
				path: "notes/a.md",
				etag,
				hash: "",
				size: 0,
				kind: "text",
				deleted: true,
				origin: "device",
				updated_at: 1,
				content: null,
				offset: 0,
				length: 0,
				truncated: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.readResolved("notes/a.md", epoch, 4),
		).resolves.toEqual({
			deleted: true,
			text: null,
			epoch,
			rev: 8,
			hash: "",
		});
	});

	it("preserves BOM, CRLF, and Unicode in production-JSON prune fallback", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: {},
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		const text = "\ufeffline\r\nUnicode café\n";
		session.responses.push({
			status: 200,
			headers: { etag: `"${epoch}.8"`, "content-type": "application/json" },
			text: JSON.stringify({
				path: "notes/a.md",
				etag: `"${epoch}.8"`,
				hash: "66878b79fa5614ae19f24ea55599b422eda27ef672dfe76e4e79ca3a3d8d182d",
				size: 23,
				kind: "text",
				deleted: false,
				origin: "device",
				updated_at: 1,
				content: text,
				offset: 0,
				length: text.length,
				truncated: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		const readResolved = Reflect.get(transport, "readResolved") as (
			path: string,
			epoch: string,
			rev: number,
		) => Promise<unknown>;
		await expect(
			readResolved.call(transport, "notes/a.md", epoch, 4),
		).resolves.toMatchObject({ text, epoch, rev: 8 });
	});

	it("sends create-only mutation epoch and validates its canonical receipt", async () => {
		const session = new ResponseSession();
		const etag = `"${epoch}.5"`;
		session.responses.push({
			status: 201,
			headers: { etag },
			text: JSON.stringify({
				path: "notes/a.md",
				etag,
				seq: 7,
				hash: "c".repeat(64),
				size: 4,
				deleted: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.put(
				"notes/a.md",
				"text",
				{ kind: "absent" },
				"operation-key",
				epoch,
			),
		).resolves.toEqual({
			status: 201,
			path: "notes/a.md",
			etag,
			seq: 7,
			size: 4,
			hash: "c".repeat(64),
			deleted: false,
		});
		expect(session.calls[0]?.options?.headers).toEqual({
			"if-none-match": "*",
			"x-vault-epoch": epoch,
			"idempotency-key": "operation-key",
		});
	});

	it("sends delete and rename with their exact source ETag preconditions", async () => {
		const session = new ResponseSession();
		const deleteEtag = `"${epoch}.5"`;
		const renameEtag = `"${epoch}.6"`;
		session.responses.push(
			{
				status: 200,
				headers: { etag: deleteEtag },
				text: JSON.stringify({
					path: "notes/a.md",
					etag: deleteEtag,
					seq: 8,
					hash: "",
					size: 0,
					deleted: true,
				}),
			},
			{
				status: 201,
				headers: { etag: renameEtag },
				text: JSON.stringify({
					path: "notes/b.md",
					etag: renameEtag,
					seq: 9,
					hash: "c".repeat(64),
					size: 4,
					deleted: false,
				}),
			},
		);
		const transport = new SyncTransport("https://service.test", session);
		const precondition = { kind: "match" as const, epoch, rev: 4 };

		await transport.delete("notes/a.md", precondition, "delete-key");
		await transport.rename(
			"notes/a.md",
			"notes/b.md",
			precondition,
			"rename-key",
		);

		expect(session.calls[0]?.options?.headers).toEqual({
			"if-match": `"${epoch}.4"`,
			"x-vault-epoch": epoch,
			"idempotency-key": "delete-key",
		});
		expect(session.calls[1]?.path).toBe(
			"https://service.test/v1/files/notes/a.md:rename",
		);
		expect(session.calls[1]?.options).toMatchObject({
			method: "POST",
			body: JSON.stringify({ to: "notes/b.md" }),
			headers: {
				"if-match": `"${epoch}.4"`,
				"x-vault-epoch": epoch,
				"idempotency-key": "rename-key",
			},
		});
	});

	it("preserves canonical status and code for a rename precondition failure", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 412,
			headers: {},
			text: JSON.stringify({
				error: "precondition_failed",
				message: "The file state does not match the precondition.",
				etag: `"${epoch}.6"`,
				hash: "",
				deleted: true,
				renamed_to: "notes/renamed.md",
			}),
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.rename(
				"notes/a.md",
				"notes/renamed.md",
				{
					kind: "match",
					epoch,
					rev: 4,
				},
				"rename-key",
			),
		).rejects.toMatchObject({
			status: 412,
			code: "precondition_failed",
		});
	});

	it("preserves canonical collision and retry details without response text", async () => {
		const collisionSession = new ResponseSession();
		collisionSession.responses.push({
			status: 409,
			headers: {},
			text: JSON.stringify({
				error: "path_collision",
				message: "Another file uses this path key.",
				existing_path: "notes/Existing.md",
			}),
		});
		const collisionTransport = new SyncTransport(
			"https://service.test",
			collisionSession,
		);
		await expect(
			collisionTransport.createText("notes/a.md", "text", epoch, "key"),
		).rejects.toMatchObject({
			message: "Sync request failed",
			status: 409,
			code: "path_collision",
			existingPath: "notes/Existing.md",
		});

		const limitedSession = new ResponseSession();
		limitedSession.responses.push({
			status: 429,
			headers: { "retry-after": "20" },
			text: JSON.stringify({
				error: "admission_limited",
				message: "The vault cannot accept another operation now.",
			}),
		});
		const limitedTransport = new SyncTransport(
			"https://service.test",
			limitedSession,
		);
		await expect(limitedTransport.vault()).rejects.toMatchObject({
			status: 429,
			code: "admission_limited",
			retryAfter: "20",
		});
	});

	it("preserves validated status and error code without exposing response text", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: {},
			text: JSON.stringify({
				error: "cursor_expired",
				message: "This read cursor is no longer valid.",
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(transport.vault()).rejects.toMatchObject({
			status: 410,
			code: "cursor_expired",
		});
	});

	it("reads pinned binary bytes only when identity, size, and digest match", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
				"content-length": "3",
			},
			text: "",
			arrayBuffer: bytes.buffer.slice(0),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.readPinnedBlob("notes/a.png", epoch, 4, hash),
		).resolves.toEqual({
			bytes,
			hash,
			epoch,
			rev: 4,
		});
	});

	it("reads pinned blob bytes when Content-Length is absent", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readPinnedBlob("notes/a.png", epoch, 4, hash),
		).resolves.toEqual({ bytes, hash, epoch, rev: 4 });
	});

	it("rejects pinned binary bytes with a bad declared digest", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
				"content-length": "2",
			},
			text: "",
			arrayBuffer: new Uint8Array([0, 255]).buffer,
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.readPinnedBlob("notes/a.png", epoch, 4, "a".repeat(64)),
		).rejects.toThrow("Pinned blob response metadata is invalid");
	});

	it("reads resolved pinned blob bytes when Content-Length is absent", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readResolvedBlob("notes/a.png", epoch, 4, hash),
		).resolves.toEqual({ kind: "blob", bytes, hash, epoch, rev: 4 });
	});

	it("rejects resolved pinned blob bytes with an unexpected hash", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 255, 128]);
		session.responses.push({
			status: 200,
			headers: {
				etag: `"${epoch}.4"`,
				"content-type": "application/octet-stream",
				"content-length": String(bytes.byteLength),
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readResolvedBlob("notes/a.png", epoch, 4, "c".repeat(64)),
		).rejects.toThrow("Pinned blob response metadata is invalid");
	});

	it("falls back from a pruned blob revision to the exact current binary bytes", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: { "content-type": "application/json" },
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(
				await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
			),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				"content-type": "application/octet-stream",
				"content-length": String(bytes.byteLength),
				etag: `"${epoch}.8"`,
				"x-vault-epoch": epoch,
			},
			text: "",
			arrayBuffer: bytes.buffer.slice(0),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.readResolvedBlob("notes/a.png", epoch, 4, "c".repeat(64)),
		).resolves.toEqual({
			kind: "blob",
			bytes,
			hash,
			epoch,
			rev: 8,
		});
	});

	it("reads current fallback blob bytes when Content-Length is absent", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: { "content-type": "application/json" },
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		session.responses.push({
			status: 200,
			headers: {
				"content-type": "application/octet-stream",
				etag: `"${epoch}.8"`,
				"x-vault-epoch": epoch,
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readResolvedBlob("notes/a.png", epoch, 4, "c".repeat(64)),
		).resolves.toEqual({ kind: "blob", bytes, hash, epoch, rev: 8 });
	});

	it("keeps equal-revision fallback bound to the expected hash without Content-Length", async () => {
		const session = new ResponseSession();
		session.responses.push({
			status: 410,
			headers: { "content-type": "application/json" },
			text: JSON.stringify({
				error: "revision_pruned",
				message: "This revision is no longer available.",
			}),
		});
		const bytes = new Uint8Array([0, 255, 128]);
		session.responses.push({
			status: 200,
			headers: {
				"content-type": "application/octet-stream",
				etag: `"${epoch}.4"`,
				"x-vault-epoch": epoch,
			},
			text: "",
			arrayBuffer: bytes.slice().buffer,
		});
		const transport = new SyncTransport("https://service.test", session);

		await expect(
			transport.readResolvedBlob("notes/a.png", epoch, 4, "c".repeat(64)),
		).rejects.toThrow("Current blob fallback revision is not newer authority");
	});

	it("sends binary payload bytes with canonical integrity declarations", async () => {
		const session = new ResponseSession();
		const bytes = new Uint8Array([0, 255, 128]);
		const hash = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const etag = `"${epoch}.5"`;
		session.responses.push({
			status: 201,
			headers: { etag },
			text: JSON.stringify({
				path: "notes/a.png",
				etag,
				seq: 7,
				hash,
				size: bytes.byteLength,
				deleted: false,
			}),
		});
		const transport = new SyncTransport("https://service.test", session);
		await expect(
			transport.putBlob(
				"notes/a.png",
				bytes,
				hash,
				{ kind: "absent" },
				"key",
				epoch,
			),
		).resolves.toMatchObject({ hash, size: bytes.byteLength });
		const request = session.calls[0]?.options;
		expect(request?.body).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(request?.body as ArrayBuffer)).toEqual(bytes);
		expect(request?.headers).toMatchObject({
			"if-none-match": "*",
			"x-vault-epoch": epoch,
			"idempotency-key": "key",
			"x-content-sha256": hash,
			"x-content-size": "3",
		});
	});

	it("notifies lifecycle owners only for a validated revoked response", async () => {
		const session = new ResponseSession();
		const revoked = vi.fn();
		const transport = new SyncTransport(
			"https://service.test",
			session,
			revoked,
		);
		session.responses.push({
			status: 401,
			headers: {},
			text: JSON.stringify({
				error: "revoked",
				message: "The grant no longer allows access.",
			}),
		});
		await expect(transport.vault()).rejects.toMatchObject({
			status: 401,
			code: "revoked",
		});
		expect(revoked).toHaveBeenCalledOnce();
		session.responses.push({
			status: 401,
			headers: {},
			text: JSON.stringify({
				error: "invalid_token",
				message: "Expired token",
			}),
		});
		await expect(transport.vault()).rejects.toMatchObject({ status: 401 });
		expect(revoked).toHaveBeenCalledOnce();
	});
});
