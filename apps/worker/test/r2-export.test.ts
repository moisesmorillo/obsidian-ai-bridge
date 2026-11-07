import { env } from "cloudflare:test";
import type { Env } from "@worker/env";
import { R2PackedArchiveStore } from "@worker/infrastructure/r2/packed-export";
import { describe, expect, it } from "vitest";

describe("R2 packed archive store", () => {
	it("writes exact fixed-size parts and completes one archive", async () => {
		const key = `backups/test/${crypto.randomUUID()}.zip`;
		const store = new R2PackedArchiveStore((env as Env).BACKUP_BUCKET);
		const uploadId = await store.create(key);
		let completed = false;
		try {
			const payload = new Uint8Array(5 * 1024 * 1024).fill(4);
			const part = await store.putPart(key, uploadId, 1, payload);
			const size = await store.complete(key, uploadId, [part]);
			completed = true;
			expect(size).toBe(payload.byteLength);
			expect((await (env as Env).BACKUP_BUCKET.head(key))?.size).toBe(
				payload.byteLength,
			);
			expect(await env.R2_BUCKET.head(key)).toBeNull();
			const archive = await store.get(key);
			expect(archive?.size).toBe(payload.byteLength);
			expect(
				new Uint8Array(await new Response(archive?.body).arrayBuffer())
					.byteLength,
			).toBe(payload.byteLength);
		} finally {
			if (!completed) await store.abort(key, uploadId);
			await (env as Env).BACKUP_BUCKET.delete(key);
		}
	});
});
