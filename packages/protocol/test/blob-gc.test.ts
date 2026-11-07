import {
	BlobGcFailureSchema,
	BlobGcPreviewSchema,
	BlobGcStatusSchema,
	encodeFileFailure,
	FileFailureSchema,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

describe("blob garbage collection contracts", () => {
	it("accepts bounded preview and durable status values", () => {
		expect(BlobGcPreviewSchema.parse({ count: 2, bytes: 12 })).toEqual({
			count: 2,
			bytes: 12,
		});
		expect(
			BlobGcStatusSchema.parse({
				phase: "deleting",
				marked_count: 1,
				marked_bytes: 8,
				failure: "blob_gc_unavailable",
			}),
		).toMatchObject({ phase: "deleting", marked_count: 1 });
	});

	it("exposes marked-publication refusal as a typed retryable file failure", () => {
		const failure = {
			kind: "blob_gc_in_progress",
			retry_after_seconds: 1,
		} as const;
		expect(BlobGcFailureSchema.parse(failure)).toEqual(failure);
		expect(FileFailureSchema.parse(failure)).toEqual(failure);
		expect(encodeFileFailure(failure)).toMatchObject({
			status: 503,
			body: { error: "blob_gc_in_progress" },
			headers: { "Retry-After": "1" },
		});
		expect(
			FileFailureSchema.safeParse({ ...failure, retry_after_seconds: 0 })
				.success,
		).toBe(false);
	});
});
