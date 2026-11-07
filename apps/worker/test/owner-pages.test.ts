import { renderClientsPage } from "@worker/transport/owner-pages/clients";
import { renderGrantsPage } from "@worker/transport/owner-pages/grants";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";
import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";
import { describe, expect, it } from "vitest";

describe("owner page rendering", () => {
	it("contains the approved palette and responsive phone layout", () => {
		for (const token of [
			"--bg: #080506",
			"--wine-900: #1A0810",
			"--wine-700: #4E0E1F",
			"--wine-500: #962042",
			"--wine-300: #F29AB4",
			"--copper: #E08A5F",
			"--copper-light: #F0AB8A",
			"--copper-dark: #B86038",
			"--text: #F2ECEA",
			"--text-strong: #FAF4F0",
			"--text-soft: #D2BDC1",
			"--text-muted: #AE8F96",
			"--danger: #FF9B9B",
		])
			expect(OWNER_CONSOLE_CSS).toContain(token);
		expect(OWNER_CONSOLE_CSS).toContain("max-width: 390px");
		expect(OWNER_CONSOLE_CSS).toContain("overflow-x:auto");
		expect(OWNER_CONSOLE_CSS).toContain("padding:16px");
	});

	it("renders the shared owner shell", () => {
		expect(
			renderOwnerShell("clients", "<h1>Connected clients</h1>"),
		).toMatchSnapshot();
	});

	it("renders client states, protected actions, and empty state", () => {
		expect(
			renderClientsPage({
				csrf: "state-1",
				nextCursor: "a&b",
				encodedCursor: "a%26b",
				clients: [
					{
						clientId: "id&lt;&amp;",
						encodedId: "id%3C%26",
						name: "&lt;script&gt;",
						generation: 1,
						grantCount: 2,
						activeGrantCount: 0,
						cleanupPendingCount: 1,
					},
				],
			}),
		).toMatchSnapshot();
		expect(
			renderClientsPage({
				csrf: "state-2",
				nextCursor: null,
				encodedCursor: null,
				clients: [],
			}),
		).toContain("No connected clients.");
	});

	it("renders grant states, encoded pagination, and empty state", () => {
		expect(
			renderGrantsPage({
				clientId: "id&lt;&amp;",
				encodedClientId: "id%3C%26",
				nextCursor: "a&b",
				encodedCursor: "a%26b",
				grants: [
					{ grantId: "grant&lt;&amp;", revoked: false, cleanupPending: false },
					{ grantId: "grant-2", revoked: true, cleanupPending: true },
				],
			}),
		).toMatchSnapshot();
		expect(
			renderGrantsPage({
				clientId: "empty",
				encodedClientId: "empty",
				nextCursor: null,
				encodedCursor: null,
				grants: [],
			}),
		).toContain("No grants.");
	});
});
