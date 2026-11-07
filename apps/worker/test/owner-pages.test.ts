import { renderBlobGcPage } from "@worker/transport/owner-pages/blob-gc";
import { renderClientsPage } from "@worker/transport/owner-pages/clients";
import { renderExportsPage } from "@worker/transport/owner-pages/exports";
import { renderGrantsPage } from "@worker/transport/owner-pages/grants";
import { renderMeasurementsPage } from "@worker/transport/owner-pages/measurements";
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
		expect(OWNER_CONSOLE_CSS).toContain(
			".owner-layout{display:flex;flex-wrap:wrap",
		);
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

	it("covers every client label and Remove form outcome", () => {
		const cases = [
			{
				label: "No accepted grants",
				generation: 0,
				grantCount: 0,
				activeGrantCount: 0,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				label: "Revoked",
				generation: 1,
				grantCount: 1,
				activeGrantCount: 0,
				cleanupPendingCount: 0,
				remove: "enabled",
			},
			{
				label: "Mixed active and revoked history",
				generation: 2,
				grantCount: 2,
				activeGrantCount: 1,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				label: "Active registry grant",
				generation: 1,
				grantCount: 1,
				activeGrantCount: 1,
				cleanupPendingCount: 0,
				remove: "absent",
			},
			{
				label: "Revoked",
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
			expect(html).toContain(`Registry state: ${row.label}`);
			expect(html).toContain(
				'<input type="hidden" name="csrf" value="csrf-test">',
			);
			expect(html).toContain(
				'<form method="post" action="/owner/clients/client-1/rename">',
			);
			expect(html).toContain(
				'<label>Name <input name="name" maxlength="80" value="Client"></label>',
			);
			expect(html).toContain(
				'<form method="post" action="/owner/clients/client-1/revoke">',
			);
			expect(html).toContain(">Rename</button>");
			expect(html).toContain(">Revoke</button>");
			const removeForm =
				'<form method="post" action="/owner/clients/client-1/remove"><input type="hidden" name="csrf" value="csrf-test"><button';
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
			encodedClientId: "id%3C%26",
			nextCursor: "a&b",
			encodedCursor: "a%26b",
			grants: [
				{ grantId: "grant&lt;&amp;", revoked: false, cleanupPending: false },
				{ grantId: "grant-2", revoked: true, cleanupPending: true },
			],
		});
		expect(grantsHtml).toContain(
			'<a href="/owner/clients" aria-current="location">Clients</a>',
		);
		expect(grantsHtml).toMatchSnapshot();
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
				p95: null,
				first_sample_at: null,
				last_sample_at: null,
				stale: false,
			},
			storage: {
				database_bytes: { status: "unknown", reason: "storage_error" },
				referenced_blob_bytes: { status: "observed", value: 2048 },
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
		expect(html).toContain("Fresh or stale");
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
			totalBytes: 1024,
			snapshots: [
				{
					createdAt: "2026-11-07T17:00:00.000Z",
					size: 1024,
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
			bucketName: "Unknown (R2_BUCKET binding)",
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
		expect(html).toContain("Bucket: Unknown (R2_BUCKET binding).");
		expect(html).toContain("Backups are excluded");
		expect(html).toContain("mark fence protects published blobs");
		expect(html).toContain('<form method="post" action="/owner/blob-gc">');
		expect(html).toContain('<input type="hidden" name="csrf" value="gc-csrf">');
		expect(html).toMatchSnapshot();
	});

	it.each([
		["idle", "Inventory"],
		["marking", "Mark"],
		["deleting", "Delete"],
	] as const)("highlights %s blob cleanup phase", (phase, step) => {
		const html = renderBlobGcPage({
			csrf: "phase-csrf",
			bucketName: "Unknown (R2_BUCKET binding)",
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
