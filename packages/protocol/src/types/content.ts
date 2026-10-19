import type { TextPayloadSchema } from "@protocol/schemas/content";
import type { z } from "zod";

/** Validated inline text and its original-byte identity. */
export type TextPayload = z.infer<typeof TextPayloadSchema>;
