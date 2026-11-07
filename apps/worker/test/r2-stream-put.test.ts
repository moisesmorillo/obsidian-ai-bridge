import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("R2 streaming feasibility", () => {
	it("accepts fixed-length multipart parts when the archive length is unknown", async () => {
		const key = `feasibility/${crypto.randomUUID()}`;
		const upload = await env.R2_BUCKET.createMultipartUpload(key);
		let completed = false;
		try {
			const bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
			const fixed = new FixedLengthStream(bytes.byteLength);
			const writer = fixed.writable.getWriter();
			const writing = writer.write(bytes).then(() => writer.close());
			const part = await upload.uploadPart(1, fixed.readable);
			await writing;
			const object = await upload.complete([part]);
			completed = true;
			expect(object.size).toBe(bytes.byteLength);
			expect((await env.R2_BUCKET.get(key))?.size).toBe(bytes.byteLength);
		} finally {
			if (!completed) await upload.abort();
			await env.R2_BUCKET.delete(key);
		}
	}, 30_000);
});
