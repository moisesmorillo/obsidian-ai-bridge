import type { BlobGcPreview, BlobGcStatus } from "@vaultwire/protocol";
import { BlobGcPreviewSchema, BlobGcStatusSchema } from "@vaultwire/protocol";

/** Maximum R2 pages read during one owner preview. */
export const BLOB_GC_MAX_LIST_PAGES = 32;
/** Maximum object keys passed to one SQLite or R2 batch operation. */
export const BLOB_GC_BATCH_SIZE = 100;
/** Keep opaque R2 cursors small inside the SQLite metadata row. */
const MAX_BLOB_GC_CURSOR_BYTES = 16_000;

/** One validated content-addressed object found in the blobs namespace. */
export interface BlobGcObject {
	/** Lowercase SHA-256 digest from the object key. */
	hash: string;
	/** Exact stored byte size. */
	size: number;
}

/** Read-only R2 inventory and destructive delete operations limited to blob objects. */
export interface BlobGcObjectStore {
	/** Return one bounded page of `blobs/` objects, never backups. */
	list(
		cursor: string | null,
	): Promise<{ objects: readonly BlobGcObject[]; cursor: string | null }>;
	/** Delete exact content-addressed hashes from `blobs/`. */
	delete(hashes: readonly string[]): Promise<void>;
}

/** SQLite authority for reachability, durable marks, and resumable GC progress. */
export interface BlobGcRepository {
	/** Count listed objects with no live, retained, or active-export reference. */
	preview(objects: readonly BlobGcObject[]): Promise<BlobGcPreview>;
	/** Start a confirmed inventory only when no earlier run is active. */
	start(): Promise<void>;
	/** Return the durable run identity, phase, and current R2 cursor. */
	runState(): Promise<{
		runId: string | null;
		phase: BlobGcStatus["phase"];
		cursor: string | null;
	}>;
	/** Apply one inventory page only while its run, phase, and cursor remain current. */
	markAndAdvance(
		runId: string,
		cursor: string | null,
		objects: readonly BlobGcObject[],
		nextCursor: string | null,
	): Promise<boolean>;
	/** Record failure only if the inventory run and cursor still match. */
	recordInventoryFailure(runId: string, cursor: string | null): Promise<void>;
	/** Claim one durable delete batch without a timeout, or return null while another owner holds it. */
	claimDeleteBatch(owner: string): Promise<readonly BlobGcObject[] | null>;
	/** Record a failure and release only the caller's claim after its R2 request settles. */
	recordFailure(owner?: string): Promise<void>;
	/** Clear exact marks, clear settled failure state, and release the claim in one transaction. */
	clear(objects: readonly BlobGcObject[], owner: string): Promise<void>;
	/** Finish after this owner clears the final mark and failure state atomically. */
	finish(owner: string): Promise<void>;
	/** Report current phase, delete claim, failure, and durable mark count and bytes. */
	status(): Promise<BlobGcStatus>;
}

/** Typed transient failure when inventory or R2 work exceeds the safe batch contract. */
export class BlobGcUnavailable extends Error {
	/** Name the bounded GC scan failure without exposing provider details. */
	constructor() {
		super("Blob garbage collection cannot complete this batch now");
	}
}

/** Coordinates bounded inventory, atomic marking, deletion, and visible retry state. */
export class BlobGcService {
	/** Bind the SQLite authority and namespace-limited object capability. */
	constructor(
		private readonly repository: BlobGcRepository,
		private readonly objects: BlobGcObjectStore,
	) {}

	/** Scan bounded R2 pages and measure reclaimable bytes without changing marks. */
	async preview(): Promise<BlobGcPreview> {
		const total = { count: 0, bytes: 0 };
		let cursor: string | null = null;
		for (
			let pageNumber = 0;
			pageNumber < BLOB_GC_MAX_LIST_PAGES;
			pageNumber += 1
		) {
			const page = await this.objects.list(cursor);
			const measured = await this.repository.preview(
				validateObjects(page.objects),
			);
			total.count += measured.count;
			total.bytes += measured.bytes;
			if (
				!Number.isSafeInteger(total.count) ||
				!Number.isSafeInteger(total.bytes)
			)
				throw new BlobGcUnavailable();
			cursor = validateCursor(page.cursor);
			if (cursor === null) return BlobGcPreviewSchema.parse(total);
		}
		throw new BlobGcUnavailable();
	}

	/** Start one collection only after confirmation, then run its first bounded batch. */
	async startBatch(): Promise<BlobGcStatus> {
		await this.repository.start();
		return this.collectBatch();
	}

	/** Advance one bounded batch only while an owner-confirmed run remains active. */
	async collectBatch(): Promise<BlobGcStatus> {
		const state = await this.repository.runState();
		if (state.phase === "idle")
			return BlobGcStatusSchema.parse(await this.repository.status());
		try {
			if (state.phase === "marking") {
				if (state.runId === null) throw new BlobGcUnavailable();
				const page = await this.objects.list(state.cursor);
				const applied = await this.repository.markAndAdvance(
					state.runId,
					state.cursor,
					validateObjects(page.objects),
					validateCursor(page.cursor),
				);
				if (!applied)
					return BlobGcStatusSchema.parse(await this.repository.status());
			} else if (state.phase === "deleting") {
				const owner = crypto.randomUUID();
				const claimed = await this.repository.claimDeleteBatch(owner);
				if (claimed === null)
					return BlobGcStatusSchema.parse(await this.repository.status());
				try {
					const marked = validateObjects(claimed);
					if (marked.length === 0) await this.repository.finish(owner);
					else {
						await this.objects.delete(marked.map(({ hash }) => hash));
						await this.repository.clear(marked, owner);
					}
				} catch {
					await this.repository.recordFailure(owner);
				}
			}
		} catch {
			if (state.phase === "marking" && state.runId !== null)
				await this.repository.recordInventoryFailure(state.runId, state.cursor);
			else await this.repository.recordFailure();
		}
		return BlobGcStatusSchema.parse(await this.repository.status());
	}

	/** Return the durable owner-visible phase and mark measurement. */
	status(): Promise<BlobGcStatus> {
		return this.repository
			.status()
			.then((result) => BlobGcStatusSchema.parse(result));
	}
}

/** Reject oversized external cursors before they enter a durable SQLite row. */
function validateCursor(cursor: string | null): string | null {
	if (
		cursor !== null &&
		new TextEncoder().encode(cursor).byteLength > MAX_BLOB_GC_CURSOR_BYTES
	)
		throw new BlobGcUnavailable();
	return cursor;
}

/** Reject malformed inventory and duplicate hashes before they cross an authority boundary. */
function validateObjects(objects: readonly BlobGcObject[]): BlobGcObject[] {
	const seen = new Set<string>();
	return objects.map((object) => {
		if (
			!/^[0-9a-f]{64}$/.test(object.hash) ||
			!Number.isSafeInteger(object.size) ||
			object.size < 0 ||
			seen.has(object.hash)
		)
			throw new BlobGcUnavailable();
		seen.add(object.hash);
		return { hash: object.hash, size: object.size };
	});
}
