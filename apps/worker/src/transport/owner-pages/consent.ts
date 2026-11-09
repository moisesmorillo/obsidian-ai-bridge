import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";
import { BRAND_MARK_SVG } from "@worker/transport/owner-pages/shell";

/** Escaped display values for one provider authorization request. */
export interface ConsentPageViewModel {
	/** Client display name escaped for HTML text and title contexts. */
	clientName: string;
	/** Service host escaped for display beside the brand. */
	host: string;
	/** Provider callback URI escaped for HTML text. */
	redirectUri: string;
	/** Escaped provider request time, or null when the provider gives none. */
	requestedOn: string | null;
	/** Protocol scope identifiers escaped for HTML text. */
	scopes: string[];
	/** Provider consent handle escaped for an HTML attribute. */
	handle: string;
}

/** Render the Access-protected OAuth consent page from escaped display values. */
export function renderConsentPage(view: ConsentPageViewModel): string {
	const requestedOn = view.requestedOn
		? `<div><dt>Requested on</dt><dd>${view.requestedOn}</dd></div>`
		: "";
	const scopes = view.scopes
		.map(
			(scope) =>
				`<li><span class="consent-check" aria-hidden="true">✓</span><span>${scope}</span></li>`,
		)
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${view.clientName} · Vaultwire</title><style>${OWNER_CONSOLE_CSS}\nbody.consent-page{display:grid;min-height:100vh;place-items:center;padding:24px}.consent-wrap{width:min(100%,560px)}.consent-brand{display:flex;align-items:center;gap:12px;margin:0 0 24px;color:var(--text)}.consent-brand-copy{display:grid}.consent-host{color:var(--subtle);font-size:12px}.consent-card{max-width:560px;background:var(--surface);border-color:var(--highlight-med);box-shadow:none}.consent-details{display:grid;gap:12px;margin:24px 0;padding:16px;background:var(--overlay);border:1px solid var(--highlight-med);border-radius:12px}.consent-details div{display:grid;grid-template-columns:140px minmax(0,1fr);gap:12px}.consent-details dt{color:var(--subtle);font-size:12px}.consent-details dd{margin:0;overflow-wrap:anywhere}.consent-scopes{display:grid;gap:10px;padding:0;list-style:none}.consent-scopes li{display:flex;align-items:center;gap:10px}.consent-check{color:var(--rose);font-weight:700}.consent-form{display:grid;gap:16px;margin-top:24px}.consent-form label{display:grid;gap:6px}.consent-form input{padding:10px;border:1px solid var(--highlight-med);border-radius:12px;background:var(--highlight-low);color:var(--text)}.consent-actions{display:flex;justify-content:flex-end;gap:10px}.consent-deny{order:0;border:1px solid var(--highlight-high);background:transparent;color:var(--text)}.consent-deny:hover,.consent-deny:active{background:transparent;border-color:var(--highlight-high);color:var(--text)}.consent-actions button[name="decision"][value="approve"]{order:1}.consent-footer{margin-top:20px;color:var(--subtle);font-size:12px}@media(max-width:560px){body.consent-page{padding:16px}.consent-details div{grid-template-columns:1fr;gap:2px}.consent-actions{flex-direction:column}.consent-actions button{width:100%}}</style></head><body class="consent-page"><div class="consent-wrap"><header class="consent-brand"><span class="brand-mark" aria-hidden="true">${BRAND_MARK_SVG}</span><span class="consent-brand-copy"><strong>Vaultwire</strong><span class="consent-host">${view.host}</span></span></header><main class="card card-highlight consent-card"><p class="owner-eyebrow">Authorization request</p><h1>Authorize ${view.clientName}</h1><p>Review the requested permissions before you continue.</p><dl class="consent-details"><div><dt>Application</dt><dd>${view.clientName}</dd></div><div><dt>Redirect URI</dt><dd>${view.redirectUri}</dd></div>${requestedOn}</dl><h2>Permissions requested</h2><ul class="consent-scopes">${scopes}</ul><form class="consent-form" method="post" action="/authorize/consent"><input type="hidden" name="handle" value="${view.handle}"><label>Client name <input name="client_name" maxlength="80"></label><div class="consent-actions"><button name="decision" value="approve">Approve access</button><button class="consent-deny" name="decision" value="deny">Deny</button></div></form></main><footer class="consent-footer">Protected by Cloudflare Access. Revoke later from Connected clients.</footer></div></body></html>`;
}
