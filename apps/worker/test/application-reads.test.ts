import {
	type AdmissionCompletion,
	type AuthorizationContext,
	type ChangeEntry,
	encodeReadCursor,
	formatETag,
	type ManifestEntry,
	type MetadataBatchRequest,
	parseETag,
} from "@obsidian-ai-bridge/protocol";
import {
	openChangesRead,
	openHistoryRead,
	openManifestRead,
	type ReadVaultGateway,
	readChanges,
	readHistory,
	readManifest,
} from "@worker/application/reads";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const context: AuthorizationContext = {
	client_id: "reads-app-client",
	grant_id: "reads-app-grant",
	scopes: ["vault:read"],
};

/** Build one valid live manifest row with a stable ordered path. */
function manifestRow(index: number): ManifestEntry {
	const path = `files/${String(index).padStart(4, "0")}.md`;
	return {
		path,
		etag: formatETag(epoch, 1),
		seq: index + 1,
		hash: "a".repeat(64),
		size: 1,
		kind: "text",
		deleted: false,
		large: false,
	};
}

/** Create a typed in-memory gateway that applies native 64-row keyset limits. */
function manifestGateway(rows: ManifestEntry[]) {
	const state = {
		batches: 0,
		finished: [] as AdmissionCompletion[],
		limits: [] as number[],
	};
	const gateway: ReadVaultGateway = {
		authorize: async () => ({
			ok: true,
			ticket: { id: "11111111111111111111111111111111", expires_at: 90_000 },
		}),
		finishAdmission: async (_context, _ticketId, completion) => {
			state.finished.push(completion);
			return { ok: true };
		},
		readVault: async () => ({
			ok: true as const,
			body: {
				epoch,
				head_seq: rows.length,
				counts: { live: rows.length, deleted: 0 },
				limits: {
					manifest_page: 256 as const,
					feed_page: 1000 as const,
					text_bytes: 1_000_000 as const,
					blob_bytes: 25_000_000 as const,
				},
				capacity: {
					database_bytes: 0,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: 0,
					referenced_blob_bytes: 0,
				},
				attention: [],
			},
		}),
		readBatch: async (
			_context: AuthorizationContext,
			request: MetadataBatchRequest,
		) => {
			state.batches += 1;
			state.limits.push(request.limit);
			if (request.collection !== "manifest")
				throw new Error("Expected a manifest batch");
			const matching = rows.filter(
				(row) => request.after_path === null || row.path > request.after_path,
			);
			return {
				ok: true as const,
				body: {
					collection: "manifest" as const,
					rows: matching.slice(0, request.limit + 1),
				},
			};
		},
		readHistoryUpper: async () => ({
			ok: true as const,
			body: { epoch, head_seq: rows.length, upper_etag: formatETag(epoch, 1) },
		}),
	};
	return { gateway, state };
}

/** Build one retained revision row in canonical ascending order. */
function historyRow(rev: number) {
	return {
		path: "files/history.md",
		rev,
		hash: "b".repeat(64),
		size: 1,
		deleted: false,
		origin: "device",
		at: rev,
	};
}

/** Create a typed fake that enforces history seek bounds and one lookahead row. */
function historyGateway(rows: ReturnType<typeof historyRow>[]) {
	let finished = 0;
	const gateway: ReadVaultGateway = {
		authorize: async () => ({
			ok: true,
			ticket: { id: "22222222222222222222222222222222", expires_at: 90_000 },
		}),
		finishAdmission: async () => {
			finished += 1;
			return { ok: true };
		},
		readVault: async () => ({
			ok: true as const,
			body: {
				epoch,
				head_seq: rows.length,
				counts: { live: 1, deleted: 0 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				capacity: {
					database_bytes: 0,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: 0,
					referenced_blob_bytes: 0,
				},
				attention: [],
			},
		}),
		readHistoryUpper: async () => ({
			ok: true as const,
			body: {
				epoch,
				head_seq: rows.length,
				upper_etag: formatETag(epoch, rows.length),
			},
		}),
		readBatch: async (_context, request) => {
			if (request.collection !== "history")
				throw new Error("Expected history batch");
			return {
				ok: true as const,
				body: {
					collection: "history" as const,
					rows: rows
						.filter(
							(row) =>
								row.rev > (request.after_rev ?? 0) &&
								row.rev <= parseETag(request.upper_etag).rev,
						)
						.slice(0, request.limit + 1),
				},
			};
		},
	};
	return { gateway, finished: () => finished };
}

/** Build one immutable feed row with a sequence-bound identity. */
function changeRow(seq: number): ChangeEntry {
	return {
		seq,
		op: "put",
		path: `files/change-${String(seq).padStart(4, "0")}.md`,
		etag: formatETag(epoch, 1),
		hash: "c".repeat(64),
		origin: "device",
		at: seq,
	};
}

/** Create a typed fake that enforces feed keysets and captured-head limits. */
function changesGateway(rows: ChangeEntry[]) {
	let finished = 0;
	const gateway: ReadVaultGateway = {
		authorize: async () => ({
			ok: true,
			ticket: { id: "33333333333333333333333333333333", expires_at: 90_000 },
		}),
		finishAdmission: async () => {
			finished += 1;
			return { ok: true };
		},
		readVault: async () => ({
			ok: true as const,
			body: {
				epoch,
				head_seq: rows.at(-1)?.seq ?? 0,
				counts: { live: rows.length, deleted: 0 },
				limits: {
					manifest_page: 256,
					feed_page: 1000,
					text_bytes: 1_000_000,
					blob_bytes: 25_000_000,
				},
				capacity: {
					database_bytes: 0,
					database_limit_bytes: 2_000_000_000,
					live_file_limit: 10_000,
					history_pressure_bytes: 0,
					referenced_blob_bytes: 0,
				},
				attention: [],
			},
		}),
		readHistoryUpper: async () => ({
			ok: true as const,
			body: { epoch, head_seq: 0, upper_etag: null },
		}),
		readBatch: async (_context, request) => {
			if (request.collection !== "changes")
				throw new Error("Expected changes batch");
			return {
				ok: true as const,
				body: {
					collection: "changes" as const,
					rows: rows
						.filter(
							(row) =>
								row.seq > request.after_seq && row.seq <= request.head_seq,
						)
						.slice(0, request.limit + 1),
				},
			};
		},
	};
	return { gateway, finished: () => finished };
}

describe("application bounded read traversal", () => {
	it("opens a manifest session before data demand and reads one bounded batch on demand", async () => {
		const rows = Array.from({ length: 130 }, (_, index) => manifestRow(index));
		const { gateway, state } = manifestGateway(rows);
		const session = await openManifestRead(gateway, context);
		expect(session.ok).toBe(true);
		if (!session.ok) return;
		expect(state.batches).toBe(0);
		expect(session.body.body).toEqual({ epoch, head_seq: rows.length });
		expect(state.batches).toBe(0);
		const first = await session.body.readBatch();
		expect(first.rows).toEqual(rows.slice(0, 64));
		expect(first.done).toBe(false);
		expect(state.batches).toBe(1);
		await session.body.cancel();
		await session.finish("settled");
	});
	it("opens history and feed sessions without batch demand", async () => {
		const history = historyGateway(
			Array.from({ length: 130 }, (_, i) => historyRow(i + 1)),
		);
		const feed = changesGateway(
			Array.from({ length: 130 }, (_, i) => changeRow(i + 1)),
		);
		for (const gateway of [history.gateway, feed.gateway]) {
			const original = gateway.readBatch;
			let calls = 0;
			gateway.readBatch = async (...args) => {
				calls++;
				return original(...args);
			};
			const opened =
				gateway === history.gateway
					? await openHistoryRead(gateway, context, "files/history.md")
					: await openChangesRead(gateway, context, epoch, 0);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(calls).toBe(0);
			expect((await opened.body.readBatch()).rows).toHaveLength(64);
			expect(calls).toBe(1);
			await opened.body.cancel();
			await opened.finish("settled");
		}
	});

	it("consumes lookahead rows without shortening or skipping a 256-entry page", async () => {
		const rows = Array.from({ length: 257 }, (_, index) => manifestRow(index));
		const { gateway, state } = manifestGateway(rows);
		const first = await readManifest(gateway, context);
		expect(first).toMatchObject({ ok: true });
		if (!first.ok) return;
		expect(first.body.entries.map((row) => row.path)).toEqual(
			rows.slice(0, 256).map((row) => row.path),
		);
		expect(first.body.next_page).toBeTypeOf("string");
		expect(state.finished).toEqual([]);
		const second = await readManifest(
			gateway,
			context,
			first.body.next_page ?? undefined,
		);
		expect(second).toMatchObject({ ok: true });
		if (!second.ok) return;
		expect(second.body.entries.map((row) => row.path)).toEqual([
			rows[256].path,
		]);
		expect(second.body.next_page).toBeNull();
		expect(state.finished).toEqual([]);
		expect(state.limits.every((limit) => limit >= 1 && limit <= 64)).toBe(true);
		expect(state.batches).toBeGreaterThan(4);
		await first.finish("settled");
		await first.finish("uncertain");
		await second.finish("settled");
		expect(state.finished).toEqual(["settled", "settled"]);
	});

	it.each([64, 65, 255, 256, 257])(
		"preserves exact manifest pagination at %i rows",
		async (count) => {
			const rows = Array.from({ length: count }, (_, index) =>
				manifestRow(index),
			);
			const { gateway } = manifestGateway(rows);
			const first = await readManifest(gateway, context);
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			expect(first.body.entries.map((row) => row.path)).toEqual(
				rows.slice(0, 256).map((row) => row.path),
			);
			if (count > 256) {
				expect(first.body.next_page).not.toBeNull();
				const second = await readManifest(
					gateway,
					context,
					first.body.next_page ?? undefined,
				);
				expect(second.ok).toBe(true);
				if (!second.ok) return;
				expect(second.body.entries.map((row) => row.path)).toEqual(
					rows.slice(256).map((row) => row.path),
				);
				await second.finish("settled");
			} else {
				expect(first.body.next_page).toBeNull();
			}
			await first.finish("settled");
		},
	);

	it("traverses 257 history rows without losing the lookahead or upper bound", async () => {
		const rows = Array.from({ length: 257 }, (_, index) =>
			historyRow(index + 1),
		);
		const { gateway } = historyGateway(rows);
		const first = await readHistory(gateway, context, "files/history.md");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(
			first.body.entries.map((entry) => parseETag(entry.etag).rev),
		).toEqual(rows.slice(0, 256).map((row) => row.rev));
		expect(first.body.next_page).not.toBeNull();
		const second = await readHistory(
			gateway,
			context,
			"files/history.md",
			first.body.next_page ?? undefined,
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(
			second.body.entries.map((entry) => parseETag(entry.etag).rev),
		).toEqual([257]);
		await first.finish("settled");
		await second.finish("settled");
	});

	it("traverses 1,001 feed rows in 1,000 and one entry pages", async () => {
		const rows = Array.from({ length: 1001 }, (_, index) =>
			changeRow(index + 1),
		);
		const { gateway } = changesGateway(rows);
		const first = await readChanges(gateway, context, epoch, 0);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.body.entries.map((entry) => entry.seq)).toEqual(
			rows.slice(0, 1000).map((row) => row.seq),
		);
		const second = await readChanges(gateway, context, epoch, 1000);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.body.entries.map((entry) => entry.seq)).toEqual([1001]);
		await first.finish("settled");
		await second.finish("settled");
	});

	it("keeps the read ticket until background work and response production settle", async () => {
		const { gateway, state } = manifestGateway([manifestRow(0)]);
		const session = await readManifest(gateway, context);
		expect(session.ok).toBe(true);
		if (!session.ok) return;
		/** Release the started asynchronous read work. */
		let releaseWork = () => {};
		/** Release response-body production after its final read. */
		let releaseResponse = () => {};
		const work = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		const responseProduction = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const settlement = (async () => {
			await Promise.all([work, responseProduction]);
			return session.finish("settled");
		})();
		releaseWork();
		await Promise.resolve();
		expect(state.finished).toEqual([]);
		releaseResponse();
		await settlement;
		expect(state.finished).toEqual(["settled"]);
	});

	it("returns epoch mismatch for an old valid manifest cursor", async () => {
		const cursor = encodeReadCursor({
			version: 1,
			kind: "manifest",
			epoch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			head_seq: 0,
			last_path: "files/old.md",
		});
		const { gateway } = manifestGateway([]);
		const result = await readManifest(gateway, context, cursor);
		expect(result).toEqual({
			ok: false,
			failure: { kind: "epoch_mismatch", current_epoch: epoch },
		});
	});

	it("maps malformed, wrong-collection, and wrong-path cursors to invalid request", async () => {
		const { gateway } = manifestGateway([]);
		const historyCursor = encodeReadCursor({
			version: 1,
			kind: "history",
			epoch,
			head_seq: 0,
			path: "files/history.md",
			upper_etag: formatETag(epoch, 1),
			last_etag: formatETag(epoch, 1),
		});
		const wrongKind = await readManifest(gateway, context, historyCursor);
		expect(wrongKind).toEqual({
			ok: false,
			failure: { kind: "invalid_request" },
		});
		const malformed = await readManifest(gateway, context, "not-a-cursor");
		expect(malformed).toEqual({
			ok: false,
			failure: { kind: "invalid_request" },
		});
		const history = historyGateway([historyRow(1)]);
		const wrongPathCursor = encodeReadCursor({
			version: 1,
			kind: "history",
			epoch,
			head_seq: 1,
			path: "files/other.md",
			upper_etag: formatETag(epoch, 1),
			last_etag: formatETag(epoch, 1),
		});
		const wrongPath = await readHistory(
			history.gateway,
			context,
			"files/history.md",
			wrongPathCursor,
		);
		expect(wrongPath).toEqual({
			ok: false,
			failure: { kind: "invalid_request" },
		});
	});

	it("settles a read when revocation returns between application batches", async () => {
		const { gateway, state } = manifestGateway(
			Array.from({ length: 65 }, (_, index) => manifestRow(index)),
		);
		const readBatch = gateway.readBatch;
		let calls = 0;
		gateway.readBatch = async (...args) => {
			calls += 1;
			if (calls === 2) return { ok: false, failure: { kind: "revoked" } };
			return readBatch(...args);
		};
		const result = await readManifest(gateway, context);
		expect(result).toEqual({ ok: false, failure: { kind: "revoked" } });
		expect(calls).toBe(2);
		expect(state.finished).toEqual(["settled"]);
	});

	it("propagates unknown native failures without settling the active admission", async () => {
		const { gateway, state } = manifestGateway([manifestRow(0)]);
		gateway.readBatch = async () => {
			throw new Error("SQLite unavailable");
		};
		await expect(readManifest(gateway, context)).rejects.toThrow(
			"SQLite unavailable",
		);
		expect(state.finished).toEqual([]);
	});
});
