import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";

/** Raw optional service facts. The shell escapes every value before HTML output. */
export interface OwnerServiceMetadata {
	/** Host from SERVICE_ORIGIN, including its port when one is set. */
	serviceHost?: string;
	/**
	 * Worker package version that the handler embeds at build time.
	 * The shell omits the line when absent, so tests stay independent of release bumps.
	 */
	workerVersion?: string;
	/** Current epoch for the selected vault when the handler can prove it. */
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
		...(metadata.workerVersion
			? [
					`<p><span class="label">Worker</span> ${escapeServiceText(metadata.workerVersion)}</p>`,
				]
			: []),
		...(metadata.vaultEpoch
			? [
					`<p><span class="label">Vault epoch</span> ${escapeServiceText(metadata.vaultEpoch)}</p>`,
				]
			: []),
	].join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vaultwire · Owner console</title><style>${OWNER_CONSOLE_CSS}</style></head><body><div class="owner-layout"><aside class="owner-sidebar"><div class="brand"><span class="brand-mark" aria-hidden="true">◇</span>Vaultwire</div><p class="owner-eyebrow">Owner console</p><nav class="owner-nav" aria-label="Owner navigation">${nav}</nav><section class="owner-service"><h2>Service</h2>${facts}</section></aside><main class="owner-main">${content}</main></div></body></html>`;
}
