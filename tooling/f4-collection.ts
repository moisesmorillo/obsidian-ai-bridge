import { MEASUREMENT_LIMITS } from "@obsidian-ai-bridge/protocol";

/** Safe result freshness state retained from the service response. */
export type MeasurementStatus = "observed" | "stale" | "unknown";

/** UTC day bounds represented in stable ISO text. */
type Window = { start: string; end: string };
/** Observed UTC interval or null when no interval exists. */
type Observation = { start: string; end: string } | null;
/** One storage value with its source reason when unavailable. */
type ValueObservation =
	| { status: "observed"; value: number }
	| {
			status: "unknown";
			reason: "not_observed" | "invalid_state" | "storage_error";
	  };

/** Local adapter data for safe F4 presentation, independent of any wire schema. */
export interface F4MeasurementSnapshot {
	serviceStatus: "observed" | "unknown";
	coverage: "partial" | "complete" | "unknown";
	window: Window | null;
	observation: Observation;
	requests: {
		status: MeasurementStatus;
		sourceStatus: "observed" | "unknown";
		stale: boolean;
		count: number | null;
		rest: number | null;
		mcp: number | null;
		unit: "requests";
		window: Window | null;
		observation: Observation;
		partialDay: boolean | null;
		clientCoverage: "complete" | "incomplete" | "unknown";
		/** Safe client identifiers and counts; intervals use milliseconds. */
		clients: {
			id: string;
			rest: number;
			mcp: number;
			lastFeedRequestAt: string | null;
			minPollIntervalMs: number | null;
			maxPollIntervalMs: number | null;
			pollCadenceIncomplete: boolean;
		}[];
	};
	feedLatency: {
		status: MeasurementStatus;
		sourceStatus: "observed" | "unknown";
		stale: boolean;
		p95: number | null;
		unit: "ms";
		window: Window | null;
		observation: Observation;
		partialDay: boolean | null;
		retainedSamples: number;
		totalSamples: number;
		/** First and last retained sample timestamps, in chronological order. */
		retainedSampleTimes: string[];
		capExcluded: boolean;
		method: "nearest-rank";
		boundary: "service-side response preparation";
		reason?: "no_samples" | "stale" | "unavailable";
	};
	storage: {
		databaseBytes: ValueObservation;
		referencedBlobBytes: ValueObservation;
		meaning: "SQLite allocation and deduplicated referenced R2 bytes; not bucket allocation or integrity";
	};
}

/** Validated allowlisted view used by trial tooling. */
export type SafeF4Measurements = F4MeasurementSnapshot;

/** Accepts canonical UTC timestamps only when their date and time are valid. */
function isUtcTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

/** Checks ordered UTC bounds without accepting malformed or reversed windows. */
function isWindow(value: unknown): value is Window {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		isUtcTime(candidate.start) &&
		isUtcTime(candidate.end) &&
		Date.parse(candidate.start) <= Date.parse(candidate.end)
	);
}

/** Validates optional UTC observations inside a supplied window. */
function isObservation(
	value: unknown,
	window: Window | null,
): value is Observation {
	if (value === null) return true;
	if (!window || !value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		isUtcTime(candidate.start) &&
		isUtcTime(candidate.end) &&
		Date.parse(candidate.start) <= Date.parse(candidate.end) &&
		Date.parse(candidate.start) >= Date.parse(window.start) &&
		Date.parse(candidate.end) <= Date.parse(window.end)
	);
}

/** Checks bounded whole-number counts without changing unknown values. */
function isNullableCount(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

/** Checks nullable rates and durations as finite nonnegative numbers. */
function isNullableMeasurement(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isFinite(value) && value >= 0)
	);
}

/** Narrows a measurement status to its three supported evidence states. */
function isStatus(value: unknown): value is MeasurementStatus {
	return value === "observed" || value === "stale" || value === "unknown";
}

/** Validates one safe storage observation without losing its reason. */
function isValueObservation(value: unknown): value is ValueObservation {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.status === "observed")
		return isNullableCount(candidate.value) && candidate.value !== null;
	return (
		candidate.status === "unknown" &&
		candidate.value === undefined &&
		["not_observed", "invalid_state", "storage_error"].includes(
			String(candidate.reason),
		)
	);
}

/** Validates and projects local measurement data, then hides adapter failures. */
export async function collectF4Measurements(
	readMeasurements: () => Promise<unknown>,
): Promise<SafeF4Measurements> {
	let raw: unknown;
	try {
		raw = await readMeasurements();
	} catch {
		throw new Error("Measurement read failed");
	}
	if (!raw || typeof raw !== "object")
		throw new Error("Invalid measurement data");
	const source = raw as Record<string, unknown>;
	const requests = source.requests as Record<string, unknown> | null;
	const feed = source.feedLatency as Record<string, unknown> | null;
	const storage = source.storage as Record<string, unknown> | null;
	if (!requests || !feed || !storage)
		throw new Error("Invalid measurement data");
	const dayWindow = source.window;
	const validDayWindow =
		dayWindow === null ||
		(isWindow(dayWindow) &&
			Date.parse((dayWindow as Window).start) % 86_400_000 === 0 &&
			Date.parse((dayWindow as Window).end) -
				Date.parse((dayWindow as Window).start) ===
				86_400_000);
	if (
		(source.serviceStatus !== "observed" &&
			source.serviceStatus !== "unknown") ||
		!["partial", "complete", "unknown"].includes(String(source.coverage)) ||
		!validDayWindow ||
		!isObservation(source.observation, dayWindow as Window | null)
	)
		throw new Error("Invalid measurement data");
	if (
		!isStatus(requests.status) ||
		(requests.sourceStatus !== "observed" &&
			requests.sourceStatus !== "unknown") ||
		typeof requests.stale !== "boolean" ||
		!isNullableCount(requests.count) ||
		!isNullableCount(requests.rest) ||
		!isNullableCount(requests.mcp) ||
		requests.unit !== "requests" ||
		!isWindowOrNull(requests.window) ||
		!isObservation(requests.observation, requests.window as Window | null) ||
		(typeof requests.partialDay !== "boolean" &&
			requests.partialDay !== null) ||
		!["complete", "incomplete", "unknown"].includes(
			String(requests.clientCoverage),
		)
	)
		throw new Error("Invalid measurement data");
	if (requests.status !== (requests.stale ? "stale" : requests.sourceStatus))
		throw new Error("Invalid measurement data");
	if (
		requests.status === "observed" &&
		(requests.count === null ||
			requests.rest === null ||
			requests.mcp === null ||
			requests.partialDay === null ||
			requests.observation === null)
	)
		throw new Error("Invalid measurement data");
	if (
		(requests.sourceStatus === "observed" &&
			(requests.count === null ||
				requests.rest === null ||
				requests.mcp === null ||
				requests.count !== requests.rest + requests.mcp)) ||
		(requests.sourceStatus === "unknown" &&
			(requests.count !== null ||
				requests.rest !== null ||
				requests.mcp !== null ||
				!Array.isArray(requests.clients) ||
				requests.clients.length !== 0))
	)
		throw new Error("Invalid measurement data");
	if (
		requests.window !== null &&
		(!isWindow(dayWindow) ||
			requests.window.start !== (dayWindow as Window).start ||
			requests.window.end !== (dayWindow as Window).end)
	)
		throw new Error("Invalid measurement data");
	if (
		!Array.isArray(requests.clients) ||
		requests.clients.length > MEASUREMENT_LIMITS.clients ||
		requests.clients.some(
			(client) => !isSafeClient(client, requests.window as Window | null),
		)
	)
		throw new Error("Invalid measurement data");
	const clientRows = requests.clients as Array<{ rest: number; mcp: number }>;
	const clientRestTotal = clientRows.reduce(
		(total, client) => total + client.rest,
		0,
	);
	const clientMcpTotal = clientRows.reduce(
		(total, client) => total + client.mcp,
		0,
	);
	if (
		(requests.rest !== null && clientRestTotal > requests.rest) ||
		(requests.mcp !== null && clientMcpTotal > requests.mcp) ||
		(requests.sourceStatus === "observed" &&
			requests.clientCoverage === "complete" &&
			(clientRestTotal !== requests.rest || clientMcpTotal !== requests.mcp))
	)
		throw new Error("Invalid measurement data");
	if (
		!isStatus(feed.status) ||
		(feed.sourceStatus !== "observed" && feed.sourceStatus !== "unknown") ||
		typeof feed.stale !== "boolean" ||
		(feed.p95 !== null &&
			(typeof feed.p95 !== "number" ||
				!Number.isFinite(feed.p95) ||
				feed.p95 < 0)) ||
		feed.unit !== "ms" ||
		!isWindowOrNull(feed.window) ||
		!isObservation(feed.observation, feed.window as Window | null) ||
		(typeof feed.partialDay !== "boolean" && feed.partialDay !== null) ||
		!isNullableCount(feed.retainedSamples) ||
		!isNullableCount(feed.totalSamples) ||
		typeof feed.capExcluded !== "boolean" ||
		feed.method !== "nearest-rank" ||
		feed.boundary !== "service-side response preparation" ||
		!Array.isArray(feed.retainedSampleTimes) ||
		!feed.retainedSampleTimes.every(isUtcTime) ||
		(feed.retainedSampleTimes.length > 0 && feed.window === null)
	)
		throw new Error("Invalid measurement data");
	if (
		feed.status !== (feed.stale ? "stale" : feed.sourceStatus) ||
		(feed.window !== null &&
			(!isWindow(dayWindow) ||
				feed.window.start !== (dayWindow as Window).start ||
				feed.window.end !== (dayWindow as Window).end))
	)
		throw new Error("Invalid measurement data");
	const retainedSamples = feed.retainedSamples;
	const totalSamples = feed.totalSamples;
	if (
		!isNullableCount(retainedSamples) ||
		retainedSamples === null ||
		!isNullableCount(totalSamples) ||
		totalSamples === null
	)
		throw new Error("Invalid measurement data");
	if (
		retainedSamples > MEASUREMENT_LIMITS.latencySamples ||
		retainedSamples > totalSamples ||
		feed.capExcluded !== totalSamples > retainedSamples ||
		feed.retainedSampleTimes.length > 2 ||
		(retainedSamples === 0 && feed.retainedSampleTimes.length > 0) ||
		(feed.sourceStatus === "observed" &&
			(feed.p95 === null || retainedSamples === 0)) ||
		(feed.sourceStatus === "unknown" && feed.p95 !== null) ||
		(feed.status === "stale" && !feed.stale)
	)
		throw new Error("Invalid measurement data");
	if (
		feed.retainedSampleTimes.some(
			(time, index, samples) =>
				Date.parse(time) < Date.parse((feed.window as Window).start) ||
				Date.parse(time) > Date.parse((feed.window as Window).end) ||
				(index > 0 &&
					Date.parse(samples[index - 1] as string) > Date.parse(time)),
		)
	)
		throw new Error("Invalid measurement data");
	if (
		!isValueObservation(storage.databaseBytes) ||
		!isValueObservation(storage.referencedBlobBytes) ||
		storage.meaning !==
			"SQLite allocation and deduplicated referenced R2 bytes; not bucket allocation or integrity"
	)
		throw new Error("Invalid measurement data");
	const snapshot: SafeF4Measurements = {
		serviceStatus: source.serviceStatus,
		coverage: source.coverage as "partial" | "complete" | "unknown",
		window:
			dayWindow === null
				? null
				: {
						start: (dayWindow as Window).start,
						end: (dayWindow as Window).end,
					},
		observation:
			source.observation === null
				? null
				: copyObservation(source.observation as Observation),
		requests: {
			status: requests.status,
			sourceStatus: requests.sourceStatus,
			stale: requests.stale,
			count: requests.count,
			rest: requests.rest,
			mcp: requests.mcp,
			unit: "requests",
			window:
				requests.window === null ? null : copyWindow(requests.window as Window),
			observation:
				requests.observation === null
					? null
					: copyObservation(requests.observation as Observation),
			partialDay: requests.partialDay as boolean | null,
			clientCoverage: requests.clientCoverage as
				| "complete"
				| "incomplete"
				| "unknown",
			clients: (requests.clients as Record<string, unknown>[]).map(
				(client) => ({
					id: client.id as string,
					rest: client.rest as number,
					mcp: client.mcp as number,
					lastFeedRequestAt: client.lastFeedRequestAt as string | null,
					minPollIntervalMs: client.minPollIntervalMs as number | null,
					maxPollIntervalMs: client.maxPollIntervalMs as number | null,
					pollCadenceIncomplete: client.pollCadenceIncomplete as boolean,
				}),
			),
		},
		feedLatency: {
			status: feed.status,
			sourceStatus: feed.sourceStatus,
			stale: feed.stale,
			p95: feed.p95,
			unit: "ms",
			window: feed.window === null ? null : copyWindow(feed.window as Window),
			observation:
				feed.observation === null
					? null
					: copyObservation(feed.observation as Observation),
			partialDay: feed.partialDay as boolean | null,
			retainedSamples: feed.retainedSamples as number,
			totalSamples: feed.totalSamples as number,
			retainedSampleTimes: [...(feed.retainedSampleTimes as string[])],
			capExcluded: feed.capExcluded,
			method: "nearest-rank",
			boundary: "service-side response preparation",
			...(feed.reason === "no_samples" ||
			feed.reason === "stale" ||
			feed.reason === "unavailable"
				? { reason: feed.reason }
				: {}),
		},
		storage: {
			databaseBytes: copyValueObservation(
				storage.databaseBytes as ValueObservation,
			),
			referencedBlobBytes: copyValueObservation(
				storage.referencedBlobBytes as ValueObservation,
			),
			meaning:
				"SQLite allocation and deduplicated referenced R2 bytes; not bucket allocation or integrity",
		},
	};
	return snapshot;
}

/** Checks nullable UTC day windows before projection. */
function isWindowOrNull(value: unknown): value is Window | null {
	return value === null || isWindow(value);
}

/** Validates one client ID, count, cadence value, and original feed time. */
function isSafeClient(value: unknown, window: Window | null): boolean {
	if (!value || typeof value !== "object") return false;
	const client = value as Record<string, unknown>;
	return (
		typeof client.id === "string" &&
		/^[A-Za-z0-9._:-]{1,128}$/.test(client.id) &&
		isNullableCount(client.rest) &&
		client.rest !== null &&
		isNullableCount(client.mcp) &&
		client.mcp !== null &&
		(client.lastFeedRequestAt === null ||
			(isUtcTime(client.lastFeedRequestAt) &&
				window !== null &&
				Date.parse(client.lastFeedRequestAt) >= Date.parse(window.start) &&
				Date.parse(client.lastFeedRequestAt) <= Date.parse(window.end))) &&
		isNullableMeasurement(client.minPollIntervalMs) &&
		isNullableMeasurement(client.maxPollIntervalMs) &&
		(client.minPollIntervalMs === null) ===
			(client.maxPollIntervalMs === null) &&
		(client.minPollIntervalMs === null ||
			client.maxPollIntervalMs === null ||
			client.minPollIntervalMs <= client.maxPollIntervalMs) &&
		(client.lastFeedRequestAt !== null ||
			(client.minPollIntervalMs === null &&
				client.maxPollIntervalMs === null)) &&
		typeof client.pollCadenceIncomplete === "boolean" &&
		(!client.pollCadenceIncomplete ||
			(client.lastFeedRequestAt !== null &&
				client.minPollIntervalMs === null &&
				client.maxPollIntervalMs === null))
	);
}

/** Makes a fresh window object so callers cannot mutate adapter-owned fields. */
function copyWindow(window: Window): Window {
	return { start: window.start, end: window.end };
}

/** Copies UTC observation bounds after validation. */
function copyObservation(observation: Observation): Observation {
	return observation === null
		? null
		: { start: observation.start, end: observation.end };
}

/** Copies one validated storage value without exposing adapter object fields. */
function copyValueObservation(value: ValueObservation): ValueObservation {
	return value.status === "observed"
		? { status: "observed", value: value.value }
		: { status: "unknown", reason: value.reason };
}

/** Formats only validated allowlisted fields as deterministic, credential-free text. */
export function formatF4Summary(summary: SafeF4Measurements): string {
	const window = summary.window
		? `${summary.window.start} to ${summary.window.end}`
		: "unknown";
	const observed = summary.observation
		? `${summary.observation.start} to ${summary.observation.end}`
		: "unknown";
	const requestCounts =
		summary.requests.rest === null || summary.requests.mcp === null
			? "unknown"
			: `REST ${summary.requests.rest}, MCP ${summary.requests.mcp}`;
	const requestState = `${summary.requests.sourceStatus}${summary.requests.stale ? " (stale)" : ""}`;
	const feedState = `${summary.feedLatency.sourceStatus}${summary.feedLatency.stale ? " (stale)" : ""}`;
	const latency =
		summary.feedLatency.p95 !== null
			? `${summary.feedLatency.p95} ms (nearest-rank; ${feedState})`
			: summary.feedLatency.reason === "no_samples" ||
					summary.feedLatency.retainedSamples === 0
				? `${summary.feedLatency.sourceStatus} (${summary.feedLatency.stale ? "stale, " : ""}no samples)`
				: feedState;
	const sampleEvidence = `${summary.feedLatency.retainedSamples}/${summary.feedLatency.totalSamples} retained/total samples${summary.feedLatency.capExcluded ? ", earlier samples excluded by cap" : ""}`;
	const retainedSampleRange =
		summary.feedLatency.retainedSampleTimes.length > 1
			? `${summary.feedLatency.retainedSampleTimes[0]} to ${summary.feedLatency.retainedSampleTimes.at(-1)}`
			: (summary.feedLatency.retainedSampleTimes[0] ?? "unknown");
	/** Formats one storage value with its explicit unknown reason. */
	const storageValue = (value: ValueObservation): string =>
		value.status === "observed"
			? `${value.value} bytes`
			: `unknown (${value.reason})`;
	return [
		`Service measurements: ${summary.serviceStatus}. Coverage: ${summary.coverage}.`,
		`UTC day window: ${window}. Overall observation: ${observed}.`,
		`Requests (observed lower bounds): ${requestCounts}${summary.requests.count === null ? "" : ` (${summary.requests.count} total)`}. Request window: ${summary.requests.window ? `${summary.requests.window.start} to ${summary.requests.window.end}` : "unknown"}. Request observations: ${summary.requests.observation ? `${summary.requests.observation.start} to ${summary.requests.observation.end}` : "unknown"}. Request data: ${requestState}. Client coverage: ${summary.requests.clientCoverage}.`,
		...summary.requests.clients.map(
			(client) =>
				`Client ${client.id}: REST ${client.rest}, MCP ${client.mcp}. Last feed request ${client.lastFeedRequestAt ?? "unknown"}. Poll interval ${client.pollCadenceIncomplete ? "unknown (out-of-order requests)" : `${client.minPollIntervalMs ?? "unknown"}-${client.maxPollIntervalMs ?? "unknown"} milliseconds`}.`,
		),
		`Feed response preparation p95: ${latency}. Samples: ${sampleEvidence}. Window: ${summary.feedLatency.window ? `${summary.feedLatency.window.start} to ${summary.feedLatency.window.end}` : "unknown"}. Retained sample times: ${retainedSampleRange}. Not end-to-end sync latency. Feed times and intervals do not show event causes or focus state.`,
		`SQLite allocation: ${storageValue(summary.storage.databaseBytes)}. Deduplicated referenced R2: ${storageValue(summary.storage.referencedBlobBytes)}. These are not bucket allocation or an integrity check.`,
	].join("\n");
}
