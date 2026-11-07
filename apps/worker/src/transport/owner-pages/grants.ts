import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Escaped grant rows and encoded navigation values for the grants page. */
export interface GrantsPageViewModel {
	clientId: string;
	encodedClientId: string;
	nextCursor: string | null;
	encodedCursor: string | null;
	grants: readonly {
		grantId: string;
		revoked: boolean;
		cleanupPending: boolean;
	}[];
}

/** Render registry grant states without reading or changing registry data. */
export function renderGrantsPage(view: GrantsPageViewModel): string {
	const rows = view.grants
		.map((grant) => {
			const state = grant.revoked ? "Revoked" : "Active registry grant";
			const cleanup = grant.cleanupPending
				? "provider cleanup pending"
				: grant.revoked
					? "provider cleanup complete"
					: "provider cleanup not pending";
			return `<tr><td>${grant.grantId}</td><td><span class="chip">${state}</span></td><td>${cleanup}</td></tr>`;
		})
		.join("");
	const next = view.nextCursor
		? `<a href="/owner/clients/${view.encodedClientId}/grants?cursor=${view.encodedCursor}">Next page</a>`
		: "";
	return renderOwnerShell(
		"grants",
		`<p class="owner-eyebrow">Clients / ${view.clientId}</p><h1>Client grants</h1><div class="table-scroll"><table><thead><tr><th>Grant</th><th>Registry state</th><th>Provider cleanup</th></tr></thead><tbody>${rows}</tbody></table></div>${rows ? "" : '<p class="panel">No grants.</p>'}${next}`,
	);
}
