import type {
	SearchHitSchema,
	SearchRequestSchema,
	SearchResponseSchema,
	SearchResultSchema,
} from "@protocol/schemas/search";
import type { z } from "zod";

/** Validated literal search query and bounded result count. */
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
/** Ranked result with epoch-bound identity and a bounded plain-text snippet. */
export type SearchHit = z.infer<typeof SearchHitSchema>;
/** Successful search body and index coverage. */
export type SearchResult = z.infer<typeof SearchResultSchema>;
/** Native search success or canonical policy failure. */
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
