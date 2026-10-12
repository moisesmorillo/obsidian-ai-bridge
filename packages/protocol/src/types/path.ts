import type { z } from "zod";
import type { PathSchema } from "../schemas/path";

/** A relative path normalized to NFC and limited to 512 UTF-8 bytes/32 segments. */
export type Path = z.infer<typeof PathSchema>;
