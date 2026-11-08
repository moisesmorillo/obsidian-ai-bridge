import { formatCount } from "@worker/transport/owner-pages/format";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Escaped client facts and preserved owner form values for one page. */
export interface ClientsPageViewModel {
	csrf: string;
	nextCursor: string | null;
	encodedCursor: string | null;
	service?: OwnerServiceMetadata;
	clients: readonly {
		clientId: string;
		encodedId: string;
		name: string;
		generation: number;
		grantCount: number;
		activeGrantCount: number;
		cleanupPendingCount: number;
	}[];
}

/** Render page-scoped client totals and protected actions from escaped facts. */
export function renderClientsPage(view: ClientsPageViewModel): string {
	const activeTotal = view.clients.reduce(
		(total, client) => total + client.activeGrantCount,
		0,
	);
	const revokedTotal = view.clients.reduce(
		(total, client) => total + client.grantCount - client.activeGrantCount,
		0,
	);
	const cleanupTotal = view.clients.reduce(
		(total, client) => total + client.cleanupPendingCount,
		0,
	);
	const rows = view.clients
		.map((client) => {
			const active = client.activeGrantCount > 0;
			const noGrants = client.grantCount === 0;
			const remove =
				client.generation > 0 && client.activeGrantCount === 0
					? `<div class="danger-zone"><form method="post" action="/owner/clients/${client.encodedId}/remove"><input type="hidden" name="csrf" value="${view.csrf}"><button class="button-danger"${client.cleanupPendingCount > 0 ? " disabled" : ""}>Remove</button></form>${client.cleanupPendingCount > 0 ? "<p>Complete provider cleanup before removal.</p>" : ""}</div>`
					: "";
			return `<tr><td><span class="client-name">${client.name || client.clientId}</span><span class="client-id">${client.clientId}</span></td><td>Unknown</td><td><span>${formatCount(client.activeGrantCount)}</span> <a class="button-secondary button-small" href="/owner/clients/${client.encodedId}/grants">View</a></td><td><span class="status-cell"><span class="status-dot${active ? " status-dot-copper" : ""}" aria-hidden="true"></span>${noGrants ? "No grants" : active ? "Active" : "Revoked"}</span></td><td><div class="client-actions"><details><summary>Rename</summary><form class="rename-form" method="post" action="/owner/clients/${client.encodedId}/rename"><input type="hidden" name="csrf" value="${view.csrf}"><label class="muted">Name <input name="name" maxlength="80" value="${client.name}"></label><button>Rename</button></form></details><form method="post" action="/owner/clients/${client.encodedId}/revoke"><input type="hidden" name="csrf" value="${view.csrf}"><button class="button-danger">Revoke</button></form>${remove}</div></td></tr>`;
		})
		.join("");
	const next = view.nextCursor
		? `<a href="/owner/clients?cursor=${view.encodedCursor}">Next page</a>`
		: "";
	const content = `<header class="page-header"><div><p class="owner-eyebrow">Registry</p><h1>Connected clients</h1><p>Manage registered clients and retained grant history.</p></div></header><section class="stat-grid" aria-label="Listed-page registry totals"><article class="card"><p class="label">Active grants on listed page</p><p class="stat-value">${formatCount(activeTotal)}</p><p class="footnote">Listed client page only.</p></article><article class="card"><p class="label">Revoked grants on listed page</p><p class="stat-value">${formatCount(revokedTotal)}</p><p class="footnote">Listed client page only.</p></article><article class="card"><p class="label">Cleanup pending on listed page</p><p class="stat-value">${formatCount(cleanupTotal)}</p><p class="footnote">Listed client page only.</p></article></section><section class="panel"><div class="table-scroll"><table><thead><tr><th>Client</th><th>Kind</th><th>Grants</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>${rows ? '<p class="table-footnote">Grant counts show retained grant history. Active registry grants do not prove that provider tokens are current or unexpired.</p>' : "<p>No connected clients.</p>"}</section>${next}`;
	return renderOwnerShell("clients", content, view.service);
}
