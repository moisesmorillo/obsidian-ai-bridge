import { encodeNotePath, normalizeNotePath } from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  apiErrorResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { createWorkerApp } from "@worker/app";
import type { Logger } from "@worker/logging/logger.types";
import {
  createTestMirrorServices,
  MemoryMirrorBucket,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";

const logger: Logger = { info: () => undefined };

function application(bucket: MemoryMirrorBucket) {
  return createWorkerApp({
    logger,
    resolveMirrorServices: () => createTestMirrorServices(bucket),
    resolveToken: () => "token",
  });
}

function route(value: string): string {
  const path = normalizeNotePath(value);
  if (path === undefined) throw new Error("Invalid fixture");
  return `/api/v1/notes/${encodeNotePath(path)}`;
}

async function code(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("retained v1 note handlers", () => {
  it("rejects malformed identifiers before reading storage", async () => {
    const bucket = new MemoryMirrorBucket();
    const response = await application(bucket).fetch(
      new Request("https://example.test/api/v1/notes/not-base64!", {
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await code(response)).toBe(API_ERROR_CODE.invalidPath);
    expect(bucket.getCount).toBe(0);
  });

  it("preserves hierarchical-path and unsupported-method fallback responses", async () => {
    const bucket = new MemoryMirrorBucket();
    const hierarchical = await application(bucket).fetch(
      new Request("https://example.test/api/v1/notes/folder/note.md", {
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(hierarchical.status).toBe(400);
    expect(await code(hierarchical)).toBe(API_ERROR_CODE.invalidPath);

    const unsupported = await application(bucket).fetch(
      new Request(`https://example.test${route("Alpha.md")}`, {
        method: "POST",
        headers: { Authorization: "Bearer token" },
      }),
    );
    expect(unsupported.status).toBe(404);
    expect(await code(unsupported)).toBe(API_ERROR_CODE.notFound);
  });

  it.each(["PUT", "DELETE"])(
    "retires authenticated %s without reading or mutating storage",
    async (method) => {
      const bucket = new MemoryMirrorBucket();
      const response = await application(bucket).fetch(
        new Request(`https://example.test${route("Alpha.md")}`, {
          method,
          headers: { Authorization: "Bearer token" },
          ...(method === "PUT" ? { body: "private" } : {}),
        }),
      );
      expect(response.status).toBe(410);
      expect(await code(response)).toBe(API_ERROR_CODE.mutationApiRetired);
      expect(bucket.getCount).toBe(0);
      expect(bucket.putKeys).toHaveLength(0);
    },
  );
});
