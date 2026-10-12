import type { z } from "zod";
import type { ETagPartsSchema } from "../schemas/etag";

/** Parsed ETag identity and positive safe-integer revision. */
export type ETagParts = z.infer<typeof ETagPartsSchema>;
