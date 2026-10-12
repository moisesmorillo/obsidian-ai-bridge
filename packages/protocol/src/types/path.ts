import type { PathSchema } from "@protocol/schemas/path";
import type { z } from "zod";

/** A relative path normalized to NFC and limited to 512 UTF-8 bytes/32 segments. */
export type Path = z.infer<typeof PathSchema>;
