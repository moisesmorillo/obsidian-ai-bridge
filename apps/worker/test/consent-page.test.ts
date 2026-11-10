import { VaultScopeSchema } from "@vaultwire/protocol";
import { renderConsentPage } from "@worker/transport/owner-pages/consent";
import { describe, expect, it } from "vitest";

describe("consent page rendering", () => {
	it("renders escaped authorization details and protocol scopes", () => {
		const html = renderConsentPage({
			clientName: "Client &lt;script&gt;",
			host: "service.test&amp;host",
			redirectUri: "https://client.test/callback?a=1&amp;b=2",
			requestedOn: "Nov 7, 2026 at 9:30 PM",
			scopes: [...VaultScopeSchema.options],
			handle: "handle&amp;value",
		});

		expect(html).toMatchSnapshot();
		expect(html).toContain("service.test&amp;host");
		expect(html).toContain("Nov 7, 2026 at 9:30 PM");
		for (const scope of VaultScopeSchema.options) expect(html).toContain(scope);
		expect(html).toContain("read notes (needed)");
		expect(html).toContain("create and edit notes");
		expect(html).toContain("delete notes");
		expect(html).toContain(
			".consent-scopes{display:grid;gap:10px;margin:8px 0 0;padding:0;list-style:none}",
		);
		expect(html).toContain(
			".consent-form{display:grid;gap:16px;margin-top:12px}",
		);
		expect(html).toContain(
			'.consent-scopes input[type="checkbox"]{appearance:auto;flex:0 0 18px;width:18px;height:18px;margin:1px 0 0;padding:0;border:0;border-radius:2px;background:transparent;accent-color:var(--rose);cursor:pointer}',
		);
		expect(html).toContain(
			'.consent-scopes input[type="checkbox"]:focus{outline:2px solid var(--rose);outline-offset:3px}',
		);
		expect(html).toContain(
			'<li><label class="consent-scope"><input type="checkbox" checked disabled aria-label="vault:read is required"><input type="hidden" name="scope" value="vault:read"><span class="consent-scope-copy"><span class="consent-scope-name">vault:read</span><span class="consent-scope-description">read notes (needed)</span></span></label></li>',
		);
		for (const scope of VaultScopeSchema.options.filter(
			(scope) => scope !== "vault:read",
		)) {
			expect(html).toContain(
				`<li><label class="consent-scope"><input type="checkbox" name="scope" value="${scope}" checked><span class="consent-scope-copy"><span class="consent-scope-name">${scope}</span>`,
			);
		}
		for (const scope of VaultScopeSchema.options.filter(
			(scope) => scope !== "vault:read",
		)) {
			expect(html).toContain(
				`<input type="checkbox" name="scope" value="${scope}" checked>`,
			);
		}
		expect(html).toContain(
			'<input type="checkbox" checked disabled aria-label="vault:read is required">',
		);
		expect(html).toContain(
			'<input type="hidden" name="scope" value="vault:read">',
		);
	});

	it("omits the request date when provider metadata has none", () => {
		const html = renderConsentPage({
			clientName: "Synthetic client",
			host: "service.test",
			redirectUri: "https://client.test/callback",
			requestedOn: null,
			scopes: ["vault:read"],
			handle: "consent-handle",
		});

		expect(html).toContain("vault:read");
		expect(html).toContain('type="hidden" name="scope" value="vault:read"');
		expect(html).not.toContain("Requested on");
	});

	it("preserves the provider consent form contract", () => {
		const html = renderConsentPage({
			clientName: "Synthetic client",
			host: "service.test",
			redirectUri: "https://client.test/callback",
			requestedOn: null,
			scopes: [],
			handle: "consent-handle",
		});

		expect(html).toContain(
			'<form class="consent-form" method="post" action="/authorize/consent">',
		);
		expect(html).toContain(
			'<input type="hidden" name="handle" value="consent-handle">',
		);
		expect(html).toContain(
			'<label>Client name <input name="client_name" maxlength="80"></label>',
		);
		expect(html).toContain(
			'<button name="decision" value="approve">Approve access</button>',
		);
		expect(html).toContain(
			'<button class="consent-deny" name="decision" value="deny">Deny</button>',
		);
		const decisionValues = Array.from(
			html.matchAll(
				/<button\b[^>]*name="decision"[^>]*value="(approve|deny)"/g,
			),
			(match) => match[1],
		);
		expect(decisionValues).toEqual(["approve", "deny"]);
		expect(html).toContain(
			".consent-actions{display:flex;justify-content:flex-end;gap:10px}",
		);
		expect(html).toContain(".consent-deny{order:0;");
		expect(html).toContain(
			".consent-deny:hover,.consent-deny:active{background:transparent;border-color:var(--highlight-high);color:var(--text)}",
		);
		expect(html).toContain(
			'.consent-actions button[name="decision"][value="approve"]{order:1',
		);
		expect(html).toContain(
			"@media(max-width:560px){body.consent-page{padding:16px}",
		);
		expect(html).toContain(".consent-actions{flex-direction:column}");
		expect(html).toContain(".consent-actions button{width:100%}");
	});
});
