import type { ETagPartsSchema } from "@protocol/schemas/etag";
import type { z } from "zod";

/** Parsed ETag identity and positive safe-integer revision. */
export type ETagParts = z.infer<typeof ETagPartsSchema>;
