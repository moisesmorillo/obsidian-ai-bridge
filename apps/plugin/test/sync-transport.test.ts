import { describe, expect, it } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";

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
			headers: { etag: `"${epoch}.4"`, "x-vault-epoch": epoch },
			text: "\ufeffone\r\ntwo\n",
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
			headers: { etag: `"${epoch}.8"`, "x-vault-epoch": epoch },
			text: "current exact bytes",
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
