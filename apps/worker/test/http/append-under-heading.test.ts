import { env, runInDurableObject, SELF } from "cloudflare:test";
import {
	formatETag,
	TextReadResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";
import {
	seedLiveTextState,
	TEXT_FIXTURE_EPOCH,
} from "@worker/test-fixtures/text-files";
import { beforeEach, describe, expect, it } from "vitest";

/** Isolated route fixture path for the heading mutation cases. */
const path = "notes/heading-append.md";
/** Route URL with the operation suffix after the encoded file path. */
const url = `https://worker.invalid/v1/files/${path}:append-under-heading`;

/** Reset the isolated Worker vault before each route-level heading append case. */
describe("append under a heading HTTP mutation", () => {
	beforeEach(async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, async (_instance, state) => {
			clearTestVault(state.storage);
			state.storage.sql.exec("PRAGMA foreign_keys = ON");
			initializeVaultStorage(
				state.storage,
				() => TEXT_FIXTURE_EPOCH,
				() => 10_000,
			);
		});
	});

	it("adds UTF-8 text to the first exact heading and publishes one revision", async () => {
		const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
		await runInDurableObject(stub, (_instance, state) =>
			seedLiveTextState(state.storage, {
				path,
				content:
					"# Main\r\n## Tasks\r\nfirst\r\n## Tasks\r\nsecond\r\n# Later\r\nend\r\n",
			}),
		);
		const response = await SELF.fetch(url, {
			method: "POST",
			headers: {
				"If-Match": formatETag(TEXT_FIXTURE_EPOCH, 1),
				"Idempotency-Key": "heading-append-key-01",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ heading: "Tasks", text: "追加" }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).toBe(
			formatETag(TEXT_FIXTURE_EPOCH, 2),
		);
		await response.json();
		const updated = await SELF.fetch(
			`https://worker.invalid/v1/files/${path}`,
			{
				headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
			},
		);
		expect(TextReadResponseSchema.parse(await updated.json()).content).toBe(
			"# Main\r\n## Tasks\r\nfirst\r\n追加\r\n## Tasks\r\nsecond\r\n# Later\r\nend\r\n",
		);
		const published = await runInDurableObject(stub, (_instance, state) => ({
			revisions: state.storage.sql
				.exec("SELECT rev FROM revisions WHERE path = ? ORDER BY rev", path)
				.toArray(),
			changes: state.storage.sql
				.exec("SELECT op, rev FROM changes WHERE path = ? ORDER BY seq", path)
				.toArray(),
		}));
		expect(published.revisions).toEqual([{ rev: 1 }, { rev: 2 }]);
		expect(published.changes).toHaveLength(2);
		expect(published.changes[1]).toMatchObject({ op: "put", rev: 2 });
	});

	it("returns a typed missing-heading failure without publishing a revision", async () => {
		await seed(path, "# Tasks\nbody\n");
		const before = await snapshot();
		const response = await submit("tasks", "added");
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: "heading_not_found" });
		expect(await snapshot()).toEqual(before);
	});

	it("refuses an obsolete ETag without changing the current revision", async () => {
		await seed(path, "# Tasks\nbody\n", 2);
		const before = await snapshot();
		const response = await submit("Tasks", "added", 1);
		expect(response.status).toBe(412);
		await response.json();
		expect(await snapshot()).toEqual(before);
	});

	it("inserts at EOF and ignores heading-shaped lines in fenced code", async () => {
		await seed(path, "```md\n# Tasks\n```\n# Tasks");
		const response = await submit("Tasks", "last");
		expect(response.status).toBe(200);
		await response.json();
		const read = await SELF.fetch(`https://worker.invalid/v1/files/${path}`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(TextReadResponseSchema.parse(await read.json()).content).toBe(
			"```md\n# Tasks\n```\n# Tasks\nlast",
		);
	});

	it("preserves mixed line endings around the insertion boundary", async () => {
		await seed(path, "# Main\r\n## Tasks\nbody\r# Next\nnext");
		const response = await submit("Tasks", "added");
		expect(response.status).toBe(200);
		await response.json();
		const read = await SELF.fetch(`https://worker.invalid/v1/files/${path}`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(TextReadResponseSchema.parse(await read.json()).content).toBe(
			"# Main\r\n## Tasks\nbody\radded\r# Next\nnext",
		);
	});

	it("replays its original receipt after an intervening edit", async () => {
		await seed(path, "# Tasks\nbody\n");
		const first = await submit("Tasks", "added");
		const firstEtag = first.headers.get("ETag");
		const intervening = await SELF.fetch(
			`https://worker.invalid/v1/files/${path}`,
			{
				method: "PUT",
				headers: {
					"If-Match": firstEtag ?? "",
					"X-Vault-Epoch": TEXT_FIXTURE_EPOCH,
				},
				body: "# Tasks\nnewer\n",
			},
		);
		expect(first.status).toBe(200);
		await first.json();
		expect(intervening.status).toBe(200);
		await intervening.json();
		const replay = await submit("Tasks", "added");
		expect(replay.status).toBe(200);
		await replay.json();
		expect(replay.headers.get("ETag")).toBe(firstEtag);
		const read = await SELF.fetch(`https://worker.invalid/v1/files/${path}`, {
			headers: { "X-Vault-Epoch": TEXT_FIXTURE_EPOCH },
		});
		expect(TextReadResponseSchema.parse(await read.json()).content).toBe(
			"# Tasks\nnewer\n",
		);
	});

	it("rejects oversized results and missing idempotency keys", async () => {
		await seed(path, `# Tasks\n${"x".repeat(999_990)}`);
		const before = await snapshot();
		const oversized = await submit("Tasks", "0123456789");
		expect(oversized.status).toBe(413);
		await oversized.json();
		expect(await snapshot()).toEqual(before);
		const missingKey = await SELF.fetch(url, {
			method: "POST",
			headers: {
				"If-Match": formatETag(TEXT_FIXTURE_EPOCH, 1),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ heading: "Tasks", text: "no" }),
		});
		expect(missingKey.status).toBe(428);
		expect(await missingKey.json()).toMatchObject({
			error: "idempotency_key_required",
		});
	});
});

/** Seed one current text revision with its expected exact ETag. */
async function seed(notePath: string, content: string, revision = 1) {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
	await runInDurableObject(stub, (_instance, state) =>
		seedLiveTextState(state.storage, { path: notePath, content, revision }),
	);
}

/** Submit one operation with a stable key and an exact observed ETag. */
function submit(
	heading: string,
	text: string,
	revision = 1,
	key = "heading-append-key-01",
) {
	return SELF.fetch(url, {
		method: "POST",
		headers: {
			"If-Match": formatETag(TEXT_FIXTURE_EPOCH, revision),
			"Idempotency-Key": key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ heading, text }),
	});
}

/** Read durable rows that must stay unchanged after a rejected operation. */
async function snapshot() {
	const stub = env.VAULTS.get(env.VAULTS.idFromName("worker.invalid"));
	return runInDurableObject(stub, (_instance, state) => ({
		files: state.storage.sql
			.exec("SELECT * FROM files ORDER BY path")
			.toArray(),
		revisions: state.storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: state.storage.sql
			.exec("SELECT * FROM changes ORDER BY seq")
			.toArray(),
		receipts: state.storage.sql
			.exec("SELECT * FROM receipts ORDER BY client_id, key")
			.toArray(),
	}));
}
