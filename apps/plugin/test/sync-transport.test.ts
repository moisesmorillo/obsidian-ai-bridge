import { describe, expect, it } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";
import { UnsupportedRemoteTextError } from "../src/sync/remote-text";

/** Captures authenticated transport URLs and returns controlled protocol responses. */
class ResponseSession {
	calls: Array<{ path: string; options?: Record<string, unknown> }> = [];
	responses: Array<{
		status: number;
		headers: Record<string, string>;
		text: string;
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
});
