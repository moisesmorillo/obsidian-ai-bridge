import type { BlobGcPreview, BlobGcStatus } from "@vaultwire/protocol";
import { formatBytes, formatCount } from "@worker/transport/owner-pages/format";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Optional inventory observations, durable run state, and the CSRF value. */
export interface BlobGcPageViewModel {
	csrf: string;
	service?: OwnerServiceMetadata;
	preview: BlobGcPreview | null;
	status: BlobGcStatus;
}

/** Render the observed collection state without claiming deletion or capacity. */
export function renderBlobGcPage(view: BlobGcPageViewModel): string {
	const activeStep =
		view.status.phase === "idle"
			? "inventory"
			: view.status.phase === "marking"
				? "mark"
				: "delete";
	const steps = ["Inventory", "Mark", "Delete", "Clear"] as const;
	const stepKeys = ["inventory", "mark", "delete", "clear"] as const;
	const stepList = steps
		.map(
			(step, index) =>
				`<li class="collection-step${stepKeys[index] === activeStep ? " step-current" : ""}"${stepKeys[index] === activeStep ? ' aria-current="step"' : ""}>${step}</li>`,
		)
		.join("");
	const inventory =
		view.preview === null
			? '<span class="muted">unavailable</span>'
			: formatCount(view.preview.count);
	const reclaimable =
		view.preview === null
			? '<span class="muted">unavailable</span>'
			: formatBytes(view.preview.bytes);
	const dryRun =
		view.preview === null
			? "Dry run unavailable."
			: `Dry run: ${formatCount(view.preview.count)} unreferenced blobs, ${formatBytes(view.preview.bytes)} reclaimable.`;
	const deleteMessage =
		view.status.delete_state === "unknown"
			? "Delete outcome is unknown. Marks and publication remain blocked. An owner retry cannot clear this claim."
			: view.status.delete_state === "active"
				? "A delete request is active. Its claim stays until R2 reports settlement."
				: "";
	const failure =
		view.status.failure === null
			? "No collection failure."
			: "Collection failed. Marks remain for a retry.";
	const content = `<header class="page-header"><div><p class="owner-eyebrow">Storage</p><h1>Blob cleanup</h1><p>Review unreferenced blob inventory and run one bounded collection batch.</p></div><span class="chip"><span class="status-dot status-dot-copper" aria-hidden="true"></span>${view.status.phase}</span></header><section class="stat-grid" aria-label="Blob collection observations"><article class="card"><p class="label">Unreferenced blobs</p><p class="stat-value">${inventory}</p></article><article class="card"><p class="label">Reclaimable bytes</p><p class="stat-value">${reclaimable}</p></article><article class="card"><p class="label">Run phase</p><p class="stat-value"><span class="status-dot status-dot-copper" aria-hidden="true"></span> ${view.status.phase}</p><p class="footnote">Marked blobs: ${formatCount(view.status.marked_count)}. Marked bytes: ${formatBytes(view.status.marked_bytes)}.</p></article></section><section class="panel"><h2>Collection run</h2><p>${dryRun}</p><ol class="collection-steps">${stepList}</ol><p>Marked counts: ${formatCount(view.status.marked_count)} blobs, ${formatBytes(view.status.marked_bytes)}.</p><p>${deleteMessage} ${failure}</p><form method="post" action="/owner/blob-gc"><input type="hidden" name="csrf" value="${view.csrf}"><button class="button-secondary">Confirm or continue blob collection</button></form><p>Each request and alarm handles one bounded batch.</p></section><section class="panel safety-panel"><h2>Collection safety</h2><p>Backups are excluded. The mark fence protects published blobs.</p></section>`;
	return renderOwnerShell("blob-gc", content, view.service);
}
