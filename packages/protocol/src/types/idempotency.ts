import type { IdempotencyKeySchema } from "@protocol/schemas/idempotency";
import type { z } from "zod";

/** Exact caller-supplied idempotency key. */
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
