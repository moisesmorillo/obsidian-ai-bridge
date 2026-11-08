import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";
import { WORKER_VERSION } from "@worker/transport/owner-pages/version";

/** Optional service facts known to the current owner handler. */
export interface OwnerServiceMetadata {
	serviceHost?: string;
	vaultEpoch?: string;
}

/** Escape dynamic service facts before they enter the inline HTML shell. */
function escapeServiceText(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? character;
	});
}

/** Build the shared owner frame with escaped service facts and current navigation. */
export function renderOwnerShell(
	active: "clients" | "grants" | "measurements" | "exports" | "blob-gc",
	content: string,
	metadata: OwnerServiceMetadata = {},
): string {
	const links = [
		["clients", "/owner/clients", "Clients"],
		["measurements", "/owner/measurements?format=html", "Measurements"],
		["exports", "/owner/exports", "Backups"],
		["blob-gc", "/owner/blob-gc", "Blob cleanup"],
	] as const;
	const activeSection = active === "grants" ? "clients" : active;
	const nav = links
		.map(([key, href, label]) => {
			const current = key === activeSection;
			const ariaCurrent = current
				? active === key
					? "page"
					: "location"
				: null;
			return `<a href="${href}"${ariaCurrent ? ` aria-current="${ariaCurrent}"` : ""}>${label}</a>`;
		})
		.join("");
	const facts = [
		...(metadata.serviceHost
			? [
					`<p><span class="label">Host</span> ${escapeServiceText(metadata.serviceHost)}</p>`,
				]
			: []),
		`<p><span class="label">Worker</span> ${WORKER_VERSION}</p>`,
		...(metadata.vaultEpoch
			? [
					`<p><span class="label">Vault epoch</span> ${escapeServiceText(metadata.vaultEpoch)}</p>`,
				]
			: []),
	].join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner console</title><style>${OWNER_CONSOLE_CSS}</style></head><body><div class="owner-layout"><aside class="owner-sidebar"><div class="brand"><span class="brand-mark" aria-hidden="true">◇</span>AI Bridge</div><p class="owner-eyebrow">Owner console</p><nav class="owner-nav" aria-label="Owner navigation">${nav}</nav><section class="owner-service"><h2>Service</h2>${facts}</section></aside><main class="owner-main">${content}</main></div></body></html>`;
}
