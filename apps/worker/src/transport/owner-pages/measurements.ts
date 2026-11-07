import type { MeasurementResponse } from "@obsidian-ai-bridge/protocol";
import { renderOwnerShell } from "@worker/transport/owner-pages/shell";

/** Owner measurements with provider-controlled labels escaped before rendering. */
export interface MeasurementsPageViewModel
	extends Omit<MeasurementResponse, "requests" | "worker_isolate"> {
	requests: Omit<MeasurementResponse["requests"], "clients"> & {
		clients: readonly (Omit<
			MeasurementResponse["requests"]["clients"][number],
			"client_id"
		> & { client_id: string })[];
	};
	worker_isolate?: Omit<
		NonNullable<MeasurementResponse["worker_isolate"]>,
		"isolate_id"
	> & { isolate_id: string };
}

/** Format one timestamp as UTC or preserve the explicit unknown state. */
function displayTimestamp(value: number | null | undefined): string {
	return value === null || value === undefined
		? "Unknown"
		: new Date(value).toISOString();
}

/** Render observations without implying unknown values are zero or capacity limits. */
function displayObservation(
	value: MeasurementResponse["storage"]["database_bytes"],
): string {
	return value.status === "observed"
		? String(value.value)
		: `Unknown (${value.reason ?? "not observed"})`;
}

/** Render the escaped measurement view model inside the shared owner shell. */
export function renderMeasurementsPage(
	view: MeasurementsPageViewModel,
): string {
	const requestWindow = `${displayTimestamp(view.requests.observed_from)} to ${displayTimestamp(view.requests.observed_through)}`;
	const dayWindow =
		view.day_start === null
			? "Unknown"
			: `${new Date(view.day_start).toISOString()} to ${new Date(view.day_end ?? view.day_start).toISOString()}`;
	const observedWindow = `${displayTimestamp(view.observed_from)} through ${displayTimestamp(view.observed_through)}`;
	const requestState = `${view.requests.status}, ${view.requests.stale ? "stale" : "fresh"}`;
	const latencyState = `${view.feed_latency.status}, ${view.feed_latency.stale ? "stale" : "fresh"}`;
	const sampleWindow = `${displayTimestamp(view.feed_latency.first_sample_at)} to ${displayTimestamp(view.feed_latency.last_sample_at)}`;
	const earlierSamples =
		view.feed_latency.total_sample_count > view.feed_latency.sample_count;
	const clients = view.requests.clients
		.map(
			(client) =>
				`<tr><td>${client.client_id}: REST ${client.requests_rest}, MCP ${client.requests_mcp}, total ${client.requests_rest + client.requests_mcp}</td><td>${client.requests_rest}</td><td>${client.requests_mcp}</td><td>${client.requests_rest + client.requests_mcp}</td><td>${displayTimestamp(client.last_feed_request_at)}</td><td>${client.poll_cadence_incomplete ? "unknown (out-of-order requests)" : `${client.minimum_poll_interval_ms ?? "unknown"}–${client.maximum_poll_interval_ms ?? "unknown"} ms`}</td></tr>`,
		)
		.join("");
	const clientTable = clients
		? `<div class="table-scroll"><table><thead><tr><th>Observed client</th><th>REST</th><th>MCP</th><th>Total</th><th>Last feed request</th><th>Observed poll interval</th></tr></thead><tbody>${clients}</tbody></table></div>`
		: '<p class="panel">No observed clients. No zero counts are inferred.</p>';
	const isolate = view.worker_isolate;
	const held = isolate?.active_slots ?? null;
	const slots = [0, 1, 2, 3]
		.map(
			(index) =>
				`<span class="slot-segment${held !== null && index < held ? " slot-held" : ""}" aria-hidden="true"></span>`,
		)
		.join("");
	const isolateDetails = isolate
		? `Responding Worker isolate ${isolate.isolate_id}: ${isolate.active_slots} active read slots, ${isolate.available_slots} available, limit ${isolate.limit}. Hold deadline: ${isolate.deadline_ms} ms. Incomplete read responses that reached the lease deadline since isolate start: ${isolate.expired_count}. This isolate-local observation resets on restart and does not describe other isolates or prove physical source work stopped.`
		: "Responding Worker isolate capacity: unknown.";
	return renderOwnerShell(
		"measurements",
		`<header class="page-header"><div><p class="owner-eyebrow">Observability</p><h1>Service measurements</h1><p>UTC window: ${dayWindow}. Client coverage: ${view.coverage}. Observed from ${observedWindow}.</p></div><span class="chip">Fresh or stale: ${view.requests.stale ? "stale" : "fresh"}</span></header><p class="measurement-note">Requests are observed lower bounds, not billing totals. Request observation window: ${requestWindow}. Latency: ${latencyState}.</p><p><a href="/owner/measurements">Measurement JSON</a></p><section class="stat-grid" aria-label="Request and feed measurements"><article class="card"><p class="label">REST requests</p><p class="stat-value">${view.requests.rest_count ?? "Unknown"}</p><p class="footnote">Observed lower bound. Request data: ${requestState}.</p></article><article class="card"><p class="label">MCP requests</p><p class="stat-value">${view.requests.mcp_count ?? "Unknown"}</p><p class="footnote">Observed lower bound. Request data: ${requestState}.</p></article><article class="card card-highlight"><p class="label">Feed response preparation p95</p><p class="stat-value">${view.feed_latency.p95 ?? "Unknown"}<span class="unit"> milliseconds</span></p><p class="footnote">Feed response preparation p95: ${view.feed_latency.p95 ?? "Unknown"} milliseconds. Boundary: authenticated router entry to successful /v1/changes response headers. This excludes lazy body production, network transfer, plugin apply, and publication delay.</p></article><article class="card"><p class="label">Retained samples</p><p class="stat-value">${view.feed_latency.sample_count} of ${view.feed_latency.total_sample_count}</p><p class="footnote">Retained samples: ${view.feed_latency.sample_count} of ${view.feed_latency.total_sample_count}. Retained sample window: ${sampleWindow}. ${earlierSamples ? "Earlier samples were removed by the daily cap." : "No samples were removed by the daily cap."}</p></article></section><section class="storage-grid" aria-label="Storage and isolate measurements"><article class="card"><p class="label">Durable Object SQLite bytes</p><p class="stat-value">${displayObservation(view.storage.database_bytes)}</p><div class="storage-bar ${view.storage.database_bytes.status === "observed" ? "storage-observed" : "storage-unknown"}" aria-hidden="true"></div><p class="footnote">DO SQLite allocated bytes: ${displayObservation(view.storage.database_bytes)}. No capacity is inferred.</p></article><article class="card"><p class="label">Referenced R2 blob bytes</p><p class="stat-value">${displayObservation(view.storage.referenced_blob_bytes)}</p><div class="storage-bar ${view.storage.referenced_blob_bytes.status === "observed" ? "storage-observed" : "storage-unknown"}" aria-hidden="true"></div><p class="footnote">Referenced R2 blob bytes: ${displayObservation(view.storage.referenced_blob_bytes)}. Referenced R2 bytes count distinct blobs, not total bucket allocation.</p></article><article class="card"><p class="label">Isolate read slots</p><p class="stat-value">${held === null ? "Unknown" : `Held ${held} of 4`}</p><div class="slot-segments" aria-label="${held === null ? "Read slot usage unknown" : `${held} of 4 read slots held`}">${slots}</div><p class="footnote">${isolateDetails}</p></article></section><section class="panel"><h2>Observed clients</h2>${clientTable}</section><p><a href="/owner/clients">Connected clients</a></p>`,
	);
}
