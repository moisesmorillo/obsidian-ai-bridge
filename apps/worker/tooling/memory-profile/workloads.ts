/**
 * Portable OAB-53 memory-profile workloads.
 *
 * This module uses only Web platform APIs (`fetch`, streams, `crypto.subtle`, `TextEncoder`), so the
 * same workload definitions can run from Node against local workerd or from another client that can
 * supply a streaming `fetch` and a bearer token. It never reads credentials itself and never prints
 * response content. Every path it creates lives under {@link LOADTEST_PREFIX}.
 */

/** Folder that holds every file the profile seeds or uploads; cleanup deletes only this prefix. */
export const LOADTEST_PREFIX = "_vaultwire-loadtest/";
/** Maximum inline text size accepted by the Worker, in UTF-8 bytes (spec §6.5 and §12). */
export const MAX_TEXT_BYTES = 1_000_000;
/** Maximum blob size accepted by the Worker, in bytes (spec §12). */
export const MAX_BLOB_BYTES = 25_000_000;
/** Literal search term written into every seeded note. */
export const SEARCH_NEEDLE = "vaultwireneedle";

/** Service origin, bearer token, and streaming fetch used by every workload request. */
export interface ProfileTarget {
	/** Canonical service origin without a trailing slash, such as `https://service.test`. */
	readonly origin: string;
	/** OAuth access token with `vault:read vault:write vault:delete`; never logged. */
	readonly token: string;
	/** Streaming fetch implementation; defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
}

/** Sizes of the synthetic fixture set; production runs may lower the counts. */
export interface SeedOptions {
	/** Small notes created to fill `/v1/changes`, list, and search pages. */
	readonly smallNotes: number;
	/** Notes of exactly {@link MAX_TEXT_BYTES} UTF-8 bytes used by large text reads. */
	readonly largeNotes: number;
	/** Blob size, in bytes, for read, slow-read, and cancellation workloads. */
	readonly blobBytes: number;
}

/** Default fixture sizes for the local profile. */
export const DEFAULT_SEED: SeedOptions = {
	smallNotes: 300,
	largeNotes: 12,
	blobBytes: MAX_BLOB_BYTES,
};

/** Paths and epoch created by {@link seedFixtures}. */
export interface Fixtures {
	/** Vault epoch observed before seeding; mutations carry it. */
	readonly epoch: string;
	/** Paths of the maximum-size text notes. */
	readonly largeNotes: readonly string[];
	/** Path of the seeded blob. */
	readonly blob: string;
}

/** Outcome of one workload operation. `bytes` counts consumed response or sent request bytes. */
export interface OperationResult {
	/** HTTP status, or 0 when the request or its body read failed on the client. */
	readonly status: number;
	/** Consumed response bytes, or sent bytes for uploads. */
	readonly bytes: number;
	/** Client elapsed time from request start to body settlement, in milliseconds. */
	readonly ms: number;
}

/** Per-operation context; `sequence` is unique per level so uploads create distinct paths. */
export interface OperationContext {
	/** Level identifier: workload name, concurrency, and start time. */
	readonly level: string;
	/** Zero-based index of the concurrent worker loop. */
	readonly worker: number;
	/** Level-wide operation counter; it also serves as the MCP JSON-RPC id. */
	readonly sequence: number;
}

/** One named, repeatable request shape. */
export interface Workload {
	/** Stable name used in notes and tables. */
	readonly name: string;
	/** Category from the OAB-53 plan: rest, mcp, upload, slow, or cancel. */
	readonly category: "rest" | "mcp" | "upload" | "slow" | "cancel";
	/** Per-worker iteration cap; uploads use it to bound stored bytes. */
	readonly maxIterationsPerWorker?: number;
	/** Run one operation; must settle and release the response body before returning. */
	run(
		target: ProfileTarget,
		context: OperationContext,
	): Promise<OperationResult>;
}

/** Aggregate result of one workload at one concurrency. */
export interface LevelResult {
	readonly workload: string;
	/** Number of concurrent worker loops. */
	readonly concurrency: number;
	/** Level start, in Unix milliseconds. */
	readonly startedAt: number;
	/** Level end after every loop settled, in Unix milliseconds. */
	readonly endedAt: number;
	/** Completed operations, including refusals. */
	readonly operations: number;
	/** Count by HTTP status; status 0 means a client-side request or body failure. */
	readonly statuses: Record<string, number>;
	/** Total consumed or sent bytes; this is traffic volume, not simultaneous memory. */
	readonly bytes: number;
	/** Nearest-rank median client elapsed time, in milliseconds. */
	readonly medianMs: number;
	/** Maximum client elapsed time, in milliseconds. */
	readonly maxMs: number;
}

/** Resolve the fetch implementation for a target. */
function fetcher(target: ProfileTarget): typeof fetch {
	return target.fetch ?? fetch;
}

/** Build bearer headers merged with request-specific headers. */
function auth(
	target: ProfileTarget,
	headers: Record<string, string> = {},
): Record<string, string> {
	return { authorization: `Bearer ${target.token}`, ...headers };
}

/** Encode one vault path segment by segment for a `/v1/files` URL. */
function fileUrl(target: ProfileTarget, path: string): string {
	return `${target.origin}/v1/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Resolve after the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a response body to EOF and return the consumed byte count without retaining chunks. */
async function drain(response: Response): Promise<number> {
	if (!response.body) return 0;
	const reader = response.body.getReader();
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return bytes;
		bytes += value.byteLength;
	}
}

/** Run one request, drain its body, and time it; network failures map to status 0. */
async function timed(
	request: () => Promise<Response>,
	consume: (response: Response) => Promise<number> = drain,
): Promise<OperationResult> {
	const started = performance.now();
	try {
		const response = await request();
		const bytes = await consume(response);
		return { status: response.status, bytes, ms: performance.now() - started };
	} catch {
		return { status: 0, bytes: 0, ms: performance.now() - started };
	}
}

/** Return lowercase hexadecimal SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Build Markdown of exactly `bytes` UTF-8 bytes. Accented letters make V8 hold the decoded note as
 * a two-byte string, the conservative case for a Spanish-language vault. Quotes and newlines add
 * JSON escaping on MCP responses. Only the first line holds {@link SEARCH_NEEDLE}. A needle on
 * every line of 1 MB notes made one local search take about 15.6 s, which is not a realistic vault.
 */
export function markdownOfSize(bytes: number, seed: string): string {
	const head = `# "${SEARCH_NEEDLE}" ${seed}\n`;
	const line = `- "nota" ${seed} canción, añadir, información.\n`;
	const encoder = new TextEncoder();
	const unit = encoder.encode(line).byteLength;
	const body = line.repeat(
		Math.floor((bytes - encoder.encode(head).byteLength) / unit),
	);
	const text = head + body;
	return text + "x".repeat(bytes - encoder.encode(text).byteLength);
}

/** Read the current vault epoch through `GET /v1/vault`. */
export async function readEpoch(target: ProfileTarget): Promise<string> {
	const response = await fetcher(target)(`${target.origin}/v1/vault`, {
		headers: auth(target),
	});
	if (!response.ok)
		throw new Error(`vault summary returned ${response.status}`);
	const summary = (await response.json()) as { epoch: string };
	return summary.epoch;
}

/** Create one file with `If-None-Match: *`; accept an existing file (412) for idempotent seeding. */
async function createFile(
	target: ProfileTarget,
	epoch: string,
	path: string,
	body: Uint8Array | string,
	extra: Record<string, string> = {},
): Promise<number> {
	const response = await fetcher(target)(fileUrl(target, path), {
		method: "PUT",
		headers: auth(target, {
			"If-None-Match": "*",
			"X-Vault-Epoch": epoch,
			...extra,
		}),
		body,
	});
	await drain(response);
	return response.status;
}

/** Upload one blob with its declared hash and size. */
async function createBlob(
	target: ProfileTarget,
	epoch: string,
	path: string,
	bytes: Uint8Array,
): Promise<number> {
	return createFile(target, epoch, path, bytes, {
		"X-Content-SHA256": await sha256Hex(bytes),
		"X-Content-Size": String(bytes.byteLength),
	});
}

/** Return a deterministic blob whose bytes start with the given tag. */
function blobBytes(size: number, tag: string): Uint8Array {
	const bytes = new Uint8Array(size).fill(0x5a);
	bytes.set(new TextEncoder().encode(tag).subarray(0, Math.min(64, size)));
	return bytes;
}

/** Seed the fixture set under {@link LOADTEST_PREFIX}; existing files are kept. */
export async function seedFixtures(
	target: ProfileTarget,
	options: SeedOptions = DEFAULT_SEED,
): Promise<Fixtures> {
	const epoch = await readEpoch(target);
	const accepted = new Set([201, 412]);
	for (let index = 0; index < options.smallNotes; index++) {
		const status = await createFile(
			target,
			epoch,
			`${LOADTEST_PREFIX}small/${String(index).padStart(4, "0")}.md`,
			markdownOfSize(2_048, `small-${index}`),
		);
		if (!accepted.has(status)) throw new Error(`seed small note ${status}`);
	}
	const largeNotes: string[] = [];
	for (let index = 0; index < options.largeNotes; index++) {
		const path = `${LOADTEST_PREFIX}large/${String(index).padStart(2, "0")}.md`;
		const status = await createFile(
			target,
			epoch,
			path,
			markdownOfSize(MAX_TEXT_BYTES, `large-${index}`),
		);
		if (!accepted.has(status)) throw new Error(`seed large note ${status}`);
		largeNotes.push(path);
	}
	const blob = `${LOADTEST_PREFIX}blob/seed.bin`;
	const status = await createBlob(
		target,
		epoch,
		blob,
		blobBytes(options.blobBytes, "seed"),
	);
	if (!accepted.has(status)) throw new Error(`seed blob ${status}`);
	return { epoch, largeNotes, blob };
}

/** Post one stateless MCP `tools/call` request. */
function callTool(
	target: ProfileTarget,
	name: string,
	args: Record<string, unknown>,
	id: number,
): Promise<Response> {
	return fetcher(target)(`${target.origin}/mcp`, {
		method: "POST",
		headers: auth(target, {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		}),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

/** Read a body with a delay between chunks until EOF or `limitMs`, then cancel the remainder. */
function slowConsume(
	delayMs: number,
	limitMs: number,
): (response: Response) => Promise<number> {
	return async (response) => {
		if (!response.body) return 0;
		const reader = response.body.getReader();
		const deadline = performance.now() + limitMs;
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return bytes;
			bytes += value.byteLength;
			if (performance.now() >= deadline) {
				await reader.cancel();
				return bytes;
			}
			await sleep(delayMs);
		}
	};
}

/** Cancel a body right after headers without reading it. */
async function cancelAfterHeaders(response: Response): Promise<number> {
	await response.body?.cancel();
	return 0;
}

/** Pick one large note for a worker so concurrent workers read distinct files. */
function largeNote(fixtures: Fixtures, context: OperationContext): string {
	const index =
		(context.worker + context.sequence) % fixtures.largeNotes.length;
	return fixtures.largeNotes[index] as string;
}

/**
 * Build the OAB-53 workload catalog for a seeded vault. Upload workloads write new files under
 * `LOADTEST_PREFIX/uploads/` and are capped per worker to bound stored bytes.
 */
export function createWorkloads(fixtures: Fixtures): Workload[] {
	const largeText = markdownOfSize(MAX_TEXT_BYTES, "upload");
	return [
		{
			name: "rest-vault",
			category: "rest",
			run: (target) =>
				timed(() =>
					fetcher(target)(`${target.origin}/v1/vault`, {
						headers: auth(target),
					}),
				),
		},
		{
			name: "rest-changes-1000",
			category: "rest",
			run: (target) =>
				timed(() =>
					fetcher(target)(
						`${target.origin}/v1/changes?epoch=${encodeURIComponent(fixtures.epoch)}&since=0&limit=1000`,
						{ headers: auth(target) },
					),
				),
		},
		{
			name: "rest-text-1mb",
			category: "rest",
			run: (target, context) =>
				timed(() =>
					fetcher(target)(fileUrl(target, largeNote(fixtures, context)), {
						headers: auth(target),
					}),
				),
		},
		{
			name: "rest-search-50",
			category: "rest",
			run: (target) =>
				timed(() =>
					fetcher(target)(
						`${target.origin}/v1/search?q=${SEARCH_NEEDLE}&limit=50`,
						{ headers: auth(target) },
					),
				),
		},
		{
			name: "mcp-read-note-1mb",
			category: "mcp",
			run: (target, context) =>
				timed(() =>
					callTool(
						target,
						"read_note",
						{ path: largeNote(fixtures, context) },
						context.sequence,
					),
				),
		},
		{
			name: "mcp-list-notes",
			category: "mcp",
			run: (target, context) =>
				timed(() =>
					callTool(
						target,
						"list_notes",
						{ prefix: LOADTEST_PREFIX, include_large: true },
						context.sequence,
					),
				),
		},
		{
			name: "mcp-search-notes-50",
			category: "mcp",
			run: (target, context) =>
				timed(() =>
					callTool(
						target,
						"search_notes",
						{ query: SEARCH_NEEDLE, limit: 50 },
						context.sequence,
					),
				),
		},
		{
			name: "upload-text-1mb",
			category: "upload",
			maxIterationsPerWorker: 4,
			run: async (target, context) => {
				const path = `${LOADTEST_PREFIX}uploads/${context.level}-${context.worker}-${context.sequence}.md`;
				const started = performance.now();
				try {
					const status = await createFile(
						target,
						fixtures.epoch,
						path,
						largeText,
					);
					return {
						status,
						bytes: MAX_TEXT_BYTES,
						ms: performance.now() - started,
					};
				} catch {
					return { status: 0, bytes: 0, ms: performance.now() - started };
				}
			},
		},
		{
			name: "upload-blob-25mb",
			category: "upload",
			maxIterationsPerWorker: 2,
			run: async (target, context) => {
				const tag = `${context.level}-${context.worker}-${context.sequence}`;
				const bytes = blobBytes(MAX_BLOB_BYTES, tag);
				const started = performance.now();
				try {
					const status = await createBlob(
						target,
						fixtures.epoch,
						`${LOADTEST_PREFIX}uploads/${tag}.bin`,
						bytes,
					);
					return {
						status,
						bytes: bytes.byteLength,
						ms: performance.now() - started,
					};
				} catch {
					return { status: 0, bytes: 0, ms: performance.now() - started };
				}
			},
		},
		{
			name: "slow-text-1mb",
			category: "slow",
			run: (target, context) =>
				timed(
					() =>
						fetcher(target)(fileUrl(target, largeNote(fixtures, context)), {
							headers: auth(target),
						}),
					slowConsume(50, 10_000),
				),
		},
		{
			name: "slow-blob-25mb",
			category: "slow",
			run: (target) =>
				timed(
					() =>
						fetcher(target)(fileUrl(target, fixtures.blob), {
							headers: auth(target),
						}),
					slowConsume(50, 6_000),
				),
		},
		{
			name: "slow-mcp-read-note-1mb",
			category: "slow",
			run: (target, context) =>
				timed(
					() =>
						callTool(
							target,
							"read_note",
							{ path: largeNote(fixtures, context) },
							context.sequence,
						),
					slowConsume(50, 10_000),
				),
		},
		{
			name: "cancel-text-1mb",
			category: "cancel",
			run: (target, context) =>
				timed(
					() =>
						fetcher(target)(fileUrl(target, largeNote(fixtures, context)), {
							headers: auth(target),
						}),
					cancelAfterHeaders,
				),
		},
		{
			name: "cancel-blob-25mb",
			category: "cancel",
			run: (target) =>
				timed(
					() =>
						fetcher(target)(fileUrl(target, fixtures.blob), {
							headers: auth(target),
						}),
					cancelAfterHeaders,
				),
		},
		{
			name: "cancel-mcp-read-note-1mb",
			category: "cancel",
			run: (target, context) =>
				timed(
					() =>
						callTool(
							target,
							"read_note",
							{ path: largeNote(fixtures, context) },
							context.sequence,
						),
					cancelAfterHeaders,
				),
		},
	];
}

/** Return the nearest-rank percentile of a sorted array, or 0 when empty. */
function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.max(1, Math.ceil(fraction * sorted.length));
	return sorted[rank - 1] as number;
}

/**
 * Run `concurrency` workers that repeat one workload until `durationMs` passes or each worker hits
 * the workload iteration cap. A 429 or 503 waits 250 ms before the next attempt so refusals do not
 * become a tight loop.
 */
export async function runLevel(
	target: ProfileTarget,
	workload: Workload,
	concurrency: number,
	durationMs: number,
): Promise<LevelResult> {
	const startedAt = Date.now();
	const deadline = startedAt + durationMs;
	const level = `${workload.name}-c${concurrency}-${startedAt}`;
	const results: OperationResult[] = [];
	let sequence = 0;
	/** Repeat the workload on one logical client connection slot. */
	const worker = async (index: number) => {
		for (
			let iteration = 0;
			Date.now() < deadline &&
			iteration < (workload.maxIterationsPerWorker ?? Number.POSITIVE_INFINITY);
			iteration++
		) {
			const result = await workload.run(target, {
				level,
				worker: index,
				sequence: sequence++,
			});
			results.push(result);
			if (result.status === 429 || result.status === 503) await sleep(250);
		}
	};
	await Promise.all(
		Array.from({ length: concurrency }, (_, index) => worker(index)),
	);
	const times = results.map((result) => result.ms).sort((a, b) => a - b);
	const statuses: Record<string, number> = {};
	for (const result of results)
		statuses[result.status] = (statuses[result.status] ?? 0) + 1;
	return {
		workload: workload.name,
		concurrency,
		startedAt,
		endedAt: Date.now(),
		operations: results.length,
		statuses,
		bytes: results.reduce((sum, result) => sum + result.bytes, 0),
		medianMs: Math.round(percentile(times, 0.5)),
		maxMs: Math.round(percentile(times, 1)),
	};
}

/** Open response whose body is held unread to model a stalled consumer. */
export interface StalledRead {
	readonly status: number;
	/** Cancel the held body; safe to call more than once. */
	release(): Promise<void>;
}

/**
 * Open `rest` REST blob reads and `mcp` MCP large-note reads, read one chunk of each, then hold the
 * readers without reading or cancelling. This models OAB-58 stalled reads that outlive the 60 s lease
 * and 60 s reclaim grace.
 */
export async function openStalledReads(
	target: ProfileTarget,
	fixtures: Fixtures,
	rest: number,
	mcp: number,
): Promise<StalledRead[]> {
	/** Hold one response after its first chunk. */
	const hold = async (response: Response): Promise<StalledRead> => {
		const reader = response.body?.getReader();
		await reader?.read();
		let released = false;
		return {
			status: response.status,
			release: async () => {
				if (released) return;
				released = true;
				await reader?.cancel().catch(() => undefined);
			},
		};
	};
	const requests = [
		...Array.from({ length: rest }, () =>
			fetcher(target)(fileUrl(target, fixtures.blob), {
				headers: auth(target),
			}),
		),
		...Array.from({ length: mcp }, (_, index) =>
			callTool(
				target,
				"read_note",
				{
					path: fixtures.largeNotes[
						index % fixtures.largeNotes.length
					] as string,
				},
				10_000 + index,
			),
		),
	];
	return Promise.all(requests.map(async (request) => hold(await request)));
}

/**
 * Repeat a request while it returns 429 or 503, waiting for `Retry-After` (default 2 s), for at most
 * 180 s. Cleanup uses it because held read leases can refuse requests until reclaim.
 */
async function retryRefusals(
	request: () => Promise<Response>,
): Promise<Response> {
	const deadline = Date.now() + 180_000;
	for (;;) {
		const response = await request();
		if (
			(response.status !== 429 && response.status !== 503) ||
			Date.now() > deadline
		)
			return response;
		await drain(response);
		await sleep(Number(response.headers.get("retry-after") ?? 2) * 1_000);
	}
}

/** One manifest row used by cleanup. */
interface ManifestEntry {
	path: string;
	etag: string;
	deleted: boolean;
}

/**
 * Delete every live file under {@link LOADTEST_PREFIX} with `If-Match` on its observed ETag. Returns
 * the number of 2xx deletes and the non-2xx statuses. Blob bytes stay in R2 until blob GC.
 */
export async function deleteLoadtestFiles(
	target: ProfileTarget,
): Promise<{ deleted: number; failures: number[] }> {
	const live: ManifestEntry[] = [];
	let page: string | null = null;
	do {
		const url = `${target.origin}/v1/manifest${page ? `?page=${encodeURIComponent(page)}` : ""}`;
		const response = await retryRefusals(() =>
			fetcher(target)(url, { headers: auth(target) }),
		);
		if (!response.ok) throw new Error(`manifest returned ${response.status}`);
		const body = (await response.json()) as {
			entries: ManifestEntry[];
			next_page: string | null;
		};
		live.push(
			...body.entries.filter(
				(entry) => entry.path.startsWith(LOADTEST_PREFIX) && !entry.deleted,
			),
		);
		page = body.next_page;
	} while (page);
	const failures: number[] = [];
	let deleted = 0;
	for (const entry of live) {
		const response = await retryRefusals(() =>
			fetcher(target)(fileUrl(target, entry.path), {
				method: "DELETE",
				headers: auth(target, { "If-Match": entry.etag }),
			}),
		);
		await drain(response);
		if (response.ok) deleted++;
		else failures.push(response.status);
	}
	return { deleted, failures };
}
