import type { MeasurementResponse } from "@obsidian-ai-bridge/protocol";
import {
	formatBytes,
	formatCount,
	formatDuration,
	formatUtcDateTime,
	formatUtcTime,
} from "@worker/transport/owner-pages/format";
import type { OwnerServiceMetadata } from "@worker/transport/owner-pages/shell";
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
	service?: OwnerServiceMetadata;
}

/** Format a measurement instant for its detailed explanation or explicit unknown. */
function displayTimestamp(value: number | null | undefined): string {
	return value === null || value === undefined
		? "Unknown"
		: formatUtcDateTime(value);
}

/** Format an observed storage value without implying capacity or a zero fallback. */
function displayObservation(
	value: MeasurementResponse["storage"]["database_bytes"],
): string {
	return value.status === "observed"
		? formatBytes(value.value)
		: `Unknown (${value.reason ?? "not observed"})`;
}

/** Render concise measurement cards and retain their full limits in one panel. */
export function renderMeasurementsPage(
	view: MeasurementsPageViewModel,
): string {
	const dayStart = formatUtcTime(view.day_start);
	const dayEnd = formatUtcTime(
		view.day_end === null ? null : view.day_end - 60_000,
	);
	const observed = `${formatUtcTime(view.observed_from)} to ${formatUtcTime(view.observed_through)}`;
	const requestState = `${view.requests.status}, ${view.requests.stale ? "stale" : "fresh"}`;
	const latencyState = `${view.feed_latency.status}, ${view.feed_latency.stale ? "stale" : "fresh"}`;
	const requestWindow = `${displayTimestamp(view.requests.observed_from)} to ${displayTimestamp(view.requests.observed_through)}`;
	const sampleWindow = `${displayTimestamp(view.feed_latency.first_sample_at)} to ${displayTimestamp(view.feed_latency.last_sample_at)}`;
	const earlierSamples =
		view.feed_latency.total_sample_count > view.feed_latency.sample_count;
	const clients = view.requests.clients
		.map(
			(client) =>
				`<tr><td>${client.client_id}</td><td>${formatCount(client.requests_rest)}</td><td>${formatCount(client.requests_mcp)}</td><td>${formatCount(client.requests_rest + client.requests_mcp)}</td><td>${displayTimestamp(client.last_feed_request_at)}</td><td>${client.poll_cadence_incomplete ? "unknown (out-of-order requests)" : `${client.minimum_poll_interval_ms ?? "unknown"}–${client.maximum_poll_interval_ms ?? "unknown"} ms`}</td></tr>`,
		)
		.join("");
	const clientTable = clients
		? `<div class="table-scroll"><table><thead><tr><th>Observed client</th><th>REST</th><th>MCP</th><th>Total</th><th>Last feed request</th><th>Observed poll interval</th></tr></thead><tbody>${clients}</tbody></table></div>`
		: "<p>No observed clients. No zero counts are inferred.</p>";
	const isolate = view.worker_isolate;
	const held = isolate?.active_slots ?? null;
	const slots = [0, 1, 2, 3]
		.map(
			(index) =>
				`<span class="slot-segment${held !== null && index < held ? " slot-held" : ""}" aria-hidden="true"></span>`,
		)
		.join("");
	const isolateDetails = isolate
		? `Responding Worker isolate ${isolate.isolate_id}: ${isolate.active_slots} active read slots, ${isolate.available_slots} available, limit ${isolate.limit}. Hold deadline: ${formatDuration(isolate.deadline_ms)}. Incomplete read responses that reached the lease deadline since isolate start: ${isolate.expired_count}. This isolate-local observation resets on restart and does not describe other isolates or prove physical source work stopped.`
		: "Responding Worker isolate capacity: unknown.";
	const dayDescription = `UTC window ${dayStart} to ${dayEnd}, observed ${observed}, coverage ${view.coverage}`;
	const content = `<header class="page-header"><div><p class="owner-eyebrow">Observability</p><h1>Service measurements</h1><p>${dayDescription}</p></div><span class="chip">${view.requests.stale ? "Stale" : "Fresh"}</span></header><p class="measurement-note">Requests are observed lower bounds, not billing totals. Latency: ${latencyState}.</p><section class="stat-grid" aria-label="Request and feed measurements"><article class="card"><p class="label">REST requests</p><p class="stat-value">${view.requests.rest_count === null ? "Unknown" : formatCount(view.requests.rest_count)}</p><p class="footnote">Observed lower bound. ${requestState}.</p></article><article class="card"><p class="label">MCP requests</p><p class="stat-value">${view.requests.mcp_count === null ? "Unknown" : formatCount(view.requests.mcp_count)}</p><p class="footnote">Observed lower bound. ${requestState}.</p></article><article class="card card-highlight"><p class="label">Feed response preparation p95</p><p class="stat-value">${view.feed_latency.p95 === null ? "Unknown" : formatDuration(view.feed_latency.p95)}</p><p class="footnote">Observed preparation duration. ${latencyState}.</p></article><article class="card"><p class="label">Retained samples</p><p class="stat-value">${formatCount(view.feed_latency.sample_count)} of ${formatCount(view.feed_latency.total_sample_count)}</p><p class="footnote">Retained samples. ${earlierSamples ? "Daily cap applied." : "Daily cap not reached."}</p></article></section><section class="storage-grid" aria-label="Storage and isolate measurements"><article class="card"><p class="label">Durable Object SQLite bytes</p><p class="stat-value">${displayObservation(view.storage.database_bytes)}</p><div class="storage-bar ${view.storage.database_bytes.status === "observed" ? "storage-observed" : "storage-unknown"}" aria-hidden="true"></div><p class="footnote">Allocated bytes observed.</p></article><article class="card"><p class="label">Referenced R2 blob bytes</p><p class="stat-value">${displayObservation(view.storage.referenced_blob_bytes)}</p><div class="storage-bar ${view.storage.referenced_blob_bytes.status === "observed" ? "storage-observed" : "storage-unknown"}" aria-hidden="true"></div><p class="footnote">Distinct referenced blobs.</p></article><article class="card"><p class="label">Isolate read slots</p><p class="stat-value">${held === null ? "Unknown" : `Held ${formatCount(held)} of 4`}</p><div class="slot-segments" aria-label="${held === null ? "Read slot usage unknown" : `${held} of 4 read slots held`}">${slots}</div><p class="footnote">Worker isolate-local observation.</p></article></section><section class="panel"><h2>Observed clients</h2>${clientTable}<p><a href="/owner/clients">Connected clients</a></p></section><section class="panel about-panel"><h2>About these numbers</h2><p>Request observation window: ${requestWindow}. Latency observation: ${view.feed_latency.status}, ${view.feed_latency.stale ? "stale" : "fresh"}. Retained sample window: ${sampleWindow}.</p><p>Feed response preparation p95 measures authenticated router entry to successful /v1/changes response headers. It excludes lazy body production, network transfer, plugin apply, and publication delay.</p><p>${earlierSamples ? "Earlier samples were removed by the daily cap." : "No samples were removed by the daily cap."}</p><p>DO SQLite allocated bytes do not imply a capacity. Referenced R2 bytes count distinct blobs, not total bucket allocation.</p><p>${isolateDetails}</p></section><p><a href="/owner/measurements">Measurement JSON</a></p>`;
	return renderOwnerShell("measurements", content, view.service);
}
