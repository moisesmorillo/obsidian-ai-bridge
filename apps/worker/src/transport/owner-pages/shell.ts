import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";

/** Build the shared owner frame with one active navigation item. */
export function renderOwnerShell(
	active: "clients" | "grants",
	content: string,
): string {
	const links = [
		["clients", "/owner/clients", "Clients"],
		["measurements", "/owner/measurements?format=html", "Measurements"],
		["exports", "/owner/exports", "Exports"],
		["blob-gc", "/owner/blob-gc", "Blob collection"],
	] as const;
	const nav = links
		.map(
			([key, href, label]) =>
				`<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner console</title><style>${OWNER_CONSOLE_CSS}</style></head><body><div class="owner-layout"><aside class="owner-sidebar"><div class="brand"><span class="brand-mark" aria-hidden="true">◇</span>AI Bridge</div><p class="owner-eyebrow">Owner console</p><nav class="owner-nav" aria-label="Owner navigation">${nav}</nav><section class="owner-service"><h2>Service</h2><p><span class="status-dot" aria-hidden="true"></span> Service metadata unknown</p></section></aside><main class="owner-main">${content}</main></div></body></html>`;
}
