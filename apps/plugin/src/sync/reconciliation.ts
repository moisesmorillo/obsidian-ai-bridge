import {
	type ChangesPage,
	DevicePayloadHashSchema,
	type ManifestEntry,
	type ManifestPage,
	parseETag,
	type ReconciliationCheckpoint,
} from "@obsidian-ai-bridge/protocol";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import { UnsupportedRemoteTextError } from "@plugin/sync/remote-text";
import type { TextApplyEngine, TextVault } from "@plugin/sync/text-apply";

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
			else if (this.journal.snapshot().cursor !== null)
				await this.runReplayWithRecovery();
		});
	}

	/** Replays feed rows in ascending sequence and persists each accepted cursor. */
	replay(): Promise<void> {
		return this.serialize(() => this.runReplayWithRecovery());
	}

	/** Shares one serialized recovery policy for explicit replay and restart resume. */
	private async runReplayWithRecovery(): Promise<void> {
		try {
			await this.runReplay();
		} catch (error) {
			if (!isRecoveryError(error)) throw error;
			await this.runReconciliation();
		}
	}

	/** Fences new work after plugin unload without claiming in-flight host work stopped. */
	close(): void {
		this.closed = true;
		this.applyEngine.close();
	}

	/** Traverses manifest pages and local files while persisting restart boundaries. */
	private async runReconciliation(
		restartOnSnapshotChange = true,
	): Promise<void> {
		this.assertOpen();
		let checkpoint: ReconciliationCheckpoint | null =
			this.journal.snapshot().reconciliation;
		let page: ReconciliationManifestPage | null = null;
		if (!checkpoint) {
			page = await this.readManifestPage(null, restartOnSnapshotChange);
			await this.journal.resetEpoch(page.epoch);
			checkpoint = {
				epoch: page.epoch,
				head_seq: page.head_seq,
				stage: "manifest",
				page_token: null,
				page_number: 0,
				local_paths: await this.localVault.list(),
				local_index: 0,
				pending_paths: page.entries.map((entry) => entry.path),
				remote_paths: page.entries.map((entry) => entry.path),
			};
			await this.journal.setReconciliationCheckpoint(checkpoint);
		} else if (checkpoint.stage === "manifest") {
			try {
				page = await this.readManifestPage(
					checkpoint.page_token,
					restartOnSnapshotChange,
				);
			} catch (error) {
				if (!restartOnSnapshotChange || !isRecoveryError(error)) throw error;
				await this.journal.setReconciliationCheckpoint(null);
				return this.runReconciliation(false);
			}
			if (
				page.epoch !== checkpoint.epoch ||
				page.head_seq !== checkpoint.head_seq
			) {
				if (!restartOnSnapshotChange)
					throw new Error("Manifest snapshot changed during reconciliation");
				await this.journal.resetEpoch(page.epoch);
				await this.journal.setReconciliationCheckpoint(null);
				return this.runReconciliation(false);
			}
		}
		await this.resumeApply();

		while (checkpoint.stage === "manifest") {
			this.assertOpen();
			if (!page) {
				try {
					page = await this.readManifestPage(
						checkpoint.page_token,
						restartOnSnapshotChange,
					);
				} catch (error) {
					if (!restartOnSnapshotChange || !isRecoveryError(error)) throw error;
					await this.journal.setReconciliationCheckpoint(null);
					return this.runReconciliation(false);
				}
			}
			if (
				page.epoch !== checkpoint.epoch ||
				page.head_seq !== checkpoint.head_seq
			) {
				if (!restartOnSnapshotChange)
					throw new Error("Manifest snapshot changed during reconciliation");
				await this.journal.resetEpoch(page.epoch);
				await this.journal.setReconciliationCheckpoint(null);
				return this.runReconciliation(false);
			}
			const pagePaths = page.entries.map((entry) => entry.path);
			let pendingPaths: string[] = [...checkpoint.pending_paths];
			if (pendingPaths.some((path) => !pagePaths.includes(path))) {
				if (!restartOnSnapshotChange)
					throw new Error("Manifest membership changed during restart");
				await this.journal.setReconciliationCheckpoint(null);
				return this.runReconciliation(true);
			}
			const remotePaths: string[] = [...checkpoint.remote_paths];
			for (const entry of page.entries)
				if (!remotePaths.includes(entry.path)) remotePaths.push(entry.path);
			if (pendingPaths.length === 0 && page.entries.length > 0) {
				pendingPaths = page.entries.map((entry) => entry.path);
				checkpoint = {
					...checkpoint,
					pending_paths: pendingPaths,
					remote_paths: remotePaths,
				};
				await this.journal.setReconciliationCheckpoint(checkpoint);
			} else if (
				JSON.stringify(remotePaths) !== JSON.stringify(checkpoint.remote_paths)
			) {
				checkpoint = { ...checkpoint, remote_paths: remotePaths };
				await this.journal.setReconciliationCheckpoint(checkpoint);
			}
			for (const entry of page.entries) {
				if (!pendingPaths.includes(entry.path)) continue;
				this.assertOpen();
				await this.applyManifestEntry(entry);
				pendingPaths = pendingPaths.filter((path) => path !== entry.path);
				checkpoint = {
					...checkpoint,
					pending_paths: pendingPaths,
				};
				await this.journal.setReconciliationCheckpoint(checkpoint);
			}
			checkpoint = {
				...checkpoint,
				page_token: page.next_page,
				page_number: checkpoint.page_number + 1,
				pending_paths: [],
				stage: page.next_page === null ? "local" : "manifest",
			};
			await this.journal.setReconciliationCheckpoint(checkpoint);
			page = null;
		}

		if (checkpoint.stage === "local") {
			const resolvedPaths = await this.resolveSentCreates(checkpoint.epoch);
			if (resolvedPaths.length > 0) {
				checkpoint = {
					...checkpoint,
					remote_paths: [
						...new Set([...checkpoint.remote_paths, ...resolvedPaths]),
					],
				};
				await this.journal.setReconciliationCheckpoint(checkpoint);
			}
			for (
				let index = checkpoint.local_index;
				index < checkpoint.local_paths.length;
				index += 1
			) {
				this.assertOpen();
				const path = checkpoint.local_paths[index];
				if (path && !checkpoint.remote_paths.includes(path)) {
					try {
						await this.publishLocalCreate(path, checkpoint.epoch);
						this.assertOpen();
					} catch (error) {
						if (
							getStatus(error) !== 412 &&
							!(restartOnSnapshotChange && isRecoveryError(error))
						)
							throw error;
						await this.journal.setReconciliationCheckpoint(null);
						return this.runReconciliation(false);
					}
				}
				checkpoint = {
					...checkpoint,
					local_index: index + 1,
				};
				await this.journal.setReconciliationCheckpoint(checkpoint);
			}
			checkpoint = { ...checkpoint, stage: "cursor" };
			await this.journal.setReconciliationCheckpoint(checkpoint);
		}
		await this.journal.setCursor(checkpoint.epoch, checkpoint.head_seq);
		await this.journal.setReconciliationCheckpoint(null);
	}

	/** Resolves response-lost creates only when a current manifest confirms their hash. */
	private async resolveSentCreates(epoch: string): Promise<string[]> {
		const sent = this.journal
			.snapshot()
			.pending_ops.filter((operation) => operation.state === "sent");
		if (sent.length === 0) return [];
		const hashes = new Map(
			sent.map((operation) => [operation.path, operation.payload_hash]),
		);
		const resolvedPaths: string[] = [];
		let page = await this.remote.manifest(null);
		if (page.epoch !== epoch) return resolvedPaths;
		while (true) {
			for (const entry of page.entries) {
				if (hashes.get(entry.path) !== entry.hash || entry.kind !== "text")
					continue;
				await this.applyManifestEntry(entry);
				resolvedPaths.push(entry.path);
			}
			if (page.next_page === null) return resolvedPaths;
			page = await this.remote.manifest(page.next_page);
			if (page.epoch !== epoch) return resolvedPaths;
		}
	}

	/** Reads one saved snapshot page and retries only a stale page token once. */
	private async readManifestPage(
		pageToken: string | null,
		restartOnSnapshotChange: boolean,
	): Promise<ReconciliationManifestPage> {
		try {
			return await this.remote.manifest(pageToken);
		} catch (error) {
			if (restartOnSnapshotChange && isRecoveryError(error)) {
				if (pageToken !== null) throw error;
				await this.journal.setReconciliationCheckpoint(null);
				return this.remote.manifest(null);
			}
			throw error;
		}
	}

	/** Applies text rows through TextApplyEngine and records unsupported rows as attention. */
	private async applyManifestEntry(
		entry: ReconciliationManifestEntry,
	): Promise<void> {
		const remoteAdmission = classifyEnrollmentPath(entry.path, 0);
		if (remoteAdmission === "excluded") return;
		if (entry.kind !== "text" || remoteAdmission === "blob") {
			await this.journal.recordAttention(
				entry.path,
				"Blob synchronization is not available yet",
			);
			return;
		}
		const localSize = await this.localVault.size(entry.path);
		if (localSize !== null) {
			const localAdmission = classifyEnrollmentPath(entry.path, localSize);
			if (localAdmission === "excluded") return;
			if (localAdmission === "blob") {
				await this.journal.recordAttention(
					entry.path,
					"Blob synchronization is not available yet",
				);
				return;
			}
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
		await this.applyChange(change);
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
		this.assertOpen();
		const size = await this.localVault.size(path);
		this.assertOpen();
		if (size === null) return;
		const admission = classifyEnrollmentPath(path, size);
		if (admission === "excluded") return;
		if (admission === "blob") {
			await this.journal.recordAttention(
				path,
				"Blob synchronization is not available yet",
			);
			return;
		}
		const text = await this.localVault.read(path);
		this.assertOpen();
		if (text === null) return;
		if (new TextEncoder().encode(text).byteLength > 1_000_000) {
			await this.journal.recordAttention(
				path,
				"Inline text exceeds the enrollment size limit",
			);
			return;
		}
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
		this.assertOpen();
		if (saved.operation.state !== "sent")
			throw new Error("Enrollment create was not persisted");
		const payload = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(saved.bytes);
		try {
			this.assertOpen();
			const response = await this.remote.createText(
				path,
				payload,
				epoch,
				saved.operation.key,
			);
			this.assertOpen();
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
			this.assertOpen();
			await this.journal.resolve(saved.operation.key, { kind: "receipt" });
			this.assertOpen();
		} catch (error) {
			this.assertOpen();
			if (getStatus(error) === 412) {
				await this.journal.resolve(saved.operation.key, { kind: "rejection" });
				this.assertOpen();
				throw error;
			}
			throw error;
		}
	}

	/** Replays one feed page and advances cursor only after apply or durable attention. */
	private async runReplay(): Promise<void> {
		this.assertOpen();
		const state = this.journal.snapshot();
		if (!state.epoch || state.cursor === null) return this.runReconciliation();
		await this.resumeApply();
		const page = await this.remote.changes(state.epoch, state.cursor);
		this.assertOpen();
		if (page.epoch !== state.epoch) return this.runReconciliation();
		for (const entry of page.entries) {
			this.assertOpen();
			if (entry.seq <= (this.journal.snapshot().cursor ?? 0)) continue;
			if (classifyEnrollmentPath(entry.path, 0) === "excluded") {
				await this.journal.setCursor(state.epoch, entry.seq);
				continue;
			}
			if (entry.op === "delete" && !(await this.isConfirmedTextDelete(entry))) {
				await this.journal.recordAttention(
					entry.path,
					"Delete row is not a confirmed inline-text revision",
				);
			} else if (entry.op !== "delete" && entry.hash === "") {
				await this.journal.recordAttention(
					entry.path,
					"Remote entry has no text content",
				);
			} else {
				await this.applyChange(entry);
			}
			await this.journal.setCursor(state.epoch, entry.seq);
		}
		const latest = this.journal.snapshot().cursor ?? 0;
		if (page.entries.length === 0 && page.head_seq > latest)
			await this.journal.setCursor(state.epoch, page.head_seq);
	}

	/** Confirms a delete's exact revision and text kind from the current manifest row. */
	private async isConfirmedTextDelete(
		change: ReconciliationChangesPage["entries"][number],
	): Promise<boolean> {
		let page = await this.remote.manifest(null);
		const epoch = this.journal.snapshot().epoch;
		while (page.epoch === epoch) {
			const row = page.entries.find((entry) => entry.path === change.path);
			if (row)
				return (
					row.etag === change.etag &&
					row.seq === change.seq &&
					row.deleted &&
					row.kind === "text"
				);
			if (page.next_page === null) return false;
			page = await this.remote.manifest(page.next_page);
		}
		return false;
	}

	/** Applies only admitted text work and records unsupported blobs before cursor advance. */
	private async applyChange(
		change: ReconciliationChangesPage["entries"][number],
	): Promise<void> {
		const size = await this.localVault.size(change.path);
		const admission = classifyEnrollmentPath(change.path, size ?? 0);
		if (admission === "excluded") return;
		if (admission === "blob") {
			await this.journal.skipApplyForAttention(
				change.path,
				change.seq,
				"Blob synchronization is not available yet",
			);
			return;
		}
		try {
			await this.applyEngine.apply(change);
		} catch (error) {
			if (!(error instanceof UnsupportedRemoteTextError)) throw error;
			await this.journal.skipApplyForAttention(
				change.path,
				change.seq,
				"Blob synchronization is not available yet",
			);
		}
	}

	/** Clears an unsupported recovered row without claiming its remote base. */
	private async resumeApply(): Promise<void> {
		try {
			await this.applyEngine.resume();
		} catch (error) {
			if (!(error instanceof UnsupportedRemoteTextError)) throw error;
			const pending = this.journal.snapshot().pending_apply[0];
			if (!pending || pending.change.path !== error.path) throw error;
			await this.journal.skipApplyForAttention(
				pending.change.path,
				pending.change.seq,
				"Blob synchronization is not available yet",
			);
		}
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
