import {
	type ChangesPage,
	DevicePayloadHashSchema,
	type ManifestEntry,
	type ManifestPage,
	parseETag,
	type VaultReadResult,
} from "@obsidian-ai-bridge/protocol";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import type { TextApplyEngine, TextVault } from "@plugin/sync/text-apply";

/** Canonical protocol observations used at the reconciliation boundary. */
export type ReconciliationVault = Pick<VaultReadResult, "epoch" | "head_seq">;
/** Canonical manifest row, including tombstone and content-kind authority. */
export type ReconciliationManifestEntry = Pick<
	ManifestEntry,
	"path" | "etag" | "seq" | "hash" | "kind" | "deleted"
>;
/** Canonical bounded page captured from one epoch and initial head. */
export type ReconciliationManifestPage = Pick<
	ManifestPage,
	"epoch" | "head_seq" | "next_page"
> & { entries: ReconciliationManifestEntry[] };
/** Canonical immutable feed page and captured upper sequence. */
export type ReconciliationChangesPage = ChangesPage;

/** Remote reads and enrollment creates consumed by the reconciliation controller. */
export interface ReconciliationRemote {
	/** Captures current epoch and head before a full manifest traversal. */
	vault(): Promise<ReconciliationVault>;
	/** Returns one manifest page for its saved seek token. */
	manifest(pageToken: string | null): Promise<ReconciliationManifestPage>;
	/** Returns one page of immutable changes after a saved cursor. */
	changes(epoch: string, since: number): Promise<ReconciliationChangesPage>;
	/** Creates text only under an absent precondition with stable immutable identity. */
	createText(
		path: string,
		text: string,
		epoch: string,
		key: string,
	): Promise<{ status: number; headers: Record<string, string>; text: string }>;
}

/** Serializes enrollment, full hydration, restart recovery, and bounded feed replay. */
export class ReconciliationController {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	/** Binds one verified journal, guarded text engine, local vault, and remote adapter. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly applyEngine: TextApplyEngine,
		private readonly localVault: TextVault,
		private readonly remote: ReconciliationRemote,
	) {}

	/** Enrolls local-only text and hydrates every confirmed remote manifest row. */
	enroll(): Promise<void> {
		return this.serialize(() => this.runReconciliation());
	}

	/** Reconciles every manifest row at a page-one epoch and captured head. */
	reconcile(): Promise<void> {
		return this.serialize(() => this.runReconciliation());
	}

	/** Resumes saved apply work and any durable manifest traversal after restart. */
	resume(): Promise<void> {
		return this.serialize(async () => {
			if (this.journal.snapshot().reconciliation)
				await this.runReconciliation();
			else if (this.journal.snapshot().cursor !== null) await this.runReplay();
		});
	}

	/** Replays feed rows in ascending sequence and persists each accepted cursor. */
	replay(): Promise<void> {
		return this.serialize(async () => {
			try {
				await this.runReplay();
			} catch (error) {
				if (!isRecoveryError(error)) throw error;
				await this.runReconciliation();
			}
		});
	}

	/** Fences new work after plugin unload without claiming in-flight host work stopped. */
	close(): void {
		this.closed = true;
	}

	/** Traverses manifest pages and local files while persisting restart boundaries. */
	private async runReconciliation(
		restartOnSnapshotChange = true,
	): Promise<void> {
		this.assertOpen();
		const vault = await this.remote.vault();
		this.assertOpen();
		let state = this.journal.snapshot();
		if (state.epoch !== vault.epoch) await this.journal.resetEpoch(vault.epoch);
		await this.applyEngine.resume();
		state = this.journal.snapshot();
		let checkpoint = state.reconciliation;
		if (
			!checkpoint ||
			checkpoint.epoch !== vault.epoch ||
			checkpoint.head_seq !== vault.head_seq
		) {
			checkpoint = {
				epoch: vault.epoch,
				head_seq: vault.head_seq,
				page_token: null,
				page_number: 0,
				local_paths: await this.localVault.list(),
				local_index: 0,
				pending_paths: [],
			};
			await this.journal.setReconciliationCheckpoint(checkpoint);
		}

		let pageToken = checkpoint.page_token;
		let pageNumber = checkpoint.page_number;
		while (true) {
			this.assertOpen();
			let page: ReconciliationManifestPage;
			try {
				page = await this.remote.manifest(pageToken);
			} catch (error) {
				if (restartOnSnapshotChange && isRecoveryError(error))
					return this.runReconciliation(false);
				throw error;
			}
			this.assertOpen();
			if (page.epoch !== vault.epoch || page.head_seq !== vault.head_seq) {
				if (restartOnSnapshotChange) return this.runReconciliation(false);
				throw new Error("Manifest snapshot changed during reconciliation");
			}
			const remaining = page.entries.map((entry) => entry.path);
			for (const entry of page.entries) {
				this.assertOpen();
				await this.applyManifestEntry(entry);
				remaining.shift();
				checkpoint = {
					...checkpoint,
					page_token: pageToken,
					page_number: pageNumber,
					pending_paths: [...remaining],
				};
				await this.journal.setReconciliationCheckpoint(checkpoint);
			}
			pageToken = page.next_page;
			pageNumber += 1;
			checkpoint = {
				...checkpoint,
				page_token: pageToken,
				page_number: pageNumber,
				pending_paths: [],
			};
			await this.journal.setReconciliationCheckpoint(checkpoint);
			if (pageToken === null) break;
		}

		checkpoint = this.journal.snapshot().reconciliation ?? checkpoint;
		const remotePaths = new Set<string>();
		let next: string | null = null;
		do {
			const page = await this.remote.manifest(next);
			for (const row of page.entries) remotePaths.add(row.path);
			next = page.next_page;
		} while (next !== null);
		for (
			let index = checkpoint.local_index;
			index < checkpoint.local_paths.length;
			index += 1
		) {
			this.assertOpen();
			const path = checkpoint.local_paths[index];
			if (path && !remotePaths.has(path))
				await this.publishLocalCreate(path, vault.epoch);
			checkpoint = {
				...checkpoint,
				local_index: index + 1,
			};
			await this.journal.setReconciliationCheckpoint(checkpoint);
		}
		await this.journal.setCursor(vault.epoch, vault.head_seq);
		await this.journal.setReconciliationCheckpoint(null);
	}

	/** Applies text rows through TextApplyEngine and records unsupported rows as attention. */
	private async applyManifestEntry(
		entry: ReconciliationManifestEntry,
	): Promise<void> {
		if (entry.kind !== "text" && !entry.deleted) {
			await this.journal.recordAttention(
				entry.path,
				"Blob synchronization is not available yet",
			);
			return;
		}
		const epoch = parseETag(entry.etag).epoch;
		const revision = parseETag(entry.etag).rev;
		const local = await this.localVault.read(entry.path);
		if (
			!entry.deleted &&
			local !== null &&
			(await hashText(local)) === entry.hash
		) {
			await this.journal.setBase(entry.path, {
				deleted: false,
				rev: revision,
				hash: entry.hash,
			});
			await this.acknowledgeObservedCreate(entry);
			return;
		}
		const change = {
			seq: entry.seq,
			op: entry.deleted ? ("delete" as const) : ("put" as const),
			path: entry.path,
			etag: entry.etag,
			hash: entry.deleted ? "" : entry.hash,
			origin: "manifest",
			at: 0,
		};
		await this.applyEngine.apply(change);
		if (epoch !== this.journal.snapshot().epoch)
			throw new Error("Manifest row belongs to a stale epoch");
		await this.acknowledgeObservedCreate(entry);
	}

	/** Resolves a sent create only after the manifest confirms its exact payload hash. */
	private async acknowledgeObservedCreate(
		entry: ReconciliationManifestEntry,
	): Promise<void> {
		if (entry.deleted || entry.kind !== "text") return;
		const operations = this.journal
			.snapshot()
			.pending_ops.filter(
				(operation) =>
					operation.state === "sent" &&
					operation.op === "put" &&
					operation.path === entry.path &&
					operation.precondition.kind === "absent" &&
					operation.payload_hash === entry.hash,
			);
		for (const operation of operations)
			await this.journal.resolve(operation.key, { kind: "receipt" });
	}

	/** Queues and sends only create-only operations with unchanged immutable payloads. */
	private async publishLocalCreate(path: string, epoch: string): Promise<void> {
		const text = await this.localVault.read(path);
		if (text === null) return;
		let operation = this.journal
			.snapshot()
			.pending_ops.find(
				(item) =>
					item.op === "put" &&
					item.path === path &&
					item.precondition.kind === "absent",
			);
		if (!operation) {
			operation = await this.journal.enqueue(
				{ op: "put", path, precondition: { kind: "absent" } },
				new TextEncoder().encode(text),
			);
		}
		const saved = await this.journal.prepareSend(operation.key, {
			kind: "absent",
		});
		if (saved.operation.state !== "sent")
			throw new Error("Enrollment create was not persisted");
		const payload = new TextDecoder("utf-8", { fatal: true }).decode(
			saved.bytes,
		);
		try {
			const response = await this.remote.createText(
				path,
				payload,
				epoch,
				saved.operation.key,
			);
			if (response.status !== 200 && response.status !== 201)
				throw new Error("Enrollment create was not accepted");
			const etag = response.headers.etag;
			if (!etag || parseETag(etag).epoch !== epoch)
				throw new Error("Enrollment create response is invalid");
			const hash = await hashText(payload);
			await this.journal.setBase(path, {
				deleted: false,
				rev: parseETag(etag).rev,
				hash,
			});
			await this.journal.resolve(saved.operation.key, { kind: "receipt" });
		} catch (error) {
			if (getStatus(error) === 412) {
				await this.journal.resolve(saved.operation.key, { kind: "rejection" });
				await this.runReconciliation();
				return;
			}
			throw error;
		}
	}

	/** Replays one feed page and advances cursor only after apply or durable attention. */
	private async runReplay(): Promise<void> {
		this.assertOpen();
		const state = this.journal.snapshot();
		if (!state.epoch || state.cursor === null) return this.runReconciliation();
		await this.applyEngine.resume();
		const page = await this.remote.changes(state.epoch, state.cursor);
		this.assertOpen();
		if (page.epoch !== state.epoch) return this.runReconciliation();
		for (const entry of page.entries) {
			this.assertOpen();
			if (entry.seq <= (this.journal.snapshot().cursor ?? 0)) continue;
			if (entry.op !== "delete" && entry.hash === "") {
				await this.journal.recordAttention(
					entry.path,
					"Remote entry has no text content",
				);
			} else {
				await this.applyEngine.apply(entry);
			}
			await this.journal.setCursor(state.epoch, entry.seq);
		}
		const latest = this.journal.snapshot().cursor ?? 0;
		if (page.entries.length === 0 && page.head_seq > latest)
			await this.journal.setCursor(state.epoch, page.head_seq);
	}

	/** Orders public entry points and keeps the admission queue live after one rejection. */
	private serialize(action: () => Promise<void>): Promise<void> {
		const result = this.tail.then(async () => {
			this.assertOpen();
			await action();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Rejects work after close without assuming pending network or host effects stopped. */
	private assertOpen(): void {
		if (this.closed) throw new Error("Reconciliation controller is closed");
	}
}

/** Hashes exact UTF-8 text for equality and create-only payload verification. */
async function hashText(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return DevicePayloadHashSchema.parse(
		[...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
	);
}

/** Routes only validated epoch and cursor errors to full reconciliation. */
function isRecoveryError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown };
	return (
		candidate.code === "epoch_mismatch" || candidate.code === "cursor_expired"
	);
}

/** Reads an HTTP status from a typed safe transport error without exposing its body. */
function getStatus(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	const candidate = error as { status?: unknown };
	return typeof candidate.status === "number" ? candidate.status : null;
}
