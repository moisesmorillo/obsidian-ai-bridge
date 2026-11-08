import {
	formatBytes,
	formatCount,
	formatUtcDateTime,
} from "@worker/transport/owner-pages/format";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Escaped export labels and canonical values for the read-only owner page. */
export interface ExportsPageViewModel {
	service?: OwnerServiceMetadata;
	csrf: string;
	nextRun: string;
	lastSnapshot: string | null;
	retainedCount: number | null;
	totalBytes: number | null;
	snapshots: readonly {
		createdAt: string;
		size: number;
		downloadUrl: string;
	}[];
	failedExports: readonly { createdAt: string; failure: string }[];
}

/** Render completed exports and safe failure labels without changing export state. */
export function renderExportsPage(view: ExportsPageViewModel): string {
	const retainedCard =
		view.retainedCount === null || view.totalBytes === null
			? ""
			: `<article class="card"><p class="label">Retained</p><p class="stat-value">${formatCount(view.retainedCount)} snapshots</p><p class="footnote">${formatBytes(view.totalBytes)}</p></article>`;
	const snapshotRows = view.snapshots
		.map(
			(snapshot) =>
				`<tr><td class="no-wrap">${formatUtcDateTime(snapshot.createdAt)}</td><td>${formatBytes(snapshot.size)}</td><td><a class="button-secondary button-small" href="${snapshot.downloadUrl}">Download</a></td></tr>`,
		)
		.join("");
	const failedRows = view.failedExports
		.map(
			(result) =>
				`<li><span class="status-dot status-dot-copper" aria-hidden="true"></span> ${formatUtcDateTime(result.createdAt)} — ${result.failure}</li>`,
		)
		.join("");
	return renderOwnerShell(
		"exports",
		`<header class="page-header"><div><p class="owner-eyebrow">Backups</p><h1>Packed baseline exports</h1><p>Exports run hourly at :00 UTC and remain available for 15 days. Only completed exports can be downloaded.</p></div><form method="post" action="/owner/exports"><input type="hidden" name="csrf" value="${view.csrf}"><button>Create export now</button></form></header><section class="stat-grid" aria-label="Export schedule"><article class="card"><p class="label">Last snapshot</p><p class="stat-value no-wrap">${view.lastSnapshot === null ? "Unknown" : formatUtcDateTime(view.lastSnapshot)}</p></article><article class="card"><p class="label">Next run</p><p class="stat-value no-wrap">${formatUtcDateTime(view.nextRun)}</p></article>${retainedCard}</section><section class="panel"><h2>Completed snapshots</h2>${snapshotRows ? `<div class="table-scroll"><table><thead><tr><th>Created UTC</th><th>Size</th><th>Download</th></tr></thead><tbody>${snapshotRows}</tbody></table></div>` : "<p>No completed exports.</p>"}</section><section class="panel"><h2>Failed exports</h2>${failedRows ? `<ul class="failed-list">${failedRows}</ul>` : '<p><span class="status-dot status-dot-copper" aria-hidden="true"></span> No failed exports.</p>'}</section>`,
		view.service,
	);
}
