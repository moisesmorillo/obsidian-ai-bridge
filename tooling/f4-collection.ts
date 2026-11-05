/** Service evidence can be present, stale, or explicitly unknown. */
export type MeasurementStatus = "observed" | "stale" | "unknown";

/** UTC interval that bounds one measurement without implying event causality. */
type Window = { start: string; end: string };
/** Observed UTC activity bounds, or null when the adapter has no observation. */
type Observation = { start: string; end: string } | null;

/** Local adapter data for safe F4 presentation, independent of any wire schema. */
export interface F4MeasurementSnapshot {
	requests: {
		status: MeasurementStatus;
		rest: number | null;
		mcp: number | null;
		unit: "requests";
		window: Window;
		observation: Observation;
		partialDay: boolean | null;
		clientCoverage: "complete" | "incomplete" | "unknown";
		/** Safe client identifiers and observed feed cadence; interval values use seconds. */
		clients: {
			id: string;
			lastFeedRequestAt: string | null;
			minPollIntervalSeconds: number | null;
			maxPollIntervalSeconds: number | null;
		}[];
	};
	feedLatency: {
		status: MeasurementStatus;
		p95: number | null;
		unit: "ms";
		window: Window;
		observation: Observation;
		partialDay: boolean | null;
		retainedSamples: number | null;
		totalSamples: number | null;
		/** First and last retained sample timestamps, in chronological order. */
		retainedSampleTimes: string[];
		capExcluded: boolean | null;
		method: "nearest-rank";
		boundary: "service-side response preparation";
		reason?: "no_samples" | "stale" | "unavailable";
	};
	storage: {
		status: MeasurementStatus;
		window: Window;
		sqliteAllocatedBytes: number | null;
		referencedR2Bytes: number | null;
		referencedR2Meaning: "deduplicated references, not bucket allocation or integrity";
	};
}

/** Validated allowlisted view used by trial tooling. */
export type SafeF4Measurements = F4MeasurementSnapshot;

/** Accepts UTC day/window values only when their date and millisecond form are valid. */
function isUtcTime(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().replace(".000Z", "Z") ===
			value.replace(/\.000Z$/, "Z")
	);
}

/** Checks ordered UTC bounds without accepting malformed or reversed windows. */
function isWindow(value: unknown): value is Window {
	if (!value || typeof value !== "object") return false;
	const window = value as Record<string, unknown>;
	return (
		isUtcTime(window.start) &&
		isUtcTime(window.end) &&
		Date.parse(window.start) <= Date.parse(window.end)
	);
}

/** Validates optional observation bounds against their measurement window. */
function isObservation(value: unknown, window: Window): value is Observation {
	if (value === null) return true;
	if (!value || typeof value !== "object") return false;
	const observation = value as Record<string, unknown>;
	return (
		isUtcTime(observation.start) &&
		isUtcTime(observation.end) &&
		Date.parse(observation.start) <= Date.parse(observation.end) &&
		Date.parse(observation.start) >= Date.parse(window.start) &&
		Date.parse(observation.end) <= Date.parse(window.end)
	);
}

/** Checks nullable measurements without turning unknown or stale values into zero. */
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

/** Converts an adapter result to a validated field allowlist and hides adapter failures. */
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
	const feedLatency = source.feedLatency as Record<string, unknown> | null;
	const storage = source.storage as Record<string, unknown> | null;
	if (!requests || !feedLatency || !storage)
		throw new Error("Invalid measurement data");
	/** Narrows adapter status to the supported evidence states. */
	const validStatus = (status: unknown): status is MeasurementStatus =>
		status === "observed" || status === "stale" || status === "unknown";
	if (
		!validStatus(requests.status) ||
		!isWindow(requests.window) ||
		!isObservation(requests.observation, requests.window as Window) ||
		!isNullableCount(requests.rest) ||
		!isNullableCount(requests.mcp) ||
		requests.unit !== "requests" ||
		(typeof requests.partialDay !== "boolean" &&
			requests.partialDay !== null) ||
		!["complete", "incomplete", "unknown"].includes(
			String(requests.clientCoverage),
		)
	)
		throw new Error("Invalid measurement data");
	if (
		requests.status === "observed" &&
		(requests.rest === null ||
			requests.mcp === null ||
			requests.partialDay === null ||
			requests.observation === null)
	)
		throw new Error("Invalid measurement data");
	if (
		!Array.isArray(requests.clients) ||
		requests.clients.length > 128 ||
		requests.clients.some((client) => {
			if (!client || typeof client !== "object") return true;
			const entry = client as Record<string, unknown>;
			return (
				typeof entry.id !== "string" ||
				!/^[A-Za-z0-9._:-]{1,128}$/.test(entry.id) ||
				(entry.lastFeedRequestAt !== null &&
					(!isUtcTime(entry.lastFeedRequestAt) ||
						Date.parse(entry.lastFeedRequestAt) <
							Date.parse((requests.window as Window).start) ||
						Date.parse(entry.lastFeedRequestAt) >
							Date.parse((requests.window as Window).end))) ||
				!isNullableMeasurement(entry.minPollIntervalSeconds) ||
				!isNullableMeasurement(entry.maxPollIntervalSeconds) ||
				(entry.minPollIntervalSeconds !== null &&
					entry.maxPollIntervalSeconds !== null &&
					entry.minPollIntervalSeconds > entry.maxPollIntervalSeconds)
			);
		})
	)
		throw new Error("Invalid measurement data");
	if (
		Date.parse((requests.window as Window).start) % 86_400_000 !== 0 ||
		Date.parse((requests.window as Window).end) -
			Date.parse((requests.window as Window).start) !==
			86_400_000
	)
		throw new Error("Invalid measurement data");
	if (
		!validStatus(feedLatency.status) ||
		!isWindow(feedLatency.window) ||
		!isObservation(feedLatency.observation, feedLatency.window as Window) ||
		feedLatency.unit !== "ms" ||
		feedLatency.method !== "nearest-rank" ||
		feedLatency.boundary !== "service-side response preparation"
	)
		throw new Error("Invalid measurement data");
	if (
		(feedLatency.p95 !== null &&
			(typeof feedLatency.p95 !== "number" ||
				!Number.isFinite(feedLatency.p95) ||
				feedLatency.p95 < 0)) ||
		!isNullableCount(feedLatency.retainedSamples) ||
		!isNullableCount(feedLatency.totalSamples) ||
		!Array.isArray(feedLatency.retainedSampleTimes) ||
		!feedLatency.retainedSampleTimes.every(isUtcTime) ||
		(typeof feedLatency.capExcluded !== "boolean" &&
			feedLatency.capExcluded !== null)
	)
		throw new Error("Invalid measurement data");
	if (
		feedLatency.status === "observed" &&
		(feedLatency.p95 === null ||
			feedLatency.retainedSamples === null ||
			feedLatency.retainedSamples === 0 ||
			feedLatency.totalSamples === null ||
			feedLatency.observation === null ||
			feedLatency.partialDay === null ||
			feedLatency.capExcluded === null)
	)
		throw new Error("Invalid measurement data");
	if (
		feedLatency.status === "unknown" &&
		(feedLatency.p95 !== null ||
			(feedLatency.reason !== "no_samples" &&
				feedLatency.reason !== "unavailable"))
	)
		throw new Error("Invalid measurement data");
	if (feedLatency.status === "stale" && feedLatency.reason !== "stale")
		throw new Error("Invalid measurement data");
	if (
		feedLatency.retainedSamples !== null &&
		feedLatency.totalSamples !== null &&
		(feedLatency.retainedSamples > feedLatency.totalSamples ||
			feedLatency.retainedSampleTimes.length !==
				Math.min(feedLatency.retainedSamples, 2) ||
			feedLatency.retainedSamples > 2_048 ||
			(feedLatency.capExcluded !== null &&
				feedLatency.capExcluded !==
					feedLatency.totalSamples > feedLatency.retainedSamples))
	)
		throw new Error("Invalid measurement data");
	const latencyWindow = feedLatency.window as Window;
	if (
		feedLatency.retainedSampleTimes.length > 0 &&
		feedLatency.retainedSampleTimes.some(
			(time, index, times) =>
				Date.parse(time) < Date.parse(latencyWindow.start) ||
				Date.parse(time) > Date.parse(latencyWindow.end) ||
				(index > 0 &&
					Date.parse(times[index - 1] as string) > Date.parse(time)),
		)
	)
		throw new Error("Invalid measurement data");
	if (
		!validStatus(storage.status) ||
		!isWindow(storage.window) ||
		!isNullableCount(storage.sqliteAllocatedBytes) ||
		!isNullableCount(storage.referencedR2Bytes) ||
		storage.referencedR2Meaning !==
			"deduplicated references, not bucket allocation or integrity"
	)
		throw new Error("Invalid measurement data");
	if (
		storage.status === "observed" &&
		(storage.sqliteAllocatedBytes === null ||
			storage.referencedR2Bytes === null)
	)
		throw new Error("Invalid measurement data");
	return {
		requests: {
			status: requests.status,
			rest: requests.rest,
			mcp: requests.mcp,
			unit: "requests",
			window: { start: requests.window.start, end: requests.window.end },
			observation:
				requests.observation === null
					? null
					: {
							start: (requests.observation as Observation & {}).start,
							end: (requests.observation as Observation & {}).end,
						},
			partialDay: requests.partialDay as boolean | null,
			clientCoverage: requests.clientCoverage as
				| "complete"
				| "incomplete"
				| "unknown",
			clients: (requests.clients as Record<string, unknown>[]).map(
				(client) => ({
					id: client.id as string,
					lastFeedRequestAt: client.lastFeedRequestAt as string | null,
					minPollIntervalSeconds: client.minPollIntervalSeconds as
						| number
						| null,
					maxPollIntervalSeconds: client.maxPollIntervalSeconds as
						| number
						| null,
				}),
			),
		},
		feedLatency: {
			status: feedLatency.status,
			p95: feedLatency.p95,
			unit: "ms",
			window: { start: feedLatency.window.start, end: feedLatency.window.end },
			observation:
				feedLatency.observation === null
					? null
					: {
							start: (feedLatency.observation as Observation & {}).start,
							end: (feedLatency.observation as Observation & {}).end,
						},
			partialDay: feedLatency.partialDay as boolean | null,
			retainedSamples: feedLatency.retainedSamples,
			totalSamples: feedLatency.totalSamples,
			retainedSampleTimes: [...feedLatency.retainedSampleTimes] as string[],
			capExcluded: feedLatency.capExcluded as boolean | null,
			method: "nearest-rank",
			boundary: "service-side response preparation",
			...(feedLatency.reason === "no_samples" ||
			feedLatency.reason === "stale" ||
			feedLatency.reason === "unavailable"
				? { reason: feedLatency.reason }
				: {}),
		},
		storage: {
			status: storage.status,
			window: { start: storage.window.start, end: storage.window.end },
			sqliteAllocatedBytes: storage.sqliteAllocatedBytes,
			referencedR2Bytes: storage.referencedR2Bytes,
			referencedR2Meaning:
				"deduplicated references, not bucket allocation or integrity",
		},
	};
}

/** Formats only validated measurement fields as stable, credential-free plain text. */
export function formatF4Summary(summary: SafeF4Measurements): string {
	const requestValue =
		summary.requests.status === "observed" ||
		summary.requests.status === "stale"
			? `REST ${summary.requests.rest ?? "unknown"}, MCP ${summary.requests.mcp ?? "unknown"}${summary.requests.status === "stale" ? " (stale)" : ""}`
			: summary.requests.status;
	const latency =
		summary.feedLatency.status === "observed"
			? `${summary.feedLatency.p95} ms (${summary.feedLatency.method}, ${summary.feedLatency.retainedSamples}/${summary.feedLatency.totalSamples} samples${summary.feedLatency.capExcluded ? ", cap excludes earlier samples" : ""})`
			: summary.feedLatency.status === "stale" &&
					summary.feedLatency.p95 !== null
				? `${summary.feedLatency.p95} ms (stale)`
				: summary.feedLatency.status === "unknown" &&
						summary.feedLatency.reason === "no_samples"
					? "unknown (no samples)"
					: summary.feedLatency.status;
	const observed = summary.requests.observation
		? ` Observed ${summary.requests.observation.start} to ${summary.requests.observation.end}.`
		: " Observation window unknown.";
	const day =
		summary.requests.partialDay === null
			? " Day coverage unknown."
			: summary.requests.partialDay
				? " Partial day."
				: " Full day.";
	return [
		`Requests (${summary.requests.unit}, ${summary.requests.status}): ${requestValue}.`,
		`Window: ${summary.requests.window.start} to ${summary.requests.window.end}.${observed}${day} Client coverage ${summary.requests.clientCoverage}.`,
		...summary.requests.clients.map(
			(client) =>
				`Client ${client.id}: last feed ${client.lastFeedRequestAt ?? "unknown"}, poll interval ${client.minPollIntervalSeconds ?? "unknown"}-${client.maxPollIntervalSeconds ?? "unknown"} seconds.`,
		),
		`Feed response preparation p95: ${latency}.${summary.feedLatency.retainedSampleTimes.length ? ` Retained sample times ${summary.feedLatency.retainedSampleTimes[0]} to ${summary.feedLatency.retainedSampleTimes.at(-1)}.` : ""}`,
		`Storage window: ${summary.storage.window.start} to ${summary.storage.window.end}. SQLite allocation: ${summary.storage.sqliteAllocatedBytes === null ? summary.storage.status : `${summary.storage.sqliteAllocatedBytes} bytes${summary.storage.status === "stale" ? " (stale)" : ""}`}. Deduplicated referenced R2: ${summary.storage.referencedR2Bytes === null ? summary.storage.status : `${summary.storage.referencedR2Bytes} bytes${summary.storage.status === "stale" ? " (stale)" : ""}`}, not bucket allocation or integrity.`,
	].join("\n");
}
