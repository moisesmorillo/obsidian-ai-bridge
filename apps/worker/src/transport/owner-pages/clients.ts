import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Escaped client data and preserved owner form values for one page. */
export interface ClientsPageViewModel {
	csrf: string;
	nextCursor: string | null;
	encodedCursor: string | null;
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

/** Render the escaped client list without performing registry or encoding work. */
export function renderClientsPage(view: ClientsPageViewModel): string {
	const rows = view.clients
		.map((client) => {
			const state =
				client.grantCount === 0
					? "No accepted grants"
					: client.activeGrantCount === 0
						? "Revoked"
						: client.activeGrantCount < client.grantCount
							? "Mixed active and revoked history"
							: "Active registry grant";
			const cleanup =
				client.cleanupPendingCount === 0
					? "No provider cleanup pending"
					: `${client.cleanupPendingCount} provider cleanup pending`;
			const remove =
				client.generation > 0 && client.activeGrantCount === 0
					? `<form method="post" action="/owner/clients/${client.encodedId}/remove"><input type="hidden" name="csrf" value="${view.csrf}"><button${client.cleanupPendingCount > 0 ? " disabled" : ""}>Remove</button></form>${client.cleanupPendingCount > 0 ? "<p>Use Revoke to complete provider cleanup before removal.</p>" : ""}`
					: "";
			return `<article class="card"><h2>${client.name || client.clientId}</h2><p>Client: ${client.clientId}</p><p>Registry state: ${state}</p><p>${cleanup}</p><p>Grant counts show retained grant history. Active registry grants do not prove that provider tokens are current or unexpired.</p><a href="/owner/clients/${client.encodedId}/grants">View grants (${client.grantCount})</a><form method="post" action="/owner/clients/${client.encodedId}/rename"><input type="hidden" name="csrf" value="${view.csrf}"><label>Name <input name="name" maxlength="80" value="${client.name}"></label><button>Rename</button></form><form method="post" action="/owner/clients/${client.encodedId}/revoke"><input type="hidden" name="csrf" value="${view.csrf}"><button>Revoke</button></form>${remove}</article>`;
		})
		.join("");
	const next = view.nextCursor
		? `<a href="/owner/clients?cursor=${view.encodedCursor}">Next page</a>`
		: "";
	return renderOwnerShell(
		"clients",
		`<p class="owner-eyebrow">Registry</p><h1>Connected clients</h1><p>Manage registered clients and retained grant history.</p><p><a href="/owner/measurements?format=html">Service measurements</a> <a href="/owner/blob-gc">Collect unreferenced blobs</a></p><section class="card-grid">${rows || '<p class="panel">No connected clients.</p>'}</section>${next}`,
	);
}
