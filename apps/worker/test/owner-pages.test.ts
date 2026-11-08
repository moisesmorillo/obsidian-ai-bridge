import { renderBlobGcPage } from "@worker/transport/owner-pages/blob-gc";
import { renderClientsPage } from "@worker/transport/owner-pages/clients";
import { renderExportsPage } from "@worker/transport/owner-pages/exports";
import {
	formatBytes,
	formatCount,
	formatDuration,
	formatUtcDateTime,
	formatUtcTime,
} from "@worker/transport/owner-pages/format";
import { renderGrantsPage } from "@worker/transport/owner-pages/grants";
import { renderMeasurementsPage } from "@worker/transport/owner-pages/measurements";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";
import { OWNER_CONSOLE_CSS } from "@worker/transport/owner-pages/tokens.css";
import { describe, expect, it } from "vitest";

describe("owner page rendering", () => {
	it("uses the approved palette only in root tokens and keeps responsive layout", () => {
		const root = OWNER_CONSOLE_CSS.match(/:root\{([^}]*)\}/)?.[1] ?? "";
		const tokens = Object.fromEntries(
			[...root.matchAll(/(--[\w-]+):(#(?:[\da-fA-F]{3}){1,2})/g)].map(
				([, name, value]) => [name, value],
			),
		);
		expect(tokens).toMatchObject({
			"--base": "#191724",
			"--surface": "#1f1d2e",
			"--overlay": "#26233a",
			"--muted": "#6e6a86",
			"--subtle": "#908caa",
			"--text": "#e0def4",
			"--love": "#eb6f92",
			"--gold": "#f6c177",
			"--rose": "#ebbcba",
			"--pine": "#31748f",
			"--foam": "#9ccfd8",
			"--iris": "#c4a7e7",
			"--highlight-low": "#21202e",
			"--highlight-med": "#403d52",
			"--highlight-high": "#524f67",
		});
		const outsideRoot = OWNER_CONSOLE_CSS.replace(/:root\{[^}]*\}/, "");
		expect(outsideRoot).not.toMatch(/#[\da-fA-F]{3,8}\b|rgba?\(/);
		expect(outsideRoot).not.toContain("radial-gradient");
		expect(outsideRoot).not.toContain("background-attachment:fixed");
		expect(OWNER_CONSOLE_CSS).toContain(
			".owner-layout{display:flex;flex-wrap:wrap",
		);
		expect(OWNER_CONSOLE_CSS).toContain("max-width: 390px");
		expect(OWNER_CONSOLE_CSS).toContain("overflow-x:auto");
		expect(OWNER_CONSOLE_CSS).toContain("padding:16px");
		expect(OWNER_CONSOLE_CSS).toContain("height:40px;padding:0 16px");
		expect(OWNER_CONSOLE_CSS).toContain("padding:36px 44px");
		expect(OWNER_CONSOLE_CSS).toContain("padding:20px 22px");
		expect(OWNER_CONSOLE_CSS).toContain("padding:14px 18px");
		expect(OWNER_CONSOLE_CSS).toContain("grid-template-columns:1fr");
	});

	it("applies surface and overlay backgrounds to the sidebar and about panel", () => {
		expect(OWNER_CONSOLE_CSS).toContain(
			".owner-sidebar{flex:1 1 240px;max-width:256px;padding:24px 0 24px 24px;background:var(--surface)}",
		);
		expect(OWNER_CONSOLE_CSS).toContain(
			".about-panel{background:var(--overlay)}",
		);
	});

	it("meets WCAG contrast targets from declared palette tokens", () => {
		const root = OWNER_CONSOLE_CSS.match(/:root\{([^}]*)\}/)?.[1] ?? "";
		const tokens = Object.fromEntries(
			[...root.matchAll(/(--[\w-]+):(#(?:[\da-fA-F]{3}){1,2})/g)].map(
				([, name, value]) => [name, value],
			),
		);
		/** Compute relative luminance from a declared six-digit CSS token. */
		const luminance = (hex: string): number => {
			const channels = hex
				.match(/[\da-fA-F]{2}/g)
				?.map((part) => Number.parseInt(part, 16) / 255);
			if (!channels || channels.length !== 3)
				throw new Error(`Invalid color ${hex}`);
			const linear = channels.map((channel) =>
				channel <= 0.04045
					? channel / 12.92
					: ((channel + 0.055) / 1.055) ** 2.4,
			);
			return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
		};
		/** Compute the WCAG contrast ratio for two parsed palette tokens. */
		const contrast = (foreground: string, background: string): number => {
			const values = [luminance(foreground), luminance(background)].sort(
				(a, b) => b - a,
			);
			return (values[0] + 0.05) / (values[1] + 0.05);
		};
		for (const background of ["--base", "--surface", "--overlay"])
			expect(
				contrast(tokens["--text"], tokens[background]),
			).toBeGreaterThanOrEqual(4.5);
		expect(
			contrast(tokens["--subtle"], tokens["--surface"]),
		).toBeGreaterThanOrEqual(4.5);
		expect(contrast(tokens["--base"], tokens["--rose"])).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("renders escaped service metadata in the shared owner shell", () => {
		const html = renderOwnerShell("clients", "<h1>Connected clients</h1>", {
			serviceHost: "service.test&lt;&amp;",
			workerVersion: "1.2.3<",
			vaultEpoch: "epoch-1",
		});
		expect(html).toContain("service.test&amp;lt;&amp;amp;");
		expect(html).toContain('<span class="label">Worker</span> 1.2.3&lt;');
		expect(html).toContain('<span class="label">Vault epoch</span> epoch-1');
		expect(html).not.toContain("Service metadata unknown");
	});

	it("omits the Worker line when the handler passes no version", () => {
		const html = renderOwnerShell("clients", "<h1>Connected clients</h1>");
		expect(html).not.toContain('<span class="label">Worker</span>');
		expect(html).toContain(
			'<section class="owner-service"><h2>Service</h2></section>',
		);
	});

	it("formats decimal megabytes, short counts, durations, and UTC values", () => {
		expect(formatBytes(11_800_000)).toBe("11.8 MB");
		expect(formatBytes(512)).toBe("under 0.1 MB");
		expect(formatCount(1_200)).toBe("1.2k");
		expect(formatDuration(156)).toBe("156 ms");
		expect(formatUtcDateTime("2026-11-08T00:00:00.000Z")).toBe(
			"2026-11-08 00:00 UTC",
		);
		expect(formatUtcTime(Date.UTC(2026, 10, 8, 0, 2))).toBe("00:02");
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
		expect(
			renderClientsPage({
				csrf: "state-3",
				nextCursor: null,
				encodedCursor: null,
				clients: [],
			}),
		).not.toContain("Collect unreferenced blobs");
	});

	it("covers every client label and Remove form outcome", () => {
		const cases = [
			{
				state: "No grants",
				generation: 0,
				grantCount: 0,
				activeGrantCount: 0,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				state: "Revoked",
				generation: 1,
				grantCount: 1,
				activeGrantCount: 0,
				cleanupPendingCount: 0,
				remove: "enabled",
			},
			{
				state: "Active",
				generation: 2,
				grantCount: 2,
				activeGrantCount: 1,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				state: "Active",
				generation: 1,
				grantCount: 1,
				activeGrantCount: 1,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				state: "Revoked",
				generation: 1,
				grantCount: 1,
				activeGrantCount: 0,
				cleanupPendingCount: 1,
				remove: "disabled",
			},
		] as const;
		for (const row of cases) {
			const html = renderClientsPage({
				csrf: "csrf-test",
				nextCursor: null,
				encodedCursor: null,
				clients: [
					{
						clientId: "client-1",
						encodedId: "client-1",
						name: "Client",
						generation: row.generation,
						grantCount: row.grantCount,
						activeGrantCount: row.activeGrantCount,
						cleanupPendingCount: row.cleanupPendingCount,
					},
				],
			});
			expect(html).toContain(`>${row.state}</span>`);
			expect(html).toContain(
				'<input type="hidden" name="csrf" value="csrf-test">',
			);
			expect(html).toContain(
				'<form class="rename-form" method="post" action="/owner/clients/client-1/rename">',
			);
			expect(html).toContain(
				'<input name="name" maxlength="80" value="Client">',
			);
			expect(html).toContain(
				'<form method="post" action="/owner/clients/client-1/revoke">',
			);
			expect(html).toContain(">Rename</button>");
			expect(html).toContain(">Revoke</button>");
			const removeForm =
				'<form method="post" action="/owner/clients/client-1/remove"><input type="hidden" name="csrf" value="csrf-test"><button class="button-danger"';
			if (row.remove === "absent") expect(html).not.toContain(removeForm);
			if (row.remove === "enabled")
				expect(html).toContain(`${removeForm}>Remove</button></form>`);
			if (row.remove === "disabled")
				expect(html).toContain(`${removeForm} disabled>Remove</button></form>`);
			expect(html.match(/name="csrf" value="csrf-test"/g)).toHaveLength(
				row.remove === "absent" ? 2 : 3,
			);
		}
	});

	it("renders grant states, encoded pagination, and empty state", () => {
		const grantsHtml = renderGrantsPage({
			clientId: "id&lt;&amp;",
			clientName: "Display name",
			clientKind: "Unknown",
			activeGrantCount: 1,
			cleanupPendingCount: 1,
			encodedClientId: "id%3C%26",
			nextCursor: "a&b",
			encodedCursor: "a%26b",
			grants: [
				{
					grantId: "grant&lt;&amp;",
					createdAt: Date.UTC(2026, 10, 8),
					revoked: false,
					cleanupPending: false,
				},
				{
					grantId: "grant-2",
					createdAt: null,
					revoked: true,
					cleanupPending: true,
				},
			],
		});
		expect(grantsHtml).toContain(
			'<a href="/owner/clients" aria-current="location">Clients</a>',
		);
		expect(grantsHtml).toContain("Clients / Display name");
		expect(grantsHtml).toContain("2026-11-08 00:00 UTC");
		expect(grantsHtml).toContain("Unknown</td>");
		expect(grantsHtml).toMatchSnapshot();
		expect(
			renderGrantsPage({
				clientId: "empty",
				clientName: "Empty client",
				clientKind: "Unknown",
				activeGrantCount: 0,
				cleanupPendingCount: 0,
				encodedClientId: "empty",
				nextCursor: null,
				encodedCursor: null,
				grants: [],
			}),
		).toContain("No grants.");
	});

	it("renders measurements with explicit unknowns and preserved measurement facts", () => {
		const html = renderMeasurementsPage({
			status: "observed",
			coverage: "partial",
			day_start: Date.UTC(2026, 10, 7),
			day_end: Date.UTC(2026, 10, 8),
			observed_from: null,
			observed_through: null,
			requests: {
				status: "observed",
				count: 12,
				observed_from: null,
				observed_through: null,
				rest_count: 8,
				mcp_count: 4,
				stale: true,
				clients: [
					{
						client_id: "client&lt;&amp;",
						requests_rest: 8,
						requests_mcp: 4,
						last_feed_request_at: null,
						minimum_poll_interval_ms: null,
						maximum_poll_interval_ms: null,
						poll_cadence_incomplete: true,
					},
				],
			},
			feed_latency: {
				status: "observed",
				unit: "milliseconds",
				sample_count: 2,
				total_sample_count: 3,
				p95: 156,
				first_sample_at: null,
				last_sample_at: null,
				stale: false,
			},
			storage: {
				database_bytes: { status: "unknown", reason: "storage_error" },
				referenced_blob_bytes: { status: "observed", value: 3_200_000 },
			},
			worker_isolate: {
				isolate_id: "isolate-1",
				active_slots: 2,
				available_slots: 2,
				limit: 4,
				expired_count: 1,
				deadline_ms: 1000,
			},
		});
		expect(html).toContain("Unknown (storage_error)");
		expect(html).toContain("Stale");
		expect(html).toContain("3.2 MB");
		expect(html).toContain("156 ms");
		expect(html).toContain("About these numbers");
		expect(html).toContain(
			"UTC window 00:00 to 23:59, observed Unknown to Unknown, coverage partial",
		);
		expect(html).toContain("Request observation window: Unknown to Unknown.");
		expect(html).toContain("Retained sample window: Unknown to Unknown.");
		expect(html).toContain("<td>Unknown</td>");
		expect(html).toContain("unknown (out-of-order requests)");
		expect(html).toContain("/owner/measurements");
		expect(html).toContain("Earlier samples were removed by the daily cap.");
		expect(html).toMatchSnapshot();
	});

	it("renders export forms, completed links, retained summary, and empty failures", () => {
		const html = renderExportsPage({
			csrf: "export-csrf",
			nextRun: "2026-11-07T18:00:00.000Z",
			lastSnapshot: "2026-11-07T17:00:00.000Z",
			retainedCount: 1,
			totalBytes: 106_000_000,
			snapshots: [
				{
					createdAt: "2026-11-07T17:00:00.000Z",
					size: 11_800_000,
					downloadUrl:
						"/owner/exports/epoch%2Fone/2026-11-07T17%3A00%3A00.000Z/download",
				},
			],
			failedExports: [],
		});
		expect(html).toMatchSnapshot();
		expect(html).toContain('<form method="post" action="/owner/exports">');
		expect(html).toContain(
			'<input type="hidden" name="csrf" value="export-csrf">',
		);
		expect(html).toContain(
			'href="/owner/exports/epoch%2Fone/2026-11-07T17%3A00%3A00.000Z/download"',
		);
		expect(html).toContain("11.8 MB");
		expect(html).toContain("106.0 MB");
		expect(html).toContain("2026-11-07 17:00 UTC");
		expect(html).toContain("No failed exports.");
		const failed = renderExportsPage({
			csrf: "failed-csrf",
			nextRun: "2026-11-07T18:00:00.000Z",
			lastSnapshot: null,
			retainedCount: null,
			totalBytes: null,
			snapshots: [],
			failedExports: [
				{
					createdAt: "2026-11-07T16:00:00.000Z",
					failure: "export_source_unavailable",
				},
			],
		});
		expect(failed).toContain("export_source_unavailable");
		expect(failed).not.toContain("Retained completed snapshots");
		expect(failed).toContain("No completed exports.");
	});

	it("renders blob cleanup safety, current phase, form, and unavailable inventory", () => {
		const html = renderBlobGcPage({
			csrf: "gc-csrf",
			preview: null,
			status: {
				phase: "deleting",
				marked_count: 2,
				marked_bytes: 512,
				delete_state: "unknown",
				failure: "blob_gc_unavailable",
			},
		});
		expect(html).toContain("unavailable");
		expect(html).toContain("Dry run unavailable.");
		expect(html).not.toContain("Bucket:");
		expect(html).not.toContain("Inventory pages scanned:");
		expect(html).toContain("Backups are excluded");
		expect(html).toContain("mark fence protects published blobs");
		expect(html).toContain("under 0.1 MB");
		expect(html).toContain('<form method="post" action="/owner/blob-gc">');
		expect(html).toContain('<input type="hidden" name="csrf" value="gc-csrf">');
		expect(html).toMatchSnapshot();
	});

	it.each([
		["idle", "Inventory"],
		["marking", "Mark"],
		["deleting", "Delete"],
	] as const)("highlights %s blob cleanup phase", (phase:
		| "idle"
		| "marking"
		| "deleting", step: string) => {
		const html = renderBlobGcPage({
			csrf: "phase-csrf",
			preview: null,
			status: {
				phase,
				marked_count: 0,
				marked_bytes: 0,
				delete_state: "idle",
				failure: null,
			},
		});
		expect(html).toContain(
			`<li class="collection-step step-current" aria-current="step">${step}</li>`,
		);
	});
});
