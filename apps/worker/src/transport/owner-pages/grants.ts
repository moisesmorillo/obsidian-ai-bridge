import {
	formatCount,
	formatUtcDateTime,
} from "@worker/transport/owner-pages/format";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Escaped client identity and grant facts for one grants page. */
export interface GrantsPageViewModel {
	clientId: string;
	clientName: string;
	clientKind: string;
	activeGrantCount: number | null;
	cleanupPendingCount: number | null;
	encodedClientId: string;
	nextCursor: string | null;
	encodedCursor: string | null;
	service?: OwnerServiceMetadata;
	grants: readonly {
		grantId: string;
		createdAt: number | null;
		revoked: boolean;
		cleanupPending: boolean;
	}[];
}

/** Render one grants page without changing registry state or eligibility rules. */
export function renderGrantsPage(view: GrantsPageViewModel): string {
	const rows = view.grants
		.map((grant) => {
			const state = grant.revoked ? "Revoked" : "Active";
			const cleanup = grant.cleanupPending
				? "Pending"
				: grant.revoked
					? "Complete"
					: "Not pending";
			return `<tr><td>${grant.grantId}</td><td class="no-wrap">${grant.createdAt === null ? "Unknown" : formatUtcDateTime(grant.createdAt)}</td><td><span class="chip${grant.revoked ? " grant-state-revoked" : ""}"><span class="status-dot${grant.revoked ? "" : " status-dot-copper"}" aria-hidden="true"></span>${state}</span></td><td>${cleanup}</td></tr>`;
		})
		.join("");
	const next = view.nextCursor
		? `<a href="/owner/clients/${view.encodedClientId}/grants?cursor=${view.encodedCursor}">Next page</a>`
		: "";
	const content = `<div><p class="breadcrumb">Clients / ${view.clientName}</p><h1>Client grants</h1></div><section class="identity-grid" aria-label="Client identity"><article class="card"><p class="label">Client id</p><p class="stat-value">${view.clientId}</p></article><article class="card"><p class="label">Kind</p><p class="stat-value">${view.clientKind}</p></article><article class="card"><p class="label">Active grants</p><p class="stat-value">${view.activeGrantCount === null ? "Unknown" : formatCount(view.activeGrantCount)}</p></article><article class="card"><p class="label">Cleanup pending</p><p class="stat-value">${view.cleanupPendingCount === null ? "Unknown" : formatCount(view.cleanupPendingCount)}</p></article></section><section class="panel"><div class="table-scroll"><table><thead><tr><th>Grant</th><th>Granted (UTC)</th><th>State</th><th>Cleanup</th></tr></thead><tbody>${rows}</tbody></table></div>${rows ? "" : "<p>No grants.</p>"}</section>${next}`;
	return renderOwnerShell("grants", content, view.service);
}
