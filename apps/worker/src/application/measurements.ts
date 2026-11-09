import type {
	FeedPreparationObservation,
	MeasurementAggregate,
	MeasurementResponse,
	RequestObservation,
} from "@vaultwire/protocol";
import {
	FeedPreparationObservationSchema,
	MEASUREMENT_LIMITS,
	MeasurementAggregateSchema,
	MeasurementResponseSchema,
	RequestObservationSchema,
} from "@vaultwire/protocol";

/** Owner-read storage values from physical SQLite allocation and distinct references. */
export interface MeasurementStorage {
	database_bytes: MeasurementResponse["storage"]["database_bytes"];
	referenced_blob_bytes: MeasurementResponse["storage"]["referenced_blob_bytes"];
}

/** Ten minutes without a value observation marks that measurement stale. */
const MEASUREMENT_STALE_AFTER_MS = 10 * 60 * 1000;
/** Transactional persistence boundary for the bounded daily aggregate. */
export interface MeasurementStore {
	/** Apply a state change atomically. A null result preserves the current durable value. */
	update(
		change: (
			current: MeasurementAggregate | null,
		) => MeasurementAggregate | null,
	): void;
	/** Return validated daily state or null when no aggregate exists. */
	read(): MeasurementAggregate | null;
}

/** Record authenticated requests and successful feed preparation through durable storage. */
export interface MeasurementGateway {
	/** Record one authenticated HTTP request without owning transport response behavior. */
	recordRequest(observation: RequestObservation): void | Promise<void>;
	/** Record one successful feed response-preparation sample in milliseconds. */
	recordFeedPreparation(
		observation: FeedPreparationObservation,
	): void | Promise<void>;
	/** Combine daily aggregate state with storage values sampled at owner-read time. */
	read(storage: MeasurementStorage): MeasurementResponse;
}

/** Return UTC midnight for the supplied Unix millisecond timestamp. */
function utcDayStart(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Create a new empty bounded aggregate for the observation's UTC calendar day. */
function emptyAggregate(now: number): MeasurementAggregate {
	const dayStart = utcDayStart(now);
	return {
		version: 1,
		day_start: dayStart,
		day_end: dayStart + 86_400_000,
		observed_from: now,
		observed_through: now,
		request_observed_from: null,
		request_observed_through: null,
		coverage_incomplete: false,
		requests_rest: 0,
		requests_mcp: 0,
		clients: [],
		latency_total_samples: 0,
		latency_samples: [],
	};
}

/** Rotate at a later UTC day and accept reordered observations within the current day. */
function baseForObservation(
	current: MeasurementAggregate | null,
	now: number,
): MeasurementAggregate | null {
	if (!current) return emptyAggregate(now);
	if (now < current.day_start) return null;
	if (now >= current.day_end) return emptyAggregate(now);
	return current;
}

/** Advance the overall window bounds without moving either bound backwards. */
function advanceObservationWindow(
	current: MeasurementAggregate,
	observedAt: number,
): Pick<MeasurementAggregate, "observed_from" | "observed_through"> {
	return {
		observed_from: Math.min(current.observed_from, observedAt),
		observed_through: Math.max(current.observed_through, observedAt),
	};
}

/** Apply one request count while preserving known client rows when the daily cap fills. */
function addRequest(
	current: MeasurementAggregate | null,
	observation: RequestObservation,
): MeasurementAggregate | null {
	const base = baseForObservation(current, observation.observed_at);
	if (!base) return null;
	const protocolKey =
		observation.protocol === "rest" ? "requests_rest" : "requests_mcp";
	const next = {
		...base,
		...advanceObservationWindow(base, observation.observed_at),
		request_observed_from: Math.min(
			base.request_observed_from ?? observation.observed_at,
			observation.observed_at,
		),
		request_observed_through: Math.max(
			base.request_observed_through ?? observation.observed_at,
			observation.observed_at,
		),
	};
	next[protocolKey] += 1;
	const existingIndex = base.clients.findIndex(
		(client) => client.client_id === observation.client_id,
	);
	if (existingIndex < 0 && base.clients.length >= MEASUREMENT_LIMITS.clients) {
		next.coverage_incomplete = true;
		return MeasurementAggregateSchema.parse(next);
	}
	const clients = [...base.clients];
	if (existingIndex < 0) {
		clients.push({
			client_id: observation.client_id,
			requests_rest: 0,
			requests_mcp: 0,
			last_feed_request_at: observation.feed_request
				? observation.observed_at
				: null,
			minimum_poll_interval_ms: null,
			maximum_poll_interval_ms: null,
			poll_cadence_incomplete: false,
		});
	}
	const client =
		clients[existingIndex < 0 ? clients.length - 1 : existingIndex];
	if (observation.feed_request) {
		const lastFeedRequestAt = client.last_feed_request_at;
		if (lastFeedRequestAt === null) {
			client.last_feed_request_at = observation.observed_at;
		} else if (observation.observed_at < lastFeedRequestAt) {
			client.poll_cadence_incomplete = true;
			client.minimum_poll_interval_ms = null;
			client.maximum_poll_interval_ms = null;
		} else {
			const interval = observation.observed_at - lastFeedRequestAt;
			if (existingIndex >= 0 && !client.poll_cadence_incomplete) {
				client.minimum_poll_interval_ms =
					client.minimum_poll_interval_ms === null
						? interval
						: Math.min(client.minimum_poll_interval_ms, interval);
				client.maximum_poll_interval_ms =
					client.maximum_poll_interval_ms === null
						? interval
						: Math.max(client.maximum_poll_interval_ms, interval);
			}
			client.last_feed_request_at = observation.observed_at;
		}
	}
	if (observation.protocol === "rest") client.requests_rest += 1;
	else client.requests_mcp += 1;
	next.clients = clients;
	return MeasurementAggregateSchema.parse(next);
}

/** Add a sample by observation time and retain the latest bounded sample window. */
function addFeedSample(
	current: MeasurementAggregate | null,
	observation: FeedPreparationObservation,
): MeasurementAggregate | null {
	const base = baseForObservation(current, observation.observed_at);
	if (!base) return null;
	const samples = [
		...base.latency_samples,
		{
			observed_at: observation.observed_at,
			duration_ms: observation.duration_ms,
		},
	].sort((left, right) => left.observed_at - right.observed_at);
	if (samples.length > MEASUREMENT_LIMITS.latencySamples)
		samples.splice(0, samples.length - MEASUREMENT_LIMITS.latencySamples);
	return MeasurementAggregateSchema.parse({
		...base,
		...advanceObservationWindow(base, observation.observed_at),
		latency_total_samples: base.latency_total_samples + 1,
		latency_samples: samples,
	});
}

/** Build the application facade over an atomic metadata store. */
export function createMeasurementGateway(
	store: MeasurementStore,
	now: () => number = Date.now,
): MeasurementGateway {
	return {
		/** Validate and persist one provider-verified HTTP request observation. */
		recordRequest(input) {
			const observation = RequestObservationSchema.parse(input);
			store.update((current) => addRequest(current, observation));
		},
		/** Validate and persist one successful feed preparation sample. */
		recordFeedPreparation(input) {
			const observation = FeedPreparationObservationSchema.parse(input);
			store.update((current) => addFeedSample(current, observation));
		},
		/** Return bounded owner data, mapping malformed durable state to unknown. */
		read(storage) {
			try {
				const parsed = MeasurementAggregateSchema.safeParse(store.read());
				if (!parsed.success) return measurementResponse(null, storage, now());
				return measurementResponse(parsed.data, storage, now());
			} catch {
				return measurementResponse(null, storage, now());
			}
		},
	};
}

/** Return the nearest-rank 95th percentile without interpolation. */
function nearestRankP95(samples: readonly number[]): number | null {
	if (samples.length === 0) return null;
	const ordered = [...samples].sort((left, right) => left - right);
	return ordered[Math.ceil(0.95 * ordered.length) - 1] ?? null;
}

/** Convert bounded durable observations and live storage reads into an owner response. */
export function measurementResponse(
	aggregate: MeasurementAggregate | null,
	storage: MeasurementStorage,
	now: number,
): MeasurementResponse {
	if (aggregate && now < aggregate.observed_through) {
		return MeasurementResponseSchema.parse({
			status: "unknown",
			coverage: "unknown",
			day_start: aggregate.day_start,
			day_end: aggregate.day_end,
			observed_from: aggregate.observed_from,
			observed_through: aggregate.observed_through,
			requests: {
				status: "unknown",
				count: null,
				observed_from: aggregate.request_observed_from,
				observed_through: aggregate.request_observed_through,
				rest_count: null,
				mcp_count: null,
				stale: true,
				clients: [],
			},
			feed_latency: {
				status: "unknown",
				unit: "milliseconds",
				sample_count: aggregate.latency_samples.length,
				total_sample_count: aggregate.latency_total_samples,
				p95: null,
				first_sample_at: aggregate.latency_samples[0]?.observed_at ?? null,
				last_sample_at: aggregate.latency_samples.at(-1)?.observed_at ?? null,
				stale: true,
			},
			storage,
		});
	}
	if (!aggregate) {
		return MeasurementResponseSchema.parse({
			status: "unknown",
			coverage: "unknown",
			day_start: null,
			day_end: null,
			observed_from: null,
			observed_through: null,
			requests: {
				status: "unknown",
				count: null,
				observed_from: null,
				observed_through: null,
				rest_count: null,
				mcp_count: null,
				stale: true,
				clients: [],
			},
			feed_latency: {
				status: "unknown",
				unit: "milliseconds",
				sample_count: 0,
				total_sample_count: 0,
				p95: null,
				stale: true,
			},
			storage,
		});
	}

	const latestSample = aggregate.latency_samples.at(-1)?.observed_at;
	const requestObservedAt = aggregate.request_observed_through;
	const requestStale =
		requestObservedAt === null ||
		now - requestObservedAt > MEASUREMENT_STALE_AFTER_MS;
	const latencyStale =
		latestSample === undefined ||
		now - latestSample > MEASUREMENT_STALE_AFTER_MS;
	const requestCount = aggregate.requests_rest + aggregate.requests_mcp;
	return MeasurementResponseSchema.parse({
		status: "observed",
		coverage: aggregate.coverage_incomplete ? "unknown" : "partial",
		day_start: aggregate.day_start,
		day_end: aggregate.day_end,
		observed_from: aggregate.observed_from,
		observed_through: aggregate.observed_through,
		requests: {
			status: requestObservedAt === null ? "unknown" : "observed",
			count: requestObservedAt === null ? null : requestCount,
			observed_from: aggregate.request_observed_from,
			observed_through: requestObservedAt,
			rest_count: requestObservedAt === null ? null : aggregate.requests_rest,
			mcp_count: requestObservedAt === null ? null : aggregate.requests_mcp,
			stale: requestStale,
			clients: requestObservedAt === null ? [] : aggregate.clients,
		},
		feed_latency: {
			status: latestSample === undefined ? "unknown" : "observed",
			unit: "milliseconds",
			sample_count: aggregate.latency_samples.length,
			total_sample_count: aggregate.latency_total_samples,
			p95: nearestRankP95(
				aggregate.latency_samples.map((sample) => sample.duration_ms),
			),
			first_sample_at: aggregate.latency_samples[0]?.observed_at ?? null,
			last_sample_at: latestSample ?? null,
			stale: latencyStale,
		},
		storage,
	});
}
