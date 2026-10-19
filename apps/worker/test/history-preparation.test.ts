import type {
	AuthorizationContext,
	FileCommand,
} from "@obsidian-ai-bridge/protocol";
import { prepareHistoryCommand } from "@worker/application/history";
import { describe, expect, it } from "vitest";

const context: AuthorizationContext = {
	client_id: "client-a",
	grant_id: "grant-a",
	scopes: ["vault:write"],
};
const epoch = "a".repeat(32);

/** Hashes fixture bytes so each command carries a hand-controlled valid digest. */
async function digest(bytes: Uint8Array): Promise<string> {
	const result = await crypto.subtle.digest(
		"SHA-256",
		bytes.slice().buffer as ArrayBuffer,
	);
	return Array.from(new Uint8Array(result), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Builds authority metadata for metadata-only history commands. */
function intent<T extends "rename" | "restore">(
	op: T,
	paths: string[],
	payload_hash: string,
	size: number,
) {
	return {
		op,
		epoch,
		paths,
		precondition: { kind: "match" as const, etag: `"${epoch}.1"` },
		payload_hash,
		size,
	};
}

describe("prepareHistoryCommand", () => {
	it("binds canonical rename destination and restore revision and flag", async () => {
		/** Builds a rename command with identity bytes derived from its canonical body. */
		const rename = async (
			to: string,
			observedEpoch = epoch,
			revision = 1,
			authorization: AuthorizationContext = context,
		) => {
			const bytes = new TextEncoder().encode(JSON.stringify({ to }));
			const command: FileCommand = {
				op: "rename",
				body: { to },
				intent: {
					...intent(
						"rename",
						["from.md", to],
						await digest(bytes),
						bytes.byteLength,
					),
					epoch: observedEpoch,
					precondition: {
						kind: "match",
						etag: `"${observedEpoch}.${revision}"`,
					},
				},
			};
			return prepareHistoryCommand(authorization, command);
		};
		expect((await rename("to.md")).operation.fingerprint).not.toBe(
			(await rename("other.md")).operation.fingerprint,
		);
		expect((await rename("to.md")).operation.fingerprint).not.toBe(
			(await rename("to.md", "b".repeat(32))).operation.fingerprint,
		);
		expect((await rename("to.md")).operation.fingerprint).not.toBe(
			(await rename("to.md", epoch, 2)).operation.fingerprint,
		);
		expect((await rename("to.md")).operation.fingerprint).not.toBe(
			(await rename("to.md", epoch, 1, { ...context, client_id: "client-b" }))
				.operation.fingerprint,
		);

		/** Builds a restore command with canonical optional-flag encoding. */
		const restore = async (source_rev: number, as_conflict_copy = false) => {
			const body = { source_rev, as_conflict_copy };
			const bytes = new TextEncoder().encode(JSON.stringify(body));
			const command: FileCommand = {
				op: "restore",
				body,
				intent: intent(
					"restore",
					["from.md"],
					await digest(bytes),
					bytes.byteLength,
				),
			};
			return prepareHistoryCommand(context, command);
		};
		expect((await restore(4)).operation.fingerprint).not.toBe(
			(await restore(5)).operation.fingerprint,
		);
		expect((await restore(4)).operation.fingerprint).not.toBe(
			(await restore(4, true)).operation.fingerprint,
		);
	});

	it("copies command and authorization data before asynchronous hashing", async () => {
		const body = { to: "to.md" };
		const bytes = new TextEncoder().encode(JSON.stringify(body));
		const source = ["from.md", "to.md"];
		const command: FileCommand = {
			op: "rename",
			body,
			intent: {
				...intent("rename", source, await digest(bytes), bytes.byteLength),
			},
		};
		const caller = { ...context };
		const pending = prepareHistoryCommand(caller, command);
		body.to = "changed.md";
		source[1] = "changed.md";
		caller.client_id = "changed-client";
		const prepared = await pending;
		expect(prepared.command.op === "rename" && prepared.command.body.to).toBe(
			"to.md",
		);
		expect(prepared.operation.client_id).toBe("client-a");
	});

	it("binds exact append UTF-8 bytes and rejects a forged descriptor hash", async () => {
		const content = "é";
		const bytes = new TextEncoder().encode(content);
		const valid: FileCommand = {
			op: "append",
			content,
			key: "key-123456",
			intent: {
				op: "append",
				epoch,
				paths: ["note.md"],
				precondition: { kind: "none" },
				payload_hash: await digest(bytes),
				size: bytes.byteLength,
			},
		};
		const prepared = await prepareHistoryCommand(context, valid);
		const changedContent = "e";
		const changedBytes = new TextEncoder().encode(changedContent);
		const changed = await prepareHistoryCommand(context, {
			...valid,
			content: changedContent,
			intent: {
				...valid.intent,
				payload_hash: await digest(changedBytes),
				size: changedBytes.byteLength,
			},
		});
		expect(prepared.operation.fingerprint).not.toBe(
			changed.operation.fingerprint,
		);
		await expect(
			prepareHistoryCommand(context, {
				...valid,
				intent: { ...valid.intent, payload_hash: "0".repeat(64) },
			}),
		).rejects.toThrow();
	});
});
