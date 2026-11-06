import { ClientIdSchema, OwnerSubjectSchema } from "@protocol/schemas/auth";
import { z } from "zod";

/** Canonical daily retention bounds shared by measurement schemas and services. */
export const MEASUREMENT_LIMITS = {
	clients: 128,
	latencySamples: 2_048,
} as const;

/** Unix millisecond timestamp used for measurement windows and samples. */
const TimestampSchema = z.number().int().nonnegative().safe();
/** Nonnegative safe count or duration used by measurement contracts. */
const CountSchema = z.number().int().nonnegative().safe();
/** Verified request observation recorded at the resource-router boundary. */
export const RequestObservationSchema = z
	.object({
		client_id: ClientIdSchema,
		protocol: z.enum(["rest", "mcp"]),
		feed_request: z.boolean(),
		observed_at: TimestampSchema,
	})
	.strict()
	.superRefine((observation, ctx) => {
		if (observation.protocol === "mcp" && observation.feed_request)
			ctx.addIssue({
				code: "custom",
				path: ["feed_request"],
				message: "only REST changes requests supply feed samples",
			});
	});

/** Successful feed response preparation sample. Duration excludes lazy body and network work. */
export const FeedPreparationObservationSchema = z
	.object({
		client_id: ClientIdSchema,
		observed_at: TimestampSchema,
		duration_ms: CountSchema,
	})
	.strict();

/** Per-client counters and cadence. Reordered inputs keep the latest time and make interval bounds unknown for the day. */
export const MeasurementClientAggregateSchema = z
	.object({
		client_id: ClientIdSchema,
		requests_rest: CountSchema,
		requests_mcp: CountSchema,
		last_feed_request_at: TimestampSchema.nullable(),
		minimum_poll_interval_ms: CountSchema.nullable(),
		maximum_poll_interval_ms: CountSchema.nullable(),
		poll_cadence_incomplete: z.boolean(),
	})
	.strict();

/** Durable field shape before cross-field invariant validation. */
const MeasurementAggregateFieldsSchema = z
	.object({
		version: z.literal(1),
		day_start: TimestampSchema,
		day_end: TimestampSchema,
		observed_from: TimestampSchema,
		observed_through: TimestampSchema,
		request_observed_from: TimestampSchema.nullable(),
		request_observed_through: TimestampSchema.nullable(),
		coverage_incomplete: z.boolean(),
		requests_rest: CountSchema,
		requests_mcp: CountSchema,
		clients: z
			.array(MeasurementClientAggregateSchema)
			.max(MEASUREMENT_LIMITS.clients),
		latency_total_samples: CountSchema,
		latency_samples: z
			.array(
				z
					.object({ observed_at: TimestampSchema, duration_ms: CountSchema })
					.strict(),
			)
			.max(MEASUREMENT_LIMITS.latencySamples),
	})
	.strict();

/** Validated field values before daily aggregate cross-field checks. */
type MeasurementAggregateFields = z.infer<
	typeof MeasurementAggregateFieldsSchema
>;

/** Validate one durable daily aggregate's bounds, ordering, and internally consistent totals. */
function validateMeasurementAggregate(
	aggregate: MeasurementAggregateFields,
	ctx: z.RefinementCtx,
): void {
	const date = new Date(aggregate.day_start);
	const utcMidnight = Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth(),
		date.getUTCDate(),
	);
	if (
		aggregate.day_start !== utcMidnight ||
		aggregate.day_end !== aggregate.day_start + 86_400_000 ||
		aggregate.observed_from < aggregate.day_start ||
		aggregate.observed_from > aggregate.observed_through ||
		aggregate.observed_through >= aggregate.day_end ||
		(aggregate.request_observed_from === null) !==
			(aggregate.request_observed_through === null) ||
		(aggregate.request_observed_from !== null &&
			aggregate.request_observed_through !== null &&
			(aggregate.request_observed_from < aggregate.observed_from ||
				aggregate.request_observed_from > aggregate.request_observed_through ||
				aggregate.request_observed_through > aggregate.observed_through))
	)
		ctx.addIssue({
			code: "custom",
			path: ["day_start"],
			message: "measurement window must match one UTC day",
		});
	if (aggregate.latency_total_samples < aggregate.latency_samples.length)
		ctx.addIssue({
			code: "custom",
			path: ["latency_total_samples"],
			message: "total sample count cannot be lower than retained samples",
		});
	let previousSampleAt = aggregate.day_start - 1;
	for (const sample of aggregate.latency_samples) {
		if (
			sample.observed_at < previousSampleAt ||
			sample.observed_at < aggregate.observed_from ||
			sample.observed_at > aggregate.observed_through
		)
			ctx.addIssue({
				code: "custom",
				path: ["latency_samples"],
				message: "retained samples must be ordered inside the observed window",
			});
		previousSampleAt = sample.observed_at;
	}
	const clientIds = new Set<string>();
	let clientRestCount = 0;
	let clientMcpCount = 0;
	for (const client of aggregate.clients) {
		if (clientIds.has(client.client_id))
			ctx.addIssue({
				code: "custom",
				path: ["clients"],
				message: "client identifiers must be unique",
			});
		clientIds.add(client.client_id);
		clientRestCount += client.requests_rest;
		clientMcpCount += client.requests_mcp;
		if (
			(client.minimum_poll_interval_ms === null) !==
				(client.maximum_poll_interval_ms === null) ||
			(client.minimum_poll_interval_ms !== null &&
				client.maximum_poll_interval_ms !== null &&
				client.minimum_poll_interval_ms > client.maximum_poll_interval_ms) ||
			(client.poll_cadence_incomplete &&
				(client.last_feed_request_at === null ||
					client.minimum_poll_interval_ms !== null ||
					client.maximum_poll_interval_ms !== null)) ||
			(client.last_feed_request_at === null &&
				client.minimum_poll_interval_ms !== null) ||
			(client.last_feed_request_at !== null &&
				(aggregate.request_observed_from === null ||
					aggregate.request_observed_through === null ||
					client.last_feed_request_at < aggregate.request_observed_from ||
					client.last_feed_request_at > aggregate.request_observed_through))
		)
			ctx.addIssue({
				code: "custom",
				path: ["clients"],
				message: "client cadence must be internally consistent and in-window",
			});
	}
	const requestCount = aggregate.requests_rest + aggregate.requests_mcp;
	if (
		(requestCount === 0) !== (aggregate.request_observed_through === null) ||
		clientRestCount > aggregate.requests_rest ||
		clientMcpCount > aggregate.requests_mcp ||
		(!aggregate.coverage_incomplete &&
			(clientRestCount !== aggregate.requests_rest ||
				clientMcpCount !== aggregate.requests_mcp))
	)
		ctx.addIssue({
			code: "custom",
			path: ["clients"],
			message:
				"client totals must match complete coverage or remain below totals",
		});
}

/** Versioned bounded daily aggregate persisted as one value in the SQLite meta table. */
export const MeasurementAggregateSchema =
	MeasurementAggregateFieldsSchema.superRefine(validateMeasurementAggregate);

/** Owner subject supplied to the Vault RPC for a configured-owner check. */
export const OwnerMeasurementsRequestSchema = z
	.object({ owner_subject: OwnerSubjectSchema })
	.strict();

/** A measurement value distinguishes known zero from unavailable observation. */
const ValueObservationSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("observed"), value: CountSchema }).strict(),
	z
		.object({
			status: z.literal("unknown"),
			reason: z.enum(["not_observed", "invalid_state", "storage_error"]),
		})
		.strict(),
]);

/** Owner-only daily observations plus optional responding Worker isolate capacity. */
export const MeasurementResponseSchema = z
	.object({
		status: z.enum(["observed", "unknown"]),
		coverage: z.enum(["partial", "complete", "unknown"]),
		day_start: TimestampSchema.nullable(),
		day_end: TimestampSchema.nullable(),
		observed_from: TimestampSchema.nullable(),
		observed_through: TimestampSchema.nullable(),
		requests: z
			.object({
				status: z.enum(["observed", "unknown"]),
				count: CountSchema.nullable(),
				observed_from: TimestampSchema.nullable(),
				observed_through: TimestampSchema.nullable(),
				rest_count: CountSchema.nullable(),
				mcp_count: CountSchema.nullable(),
				stale: z.boolean(),
				clients: z
					.array(MeasurementClientAggregateSchema)
					.max(MEASUREMENT_LIMITS.clients),
			})
			.strict(),
		feed_latency: z
			.object({
				status: z.enum(["observed", "unknown"]),
				unit: z.literal("milliseconds"),
				sample_count: CountSchema,
				total_sample_count: CountSchema,
				p95: CountSchema.nullable(),
				first_sample_at: TimestampSchema.nullable().optional(),
				last_sample_at: TimestampSchema.nullable().optional(),
				stale: z.boolean(),
			})
			.strict(),
		storage: z
			.object({
				database_bytes: ValueObservationSchema,
				referenced_blob_bytes: ValueObservationSchema,
			})
			.strict(),
		/** Process-local counters for the Worker that served this owner request. */
		worker_isolate: z
			.object({
				isolate_id: z.string().min(1).max(128),
				active_slots: CountSchema,
				available_slots: CountSchema,
				limit: CountSchema,
				expired_count: CountSchema,
				deadline_ms: CountSchema,
			})
			.strict()
			.optional(),
	})
	.strict();

/** Validated provider-verified HTTP request observation for REST or MCP. */
export type RequestObservation = z.infer<typeof RequestObservationSchema>;
/** Validated successful feed preparation sample with millisecond duration. */
export type FeedPreparationObservation = z.infer<
	typeof FeedPreparationObservationSchema
>;
/** Validated v1 durable aggregate bounded to one UTC day. */
export type MeasurementAggregate = z.infer<typeof MeasurementAggregateSchema>;
/** Validated owner-subject selector for a protected measurements read. */
export type OwnerMeasurementsRequest = z.infer<
	typeof OwnerMeasurementsRequestSchema
>;
/** Validated owner response with explicit unknown, stale, and coverage states. */
export type MeasurementResponse = z.infer<typeof MeasurementResponseSchema>;
