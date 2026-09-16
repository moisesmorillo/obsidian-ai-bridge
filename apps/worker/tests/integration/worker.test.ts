import {
  CURRENT_NOTE_STATE_KIND,
  createMirrorAssociationId,
  createMirrorWriterId,
  encodeNotePath,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  apiErrorResponseSchema,
  currentNoteStateSchema,
  mirrorDescriptionSchema,
  mutationAcknowledgementSchema,
  recoveryPageSchema,
  recoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { createWorkerApp } from "@worker/app";
import {
  toOpenApiV2RoutePath,
  V2_ROUTE_POLICY,
} from "@worker/http/v2-route-policy";
import type { Logger } from "@worker/logging/logger.types";
import {
  createTestMirrorServices,
  MemoryMirrorBucket,
  TEST_ASSOCIATION_ID,
  TEST_WRITER_ID,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const TOKEN = "secret-token";
const OTHER_DESIGNATION = {
  associationId: required(
    createMirrorAssociationId("33333333-3333-4333-8333-333333333333"),
  ),
  writerId: required(
    createMirrorWriterId("44444444-4444-4444-8444-444444444444"),
  ),
};

class TestLogger implements Logger {
  readonly entries: Parameters<Logger["info"]>[] = [];
  info(entry: Parameters<Logger["info"]>[0]): void {
    this.entries.push([entry]);
  }
}

function encodedPath(value: string): string {
  const path = normalizeNotePath(value);
  if (path === undefined) throw new Error("Invalid test path");
  return encodeNotePath(path);
}

function noteRoute(value: string, version = "v2"): string {
  return `/api/${version}/notes/${encodedPath(value)}`;
}

/**
 * Resolves one shared v2 route shape to a concrete canonical test URL.
 *
 * @param routePath - Hono route shape from the shared policy.
 * @param id - Canonical recovery identity for parameter substitution.
 * @returns Concrete route containing canonical note/recovery identifiers.
 */
function concreteV2Route(routePath: string, id: string): string {
  return routePath.replace(":path", encodedPath("Alpha.md")).replace(":id", id);
}

function operationId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected test value");
  return value;
}

function mutationHeaders(
  sequence: number,
  condition: { readonly ifMatch?: string; readonly ifNoneMatch?: string },
  identity = {
    associationId: TEST_ASSOCIATION_ID,
    writerId: TEST_WRITER_ID,
  },
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${TOKEN}`,
    "Bridge-Association-Id": identity.associationId,
    "Bridge-Writer-Id": identity.writerId,
    "Bridge-Operation-Id": operationId(sequence),
  });
  if (condition.ifMatch !== undefined)
    headers.set("If-Match", condition.ifMatch);
  if (condition.ifNoneMatch !== undefined) {
    headers.set("If-None-Match", condition.ifNoneMatch);
  }
  return headers;
}

function application(
  bucket: MemoryMirrorBucket,
  options: Parameters<typeof createTestMirrorServices>[1] = {},
) {
  const logger = new TestLogger();
  const mirrorServices = createTestMirrorServices(bucket, options);
  return {
    app: createWorkerApp({
      logger,
      resolveMirrorServices: () => mirrorServices,
      resolveToken: () => TOKEN,
    }),
    logger,
    mirrorServices,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.test${path}`, init);
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

async function createNote(
  app: ReturnType<typeof application>["app"],
  sequence: number,
  content = "first",
) {
  const headers = mutationHeaders(sequence, { ifNoneMatch: "*" });
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  const response = await app.fetch(
    request(noteRoute("Alpha.md"), { method: "PUT", headers, body: content }),
  );
  const acknowledgement = mutationAcknowledgementSchema.parse(
    await response.json(),
  );
  return { response, acknowledgement };
}

describe("Worker v2 API", () => {
  it("keeps health public and protects v2 plus unknown descendants", async () => {
    const { app } = application(new MemoryMirrorBucket());
    expect((await app.fetch(request("/health"))).status).toBe(200);

    for (const [path, cors] of [
      ["/api/v2/mirror", "*"],
      ["/api/v2/unknown", null],
    ] as const) {
      const response = await app.fetch(request(path));
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe(API_ERROR_CODE.unauthorized);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(cors);
    }
  });

  it("describes validated mirror configuration without secrets", async () => {
    const { app } = application(new MemoryMirrorBucket());
    const response = await app.fetch(
      request("/api/v2/mirror", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(mirrorDescriptionSchema.parse(await response.json())).toMatchObject({
      associationId: TEST_ASSOCIATION_ID,
      writerId: TEST_WRITER_ID,
      maxNoteSizeBytes: 1_048_576,
      maxPageSize: 50,
      recoveryRetentionSeconds: 2_592_000,
    });
  });

  it("composes create, one-read content/state, update, stale refusal, and recreate", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 1, "first");
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get("ETag")).toBe(
      `"m3-${created.acknowledgement.revision}"`,
    );

    const read = await app.fetch(
      request(noteRoute("Alpha.md"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await read.text()).toBe("first");
    expect(read.headers.get("Bridge-Note-Format")).toBe("2");
    expect(read.headers.get("ETag")).toBe(
      `"m3-${created.acknowledgement.revision}"`,
    );

    const state = await app.fetch(
      request(`${noteRoute("Alpha.md")}/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const live = currentNoteStateSchema.parse(await state.json());
    expect(live).not.toHaveProperty("content");

    const updateHeaders = mutationHeaders(2, {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    updateHeaders.set("Content-Type", "TEXT/PLAIN; Charset=UTF-8");
    const update = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: updateHeaders,
        body: "second",
      }),
    );
    expect(update.status).toBe(200);
    const updated = mutationAcknowledgementSchema.parse(await update.json());

    const staleHeaders = mutationHeaders(3, {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    staleHeaders.set("Content-Type", "text/plain");
    const stale = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: staleHeaders,
        body: "stale",
      }),
    );
    expect(stale.status).toBe(412);
    expect(await errorCode(stale)).toBe(API_ERROR_CODE.preconditionFailed);

    const deleteHeaders = mutationHeaders(4, {
      ifMatch: `"m3-${updated.revision}"`,
    });
    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: deleteHeaders,
      }),
    );
    expect(removed.status).toBe(200);
    const tombstone = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    expect(tombstone.acknowledgement.receipt.action).toBe("tombstone");
    expect(
      (
        await app.fetch(
          request(noteRoute("Alpha.md"), {
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        )
      ).status,
    ).toBe(404);

    const recreateHeaders = mutationHeaders(5, {
      ifMatch: `"m3-${tombstone.acknowledgement.revision}"`,
    });
    recreateHeaders.set("Content-Type", "text/markdown");
    const recreated = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: recreateHeaders,
        body: "recreated",
      }),
    );
    expect(recreated.status).toBe(200);
    expect(
      mutationAcknowledgementSchema.parse(await recreated.json()).receipt
        .action,
    ).toBe("recreate");
  });

  it("refuses a cross-association update before conditional storage dispatch", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 900, "association A live");
    const storedBefore = bucket.body("vault/Alpha.md");
    const attemptsBefore = bucket.putKeys.length;
    const otherApp = application(bucket, {
      designation: OTHER_DESIGNATION,
    }).app;
    const otherHeaders = mutationHeaders(
      901,
      { ifMatch: `"m3-${created.acknowledgement.revision}"` },
      OTHER_DESIGNATION,
    );
    otherHeaders.set("Content-Type", "text/plain");

    const refused = await otherApp.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: otherHeaders,
        body: "association B update",
      }),
    );

    expect(refused.status).toBe(412);
    expect(await errorCode(refused)).toBe(API_ERROR_CODE.preconditionFailed);
    expect(bucket.body("vault/Alpha.md")).toBe(storedBefore);
    expect(bucket.putKeys).toHaveLength(attemptsBefore);

    const sameHeaders = mutationHeaders(902, {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    sameHeaders.set("Content-Type", "text/plain");
    const sameAssociation = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: sameHeaders,
        body: "association A update",
      }),
    );
    expect(sameAssociation.status).toBe(200);
  });

  it("refuses a cross-association tombstone before recovery preparation", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 903, "association A live");
    const storedBefore = bucket.body("vault/Alpha.md");
    const attemptsBefore = bucket.putKeys.length;
    const otherApp = application(bucket, {
      designation: OTHER_DESIGNATION,
    }).app;

    const refused = await otherApp.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(
          904,
          { ifMatch: `"m3-${created.acknowledgement.revision}"` },
          OTHER_DESIGNATION,
        ),
      }),
    );

    expect(refused.status).toBe(412);
    expect(await errorCode(refused)).toBe(API_ERROR_CODE.preconditionFailed);
    expect(bucket.body("vault/Alpha.md")).toBe(storedBefore);
    expect(bucket.putKeys).toHaveLength(attemptsBefore);
    expect(bucket.body(`recovery/${operationId(904)}`)).toBeUndefined();

    const sameAssociation = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(905, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    expect(sameAssociation.status).toBe(200);
  });

  it("refuses a cross-association recreation before conditional storage dispatch", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 906, "association A live");
    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(907, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    const tombstone = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    const storedBefore = bucket.body("vault/Alpha.md");
    const attemptsBefore = bucket.putKeys.length;
    const otherApp = application(bucket, {
      designation: OTHER_DESIGNATION,
    }).app;
    const otherHeaders = mutationHeaders(
      908,
      { ifMatch: `"m3-${tombstone.acknowledgement.revision}"` },
      OTHER_DESIGNATION,
    );
    otherHeaders.set("Content-Type", "text/plain");

    const refused = await otherApp.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: otherHeaders,
        body: "association B recreation",
      }),
    );

    expect(refused.status).toBe(412);
    expect(await errorCode(refused)).toBe(API_ERROR_CODE.preconditionFailed);
    expect(bucket.body("vault/Alpha.md")).toBe(storedBefore);
    expect(bucket.putKeys).toHaveLength(attemptsBefore);

    const sameHeaders = mutationHeaders(909, {
      ifMatch: `"m3-${tombstone.acknowledgement.revision}"`,
    });
    sameHeaders.set("Content-Type", "text/plain");
    const sameAssociation = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: sameHeaders,
        body: "association A recreation",
      }),
    );
    expect(sameAssociation.status).toBe(200);
  });

  it("maps malformed recovery proof to 500 without tombstoning the live head", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 917, "still live");
    const deletionSequence = 918;
    bucket.seed(`recovery/${operationId(deletionSequence)}`, "{}", {
      bridgeFormat: "2",
    });

    const response = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(deletionSequence, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.internalError);
    const current = await app.fetch(
      request(noteRoute("Alpha.md"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("still live");
  });

  it("keeps the live head when recovery preparation cannot be dispatched", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 919, "A");
    bucket.throwBeforePut = true;

    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(920, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );

    expect(removed.status).toBe(500);
    expect(JSON.parse(bucket.body("vault/Alpha.md") ?? "null").kind).toBe(
      CURRENT_NOTE_STATE_KIND.live,
    );
    expect(bucket.body(`recovery/${operationId(920)}`)).toBeUndefined();
  });

  it("distinguishes confirmed tombstone from refused recovery sealing", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 921, "A");
    bucket.refusedPutCalls.add(4);

    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(922, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    const deletion = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );

    expect(removed.status).toBe(200);
    expect(deletion.acknowledgement.receipt.action).toBe(
      MUTATION_ACTION.tombstone,
    );
    expect(deletion.recovery.kind).toBe(RECOVERY_SNAPSHOT_STATE_KIND.prepared);
    expect(deletion.sealing.kind).toBe(
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    );
    expect(JSON.parse(bucket.body("vault/Alpha.md") ?? "null").kind).toBe(
      CURRENT_NOTE_STATE_KIND.tombstone,
    );
  });

  it("accepts explicit empty content and rejects missing media or invalid conditions", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const noMedia = mutationHeaders(6, { ifNoneMatch: "*" });
    const unsupported = await app.fetch(
      request(noteRoute("Empty.md"), { method: "PUT", headers: noMedia }),
    );
    expect(unsupported.status).toBe(415);

    const valid = mutationHeaders(7, { ifNoneMatch: "*" });
    valid.set("Content-Type", "text/plain");
    const empty = await app.fetch(
      request(noteRoute("Empty.md"), { method: "PUT", headers: valid }),
    );
    expect(empty.status).toBe(201);

    for (const [header, expectedStatus] of [
      [undefined, 428],
      ['W/"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"', 400],
      ["*", 400],
      ['"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "other"', 400],
    ] as const) {
      const headers = mutationHeaders(8, {});
      headers.set("Content-Type", "text/plain");
      if (header !== undefined) headers.set("If-Match", header);
      const response = await app.fetch(
        request(noteRoute("Empty.md"), { method: "PUT", headers }),
      );
      expect(response.status).toBe(expectedStatus);
    }
  });

  it("rejects malformed and mismatched designation before mutation", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const malformed = mutationHeaders(9, { ifNoneMatch: "*" });
    malformed.set("Bridge-Writer-Id", "not-an-id");
    malformed.set("Content-Type", "text/plain");
    expect(
      (
        await app.fetch(
          request(noteRoute("Alpha.md"), {
            method: "PUT",
            headers: malformed,
            body: "private",
          }),
        )
      ).status,
    ).toBe(400);

    const mismatch = mutationHeaders(10, { ifNoneMatch: "*" });
    mismatch.set("Bridge-Writer-Id", "99999999-9999-4999-8999-999999999999");
    mismatch.set("Content-Type", "text/plain");
    const forbidden = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: mismatch,
        body: "private",
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("separates recovery metadata and content and refuses unexpired purge", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 11, "recover me");
    const headers = mutationHeaders(12, {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), { method: "DELETE", headers }),
    );
    const deletion = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    const recoveryId = deletion.recovery.id;

    const metadata = await app.fetch(
      request(`/api/v2/recovery/${recoveryId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(
      recoverySnapshotStateSchema.parse(await metadata.json()),
    ).not.toHaveProperty("content");
    const content = await app.fetch(
      request(`/api/v2/recovery/${recoveryId}/content`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await content.text()).toBe("recover me");

    const list = await app.fetch(
      request("/api/v2/recovery", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const page = recoveryPageSchema.parse(await list.json());
    expect(page.recoveries).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("recover me");

    const purgeHeaders = mutationHeaders(13, {
      ifMatch: `"m3-${deletion.sealing.kind === "confirmed" ? deletion.sealing.recovery.revision : deletion.recovery.revision}"`,
    });
    const purge = await app.fetch(
      request(`/api/v2/recovery/${recoveryId}/purge`, {
        method: "POST",
        headers: purgeHeaders,
      }),
    );
    expect(purge.status).toBe(409);
  });

  it("purges at expiry and returns 410 for recovery content", async () => {
    const bucket = new MemoryMirrorBucket();
    const initial = application(bucket);
    const created = await createNote(initial.app, 14, "expire me");
    const removed = await initial.app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(15, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    const deletion = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    if (
      deletion.sealing.kind !== "confirmed" ||
      deletion.sealing.recovery.kind !== "sealed"
    ) {
      throw new Error("Expected sealed recovery");
    }
    const expired = application(bucket, {
      now: new Date(
        Date.parse(deletion.sealing.recovery.recoverUntil) +
          RECOVERY_RETENTION_MILLISECONDS,
      ),
    });
    const expiredContent = await expired.app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/content`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(expiredContent.status).toBe(410);
    const purge = await expired.app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/purge`, {
        method: "POST",
        headers: mutationHeaders(16, {
          ifMatch: `"m3-${deletion.sealing.recovery.revision}"`,
        }),
      }),
    );
    expect(purge.status).toBe(200);
    const purged = recoverySnapshotStateSchema.parse(await purge.json());
    expect(purged.kind).toBe("purged");
    expect(bucket.body(`recovery/${deletion.recovery.id}`)).not.toContain(
      "expire me",
    );
    const content = await expired.app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/content`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(content.status).toBe(410);
  });

  it("handles method-specific CORS preflight without resolving services", async () => {
    const bucket = new MemoryMirrorBucket();
    let resolutions = 0;
    const app = createWorkerApp({
      logger: new TestLogger(),
      resolveMirrorServices: () => {
        resolutions += 1;
        return createTestMirrorServices(bucket);
      },
      resolveToken: () => TOKEN,
    });
    const valid = await app.fetch(
      request(`${noteRoute("Alpha.md")}/state`, {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, If-Match",
        },
      }),
    );
    expect(valid.status).toBe(204);
    expect(valid.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(resolutions).toBe(0);

    const invalid = await app.fetch(
      request(`${noteRoute("Alpha.md")}/state`, {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "DELETE",
        },
      }),
    );
    expect(invalid.status).toBe(400);
    expect(resolutions).toBe(0);
  });

  it("returns every metadata state without content and validates pagination cursors", async () => {
    const bucket = new MemoryMirrorBucket();
    bucket.seed("vault/Legacy.md", "legacy");
    const { app } = application(bucket);
    const absent = await app.fetch(
      request(`${noteRoute("Missing.md")}/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(currentNoteStateSchema.parse(await absent.json()).kind).toBe(
      "absent",
    );
    const legacy = await app.fetch(
      request(`${noteRoute("Legacy.md")}/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(currentNoteStateSchema.parse(await legacy.json())).toEqual({
      kind: "legacy",
      path: "Legacy.md",
    });
    expect(legacy.headers.get("ETag")).toBeNull();

    const listed = await app.fetch(
      request("/api/v2/notes", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await listed.json()).toEqual({
      notes: ["Legacy.md"],
      nextCursor: null,
    });
    for (const query of [
      "?cursor=",
      `?cursor=${"x".repeat(4097)}`,
      "?cursor=a&cursor=b",
    ]) {
      const invalid = await app.fetch(
        request(`/api/v2/notes${query}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(invalid.status).toBe(400);
    }
  });

  it("keeps authentication ahead of designation and maps unavailable effects to sanitized 500", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const invalidIdentity = mutationHeaders(30, { ifNoneMatch: "*" });
    invalidIdentity.delete("Authorization");
    invalidIdentity.set("Bridge-Writer-Id", "invalid");
    invalidIdentity.set("Content-Type", "text/plain");
    const unauthenticated = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: invalidIdentity,
        body: "private",
      }),
    );
    expect(unauthenticated.status).toBe(401);

    bucket.throwOnGet = true;
    const failingHeaders = mutationHeaders(31, { ifNoneMatch: "*" });
    failingHeaders.set("Content-Type", "text/plain");
    const failure = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers: failingHeaders,
        body: "private",
      }),
    );
    expect(failure.status).toBe(500);
    expect(await errorCode(failure)).toBe(API_ERROR_CODE.internalError);
  });

  it("fails invalid Worker designation closed for description and mutations", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket, { designation: null });
    const mirror = await app.fetch(
      request("/api/v2/mirror", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(mirror.status).toBe(500);
    const headers = mutationHeaders(32, { ifNoneMatch: "*" });
    headers.set("Content-Type", "text/plain");
    const mutation = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers,
        body: "private",
      }),
    );
    expect(mutation.status).toBe(403);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("rejects invalid bodyless mutations and recovery identities without storage mutation", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 33);
    const deleteHeaders = mutationHeaders(34, {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    const withBody = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: deleteHeaders,
        body: "not empty",
      }),
    );
    expect(withBody.status).toBe(400);
    expect(bucket.putKeys).toHaveLength(1);

    for (const path of [
      "/api/v2/recovery/not-an-id",
      "/api/v2/recovery/not-an-id/content",
      "/api/v2/recovery/not-an-id/seal",
    ]) {
      const response = await app.fetch(
        request(path, {
          method: path.endsWith("seal") ? "POST" : "GET",
          headers: path.endsWith("seal")
            ? mutationHeaders(35, {
                ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
              })
            : { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("returns missing/stale recovery maintenance statuses and supports exact seal replay", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const missingId = operationId(40);
    for (const suffix of ["", "/content"]) {
      const response = await app.fetch(
        request(`/api/v2/recovery/${missingId}${suffix}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(response.status).toBe(404);
    }
    const missingSeal = await app.fetch(
      request(`/api/v2/recovery/${missingId}/seal`, {
        method: "POST",
        headers: mutationHeaders(41, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
      }),
    );
    expect(missingSeal.status).toBe(404);

    const created = await createNote(app, 42, "seal replay");
    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(43, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    const deletion = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    expect(deletion.sealing.kind).toBe("confirmed");
    const replay = await app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/seal`, {
        method: "POST",
        headers: mutationHeaders(43, {
          ifMatch: `"m3-${deletion.recovery.revision}"`,
        }),
      }),
    );
    expect(replay.status).toBe(200);

    const stale = await app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/seal`, {
        method: "POST",
        headers: mutationHeaders(44, {
          ifMatch: '"m3-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"',
        }),
      }),
    );
    expect(stale.status).toBe(412);
  });

  it("maps unavailable tombstone proof to 409 during explicit sealing", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 60, "proof source");
    bucket.refusedPutCalls.add(4);
    const removed = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(61, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    const deletion = tombstoneMutationResponseSchema.parse(
      await removed.json(),
    );
    expect(deletion.sealing.kind).toBe("definitely-refused");

    const recreateHeaders = mutationHeaders(62, {
      ifMatch: `"m3-${deletion.acknowledgement.revision}"`,
    });
    recreateHeaders.set("Content-Type", "text/plain");
    expect(
      (
        await app.fetch(
          request(noteRoute("Alpha.md"), {
            method: "PUT",
            headers: recreateHeaders,
            body: "advanced",
          }),
        )
      ).status,
    ).toBe(200);

    const seal = await app.fetch(
      request(`/api/v2/recovery/${deletion.recovery.id}/seal`, {
        method: "POST",
        headers: mutationHeaders(63, {
          ifMatch: `"m3-${deletion.recovery.revision}"`,
        }),
      }),
    );
    expect(seal.status).toBe(409);
  });

  it("rejects unsupported preflight headers and bearer-protects unknown OPTIONS", async () => {
    const { app } = application(new MemoryMirrorBucket());
    const rejected = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "X-Private",
        },
      }),
    );
    expect(rejected.status).toBe(400);
    const unknown = await app.fetch(
      request("/api/v2/unknown", {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("covers invalid item paths, legacy content, body bounds, and stale deletion", async () => {
    const bucket = new MemoryMirrorBucket();
    bucket.seed("vault/Legacy.md", "legacy text");
    const { app } = application(bucket);
    const legacy = await app.fetch(
      request(noteRoute("Legacy.md"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await legacy.text()).toBe("legacy text");
    expect(legacy.headers.get("Bridge-Note-Format")).toBe("legacy");

    for (const suffix of ["", "/state"]) {
      const invalid = await app.fetch(
        request(`/api/v2/notes/not-base64!${suffix}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(invalid.status).toBe(400);
    }
    const invalidPutHeaders = mutationHeaders(50, { ifNoneMatch: "*" });
    invalidPutHeaders.set("Content-Type", "text/plain");
    expect(
      (
        await app.fetch(
          request("/api/v2/notes/not-base64!", {
            method: "PUT",
            headers: invalidPutHeaders,
            body: "private",
          }),
        )
      ).status,
    ).toBe(400);

    const oversizedHeaders = mutationHeaders(51, { ifNoneMatch: "*" });
    oversizedHeaders.set("Content-Type", "text/plain");
    const oversized = await app.fetch(
      request(noteRoute("Oversized.md"), {
        method: "PUT",
        headers: oversizedHeaders,
        body: "x".repeat(1_048_577),
      }),
    );
    expect(oversized.status).toBe(413);

    const invalidEncodingHeaders = mutationHeaders(52, { ifNoneMatch: "*" });
    invalidEncodingHeaders.set("Content-Type", "text/plain");
    const invalidEncoding = await app.fetch(
      request(noteRoute("Encoding.md"), {
        method: "PUT",
        headers: invalidEncodingHeaders,
        body: new Uint8Array([0xc3, 0x28]),
      }),
    );
    expect(invalidEncoding.status).toBe(400);

    const created = await createNote(app, 53);
    const staleDelete = await app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(54, {
          ifMatch: '"m3-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"',
        }),
      }),
    );
    expect(staleDelete.status).toBe(412);
    expect(created.acknowledgement.revision).toBeDefined();
  });

  it("sanitizes unknown current/recovery effects and invalid outbound pages", async () => {
    const unknownBucket = new MemoryMirrorBucket();
    unknownBucket.returnInvalidPutMetadata = true;
    const unknownApp = application(unknownBucket).app;
    const headers = mutationHeaders(55, { ifNoneMatch: "*" });
    headers.set("Content-Type", "text/plain");
    const unknown = await unknownApp.fetch(
      request(noteRoute("Alpha.md"), {
        method: "PUT",
        headers,
        body: "private",
      }),
    );
    expect(unknown.status).toBe(500);

    const failingBucket = new MemoryMirrorBucket();
    const failingApp = application(failingBucket).app;
    failingBucket.throwOnGet = true;
    const deleteFailure = await failingApp.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(56, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
      }),
    );
    expect(deleteFailure.status).toBe(500);
    const recoveryFailure = await failingApp.fetch(
      request(`/api/v2/recovery/${operationId(56)}/purge`, {
        method: "POST",
        headers: mutationHeaders(57, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
      }),
    );
    expect(recoveryFailure.status).toBe(500);

    const setup = application(new MemoryMirrorBucket());
    vi.spyOn(setup.mirrorServices.current, "list").mockResolvedValueOnce({
      notes: [],
      nextCursor: "x".repeat(4097),
    });
    const invalidNotesPage = await setup.app.fetch(
      request("/api/v2/notes", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(invalidNotesPage.status).toBe(500);
    vi.spyOn(setup.mirrorServices.recovery, "list").mockResolvedValueOnce({
      recoveries: [],
      nextCursor: "x".repeat(4097),
    });
    const invalidRecoveryPage = await setup.app.fetch(
      request("/api/v2/recovery", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(invalidRecoveryPage.status).toBe(500);
    const invalidCursor = await setup.app.fetch(
      request("/api/v2/recovery?cursor=", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(invalidCursor.status).toBe(400);
  });

  it("logs only route metadata without token, path, or note body", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app, logger } = application(bucket);
    const headers = mutationHeaders(70, { ifNoneMatch: "*" });
    headers.set("Content-Type", "text/plain");
    await app.fetch(
      request(noteRoute("Private/Secret.md"), {
        method: "PUT",
        headers,
        body: "sensitive note body",
      }),
    );
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain('"route":"/api/v2/notes/:path"');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Private/Secret.md");
    expect(logged).not.toContain("sensitive note body");
  });

  it("publishes an exact semantic OpenAPI contract for v1 and v2", async () => {
    const { app } = application(new MemoryMirrorBucket());
    const response = await app.fetch(request("/openapi.json"));
    const schemaObject = z
      .object({
        pattern: z.string().optional(),
        enum: z.array(z.string()).optional(),
        const: z.string().optional(),
      })
      .loose();
    const parameter = z
      .object({
        name: z.string(),
        in: z.string(),
        required: z.boolean().optional(),
        schema: schemaObject,
      })
      .loose();
    const responseContract = z
      .object({
        content: z
          .record(z.string(), z.object({ schema: z.unknown() }))
          .optional(),
        headers: z
          .record(z.string(), z.object({ schema: schemaObject }))
          .optional(),
      })
      .loose();
    const operation = z
      .object({
        description: z.string().optional(),
        parameters: z.array(parameter).optional(),
        requestBody: z
          .object({
            required: z.boolean().optional(),
            content: z.record(z.string(), z.unknown()),
          })
          .optional(),
        responses: z.record(z.string(), responseContract),
        security: z
          .array(z.object({ bearerAuth: z.array(z.never()) }))
          .optional(),
      })
      .loose();
    const document = z
      .object({
        openapi: z.literal("3.1.0"),
        paths: z.record(z.string(), z.record(z.string(), operation)),
      })
      .parse(await response.json());
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/notes",
      "/api/v1/notes/{path}",
      "/api/v2/mirror",
      "/api/v2/notes",
      "/api/v2/notes/{path}",
      "/api/v2/notes/{path}/state",
      "/api/v2/recovery",
      "/api/v2/recovery/{id}",
      "/api/v2/recovery/{id}/content",
      "/api/v2/recovery/{id}/purge",
      "/api/v2/recovery/{id}/seal",
      "/health",
    ]);
    const expected = {
      "/health": { get: ["200", "500"] },
      "/api/v1/notes": { get: ["200", "401", "500"] },
      "/api/v1/notes/{path}": {
        get: ["200", "400", "401", "404", "500"],
        put: ["401", "410", "500"],
        delete: ["401", "410", "500"],
      },
      "/api/v2/mirror": { get: ["200", "401", "500"] },
      "/api/v2/notes": { get: ["200", "400", "401", "500"] },
      "/api/v2/notes/{path}": {
        get: ["200", "400", "401", "404", "500"],
        put: [
          "200",
          "201",
          "400",
          "401",
          "403",
          "412",
          "413",
          "415",
          "428",
          "500",
        ],
        delete: ["200", "400", "401", "403", "412", "413", "428", "500"],
      },
      "/api/v2/notes/{path}/state": { get: ["200", "400", "401", "500"] },
      "/api/v2/recovery": { get: ["200", "400", "401", "500"] },
      "/api/v2/recovery/{id}": { get: ["200", "400", "401", "404", "500"] },
      "/api/v2/recovery/{id}/content": {
        get: ["200", "400", "401", "404", "410", "500"],
      },
      "/api/v2/recovery/{id}/seal": {
        post: [
          "200",
          "400",
          "401",
          "403",
          "404",
          "409",
          "412",
          "413",
          "428",
          "500",
        ],
      },
      "/api/v2/recovery/{id}/purge": {
        post: [
          "200",
          "400",
          "401",
          "403",
          "404",
          "409",
          "412",
          "413",
          "428",
          "500",
        ],
      },
    } as const;
    for (const [path, methods] of Object.entries(expected)) {
      const pathContract = required(document.paths[path]);
      expect(Object.keys(pathContract).sort()).toEqual(
        Object.keys(methods).sort(),
      );
      for (const [method, statuses] of Object.entries(methods)) {
        const contract = required(pathContract[method]);
        expect(Object.keys(contract.responses)).toEqual(statuses);
        if (path !== "/health")
          expect(contract.security).toEqual([{ bearerAuth: [] }]);
      }
    }
    const policySurface = Object.values(V2_ROUTE_POLICY)
      .map((definition) => ({
        path: toOpenApiV2RoutePath(definition.path),
        methods: Object.values(definition.operations).sort((left, right) =>
          left.localeCompare(right),
        ),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const openApiSurface = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/v2/"))
      .map(([path, pathContract]) => ({
        path,
        methods: Object.keys(pathContract)
          .map((method) => method.toUpperCase())
          .sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(openApiSurface).toEqual(policySurface);

    const put = required(required(document.paths["/api/v2/notes/{path}"]).put);
    expect(put.requestBody?.required).toBe(false);
    expect(Object.keys(required(put.requestBody).content).sort()).toEqual([
      "text/markdown",
      "text/plain",
    ]);
    expect(put.description).toContain("Exactly one precondition");
    const putHeaders = new Map(
      put.parameters
        ?.filter((entry) => entry.in === "header")
        .map((entry) => [entry.name, entry]),
    );
    expect(putHeaders.get("Content-Type")?.required).toBe(true);
    const contentTypePattern = required(
      putHeaders.get("Content-Type")?.schema.pattern,
    );
    expect(
      new RegExp(contentTypePattern).test("TEXT/PLAIN; Charset=UTF-8"),
    ).toBe(true);
    expect(contentTypePattern.endsWith("/i")).toBe(false);
    expect(putHeaders.get("If-Match")?.schema.pattern).toContain("m3-");
    expect(putHeaders.get("If-Match")?.required).toBe(false);
    expect(putHeaders.get("If-None-Match")?.schema.enum).toEqual(["*"]);
    expect(putHeaders.get("If-None-Match")?.required).toBe(false);
    const pathParameter = put.parameters?.find(
      (entry) => entry.name === "path",
    );
    expect(pathParameter?.schema.pattern).toBe("^[A-Za-z0-9_-]+$");

    const noteGet = required(
      required(document.paths["/api/v2/notes/{path}"]).get,
    );
    const noteHeaders = required(noteGet.responses["200"]).headers;
    expect(noteHeaders?.ETag?.schema.pattern).toContain("m3-");
    expect(noteHeaders?.["Bridge-Note-Format"]?.schema.enum).toEqual([
      "legacy",
      "2",
    ]);
    expect(
      Object.keys(required(noteGet.responses["200"]).content ?? {}),
    ).toEqual(["text/markdown; charset=utf-8"]);

    const metadata = required(
      required(document.paths["/api/v2/recovery/{id}"]).get,
    );
    const metadataSchema = required(
      required(metadata.responses["200"]).content,
    )?.["application/json"]?.schema;
    expect(JSON.stringify(metadataSchema)).not.toContain('"content"');
    const recoveryContent = required(
      required(document.paths["/api/v2/recovery/{id}/content"]).get,
    );
    expect(
      Object.keys(required(recoveryContent.responses["200"]).content ?? {}),
    ).toEqual(["text/markdown; charset=utf-8"]);
    expect(
      required(recoveryContent.responses["200"]).headers?.["Bridge-Note-Format"]
        ?.schema.enum,
    ).toEqual(["2"]);
    const sealSchema = required(
      required(required(document.paths["/api/v2/recovery/{id}/seal"]).post)
        .responses["200"],
    ).content?.["application/json"]?.schema;
    const purgeSchema = required(
      required(required(document.paths["/api/v2/recovery/{id}/purge"]).post)
        .responses["200"],
    ).content?.["application/json"]?.schema;
    expect(JSON.stringify(sealSchema)).toContain('"sealed"');
    expect(JSON.stringify(sealSchema)).not.toContain('"purged"');
    expect(JSON.stringify(purgeSchema)).toContain('"purged"');
    expect(JSON.stringify(purgeSchema)).not.toContain('"sealed"');
    const createdSchema = required(put.responses["201"]).content?.[
      "application/json"
    ]?.schema;
    const updatedSchema = required(put.responses["200"]).content?.[
      "application/json"
    ]?.schema;
    expect(JSON.stringify(createdSchema)).toContain('"create"');
    expect(JSON.stringify(createdSchema)).not.toContain('"tombstone"');
    expect(JSON.stringify(updatedSchema)).toContain('"update"');
    expect(JSON.stringify(updatedSchema)).toContain('"recreate"');
    expect(JSON.stringify(updatedSchema)).not.toContain('"tombstone"');

    for (const pathContract of Object.values(document.paths)) {
      for (const contract of Object.values(pathContract)) {
        for (const [status, documentedResponse] of Object.entries(
          contract.responses,
        )) {
          expect(
            documentedResponse.headers?.["Cache-Control"]?.schema.const,
            `${status} must document no-store`,
          ).toBe("no-store");
          if (status === "401") {
            expect(
              documentedResponse.headers?.["WWW-Authenticate"]?.schema.const,
            ).toBe("Bearer");
          }
        }
      }
    }
    const noteListBadRequest = JSON.stringify(
      required(
        required(required(document.paths["/api/v2/notes"]).get).responses[
          "400"
        ],
      ).content,
    );
    expect(noteListBadRequest).toContain(API_ERROR_CODE.invalidRequest);
    expect(noteListBadRequest).not.toContain(API_ERROR_CODE.invalidPath);
    expect(noteListBadRequest).not.toContain(API_ERROR_CODE.invalidBody);
  });
});

describe("retained v1 compatibility", () => {
  it("reads legacy/live envelopes, hides tombstones, and retires all mutations", async () => {
    const bucket = new MemoryMirrorBucket();
    bucket.seed("vault/Legacy.md", "legacy body");
    const { app } = application(bucket);
    const created = await createNote(app, 20, "live body");

    const list = await app.fetch(
      request("/api/v1/notes", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await list.json()).toEqual({ notes: ["Alpha.md", "Legacy.md"] });
    const legacy = await app.fetch(
      request(noteRoute("Legacy.md", "v1"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await legacy.text()).toBe("legacy body");
    const missing = await app.fetch(
      request(noteRoute("Missing.md", "v1"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(missing.status).toBe(404);

    for (const method of ["PUT", "DELETE"]) {
      const response = await app.fetch(
        request(noteRoute("Alpha.md", "v1"), {
          method,
          headers: { Authorization: `Bearer ${TOKEN}` },
          ...(method === "PUT" ? { body: "unsafe" } : {}),
        }),
      );
      expect(response.status).toBe(410);
      expect(await errorCode(response)).toBe(API_ERROR_CODE.mutationApiRetired);
    }
    const read = await app.fetch(
      request(noteRoute("Alpha.md"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(read.headers.get("ETag")).toBe(
      `"m3-${created.acknowledgement.revision}"`,
    );
  });

  it("sanitizes malformed tagged storage instead of treating it as raw or absent", async () => {
    const bucket = new MemoryMirrorBucket();
    bucket.seed("vault/Alpha.md", "{}", { bridgeFormat: "2" });
    const { app } = application(bucket);
    const response = await app.fetch(
      request(noteRoute("Alpha.md", "v1"), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.internalError);
  });
});

type ConditionalPutPredicate = (key: string, body: string) => boolean;

/**
 * Holds matching conditional writes until every intended competitor has arrived.
 *
 * @param bucket - Conditional storage double receiving the deferred seam.
 * @param predicate - Selects the exact writes participating in the race.
 * @param participants - Number of writes required before releasing the barrier.
 */
function installPutBarrier(
  bucket: MemoryMirrorBucket,
  predicate: ConditionalPutPredicate,
  participants = 2,
): void {
  let waiting = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  /**
   * Waits at the barrier when the candidate belongs to this race.
   *
   * @param key - Exact private object key.
   * @param body - Candidate envelope bytes represented as text.
   */
  async function waitBeforePut(key: string, body: string): Promise<void> {
    if (!predicate(key, body)) return;
    waiting += 1;
    if (waiting === participants) release?.();
    await barrier;
  }
  bucket.beforeConditionalPut = waitBeforePut;
}

/**
 * Builds an authenticated note PUT without assuming its outcome.
 *
 * @param app - Composed Worker application under test.
 * @param sequence - Deterministic operation identity sequence.
 * @param content - Exact request body.
 * @param condition - Create-only or matching application precondition.
 * @returns Pending HTTP response from the composed application.
 */
function notePut(
  app: ReturnType<typeof application>["app"],
  sequence: number,
  content: string,
  condition: { readonly ifMatch?: string; readonly ifNoneMatch?: string },
) {
  const headers = mutationHeaders(sequence, condition);
  headers.set("Content-Type", "text/plain");
  return app.fetch(
    request(noteRoute("Alpha.md"), { method: "PUT", headers, body: content }),
  );
}

describe("Worker v2 reviewed transport boundaries", () => {
  it("authenticates every protected route/method and withholds CORS from unknown combinations", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const id = operationId(900);
    const protectedRoutes = [
      ["GET", "/api/v1/notes"],
      ["GET", noteRoute("Alpha.md", "v1")],
      ["PUT", noteRoute("Alpha.md", "v1")],
      ["DELETE", noteRoute("Alpha.md", "v1")],
      ["GET", "/api/v1/unknown/descendant"],
      ["GET", "/api/v2/mirror"],
      ["GET", "/api/v2/notes"],
      ["GET", noteRoute("Alpha.md")],
      ["PUT", noteRoute("Alpha.md")],
      ["DELETE", noteRoute("Alpha.md")],
      ["GET", `${noteRoute("Alpha.md")}/state`],
      ["GET", "/api/v2/recovery"],
      ["GET", `/api/v2/recovery/${id}`],
      ["GET", `/api/v2/recovery/${id}/content`],
      ["POST", `/api/v2/recovery/${id}/seal`],
      ["POST", `/api/v2/recovery/${id}/purge`],
    ] as const;
    for (const [method, path] of protectedRoutes) {
      const response = await app.fetch(request(path, { method }));
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        path.startsWith("/api/v2/") ? "*" : null,
      );
      expect(
        response.headers.get("Access-Control-Allow-Credentials"),
      ).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }

    for (const [method, path] of [
      ["GET", "/api/v2/unknown/descendant"],
      ["PATCH", noteRoute("Alpha.md")],
      ["POST", `${noteRoute("Alpha.md")}/state`],
    ] as const) {
      const response = await app.fetch(
        request(path, {
          method,
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("handles every registered preflight shape with exact methods and complete headers", async () => {
    const bucket = new MemoryMirrorBucket();
    let resolutions = 0;
    const app = createWorkerApp({
      logger: new TestLogger(),
      resolveMirrorServices: () => {
        resolutions += 1;
        return createTestMirrorServices(bucket);
      },
      resolveToken: () => TOKEN,
    });
    const id = operationId(901);
    const routes = [
      [V2_ROUTE_POLICY.mirror, "/api/v2/mirror", ["GET"]],
      [V2_ROUTE_POLICY.notes, "/api/v2/notes", ["GET"]],
      [V2_ROUTE_POLICY.note, noteRoute("Alpha.md"), ["GET", "PUT", "DELETE"]],
      [V2_ROUTE_POLICY.noteState, `${noteRoute("Alpha.md")}/state`, ["GET"]],
      [V2_ROUTE_POLICY.recovery, "/api/v2/recovery", ["GET"]],
      [V2_ROUTE_POLICY.recoveryItem, `/api/v2/recovery/${id}`, ["GET"]],
      [
        V2_ROUTE_POLICY.recoveryContent,
        `/api/v2/recovery/${id}/content`,
        ["GET"],
      ],
      [V2_ROUTE_POLICY.recoverySeal, `/api/v2/recovery/${id}/seal`, ["POST"]],
      [V2_ROUTE_POLICY.recoveryPurge, `/api/v2/recovery/${id}/purge`, ["POST"]],
    ] as const;
    const completeHeaders =
      "Authorization, Content-Type, If-Match, If-None-Match, Bridge-Operation-Id, Bridge-Association-Id, Bridge-Writer-Id";
    for (const [definition, path, expectedMethods] of routes) {
      expect(concreteV2Route(definition.path, id)).toBe(path);
      const operationMethods = Object.values(definition.operations);
      expect(operationMethods).toEqual(expectedMethods);
      for (const method of operationMethods) {
        const response = await app.fetch(
          request(path, {
            method: "OPTIONS",
            headers: {
              Origin: "app://obsidian.md",
              "Access-Control-Request-Method": method,
              "Access-Control-Request-Headers": completeHeaders,
            },
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
          operationMethods.join(", "),
        );
        expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
          completeHeaders,
        );
        expect(
          response.headers.get("Access-Control-Allow-Credentials"),
        ).toBeNull();
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }

      const disallowedMethod = operationMethods.some(
        (method) => method === "POST",
      )
        ? "GET"
        : "POST";
      const rejected = await app.fetch(
        request(path, {
          method: "OPTIONS",
          headers: {
            Origin: "app://obsidian.md",
            "Access-Control-Request-Method": disallowedMethod,
          },
        }),
      );
      expect(rejected.status, `${disallowedMethod} ${path}`).toBe(400);
      const unsupported = await app.fetch(
        request(path, {
          method: disallowedMethod,
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(unsupported.status, `${disallowedMethod} ${path}`).toBe(404);
      expect(unsupported.headers.get("Access-Control-Allow-Origin")).toBeNull();

      if (operationMethods.some((method) => method === "GET")) {
        const unauthenticatedHead = await app.fetch(
          request(path, { method: "HEAD" }),
        );
        expect(unauthenticatedHead.status, `HEAD ${path}`).toBe(401);
        expect(
          unauthenticatedHead.headers.get("Access-Control-Allow-Origin"),
        ).toBeNull();
        const authenticatedHead = await app.fetch(
          request(path, {
            method: "HEAD",
            headers: { Authorization: `Bearer ${TOKEN}` },
          }),
        );
        expect(authenticatedHead.status, `HEAD ${path}`).toBe(404);
        expect(
          authenticatedHead.headers.get("Access-Control-Allow-Origin"),
        ).toBeNull();
      }
    }
    expect(resolutions).toBe(0);
    const unknown = await app.fetch(
      request("/api/v2/unknown", {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(resolutions).toBe(0);
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("authenticates and rejects encoded static route aliases without CORS or services", async () => {
    const bucket = new MemoryMirrorBucket();
    let resolutions = 0;
    const app = createWorkerApp({
      logger: new TestLogger(),
      resolveMirrorServices: () => {
        resolutions += 1;
        return createTestMirrorServices(bucket);
      },
      resolveToken: () => TOKEN,
    });
    const aliases = [
      "/%61pi/v2/mirror",
      "/api/%762/mirror",
      "/api/v2/%6dirror",
      "/api/v2/%6eotes",
      "/api/v2/%72ecovery",
    ] as const;

    for (const path of aliases) {
      const preflight = await app.fetch(
        request(path, {
          method: "OPTIONS",
          headers: {
            Origin: "app://obsidian.md",
            "Access-Control-Request-Method": "GET",
          },
        }),
      );
      expect(preflight.status, `OPTIONS ${path}`).toBe(401);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

      const response = await app.fetch(
        request(path, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(response.status, `GET ${path}`).toBe(404);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect(resolutions).toBe(0);
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it.each([
    ["missing origin", { "Access-Control-Request-Method": "GET" }],
    ["missing method", { Origin: "app://obsidian.md" }],
    [
      "unsupported method",
      { Origin: "app://obsidian.md", "Access-Control-Request-Method": "POST" },
    ],
    [
      "unsupported header",
      {
        Origin: "app://obsidian.md",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Private",
      },
    ],
    [
      "duplicate header",
      {
        Origin: "app://obsidian.md",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, authorization",
      },
    ],
  ])(
    "rejects %s preflight metadata without storage",
    async (_name, headers) => {
      const bucket = new MemoryMirrorBucket();
      const { app } = application(bucket);
      const response = await app.fetch(
        request("/api/v2/mirror", { method: "OPTIONS", headers }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(bucket.getCount).toBe(0);
      expect(bucket.putKeys).toHaveLength(0);
    },
  );

  it("rejects percent-encoded note and recovery aliases plus hierarchical note paths without storage", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const canonicalPath = encodedPath("Alpha.md");
    const aliasedPath = `%${canonicalPath.charCodeAt(0).toString(16)}${canonicalPath.slice(1)}`;
    const id = operationId(902);
    const aliasedId = `%30${id.slice(1)}`;
    const cases: Array<
      [string, string, Headers | Record<string, string>, string | undefined]
    > = [
      [
        "GET",
        `/api/v1/notes/${aliasedPath}`,
        { Authorization: `Bearer ${TOKEN}` },
        undefined,
      ],
      [
        "GET",
        `/api/v2/notes/${aliasedPath}`,
        { Authorization: `Bearer ${TOKEN}` },
        undefined,
      ],
      [
        "GET",
        `/api/v2/notes/${aliasedPath}/state`,
        { Authorization: `Bearer ${TOKEN}` },
        undefined,
      ],
      [
        "PUT",
        `/api/v2/notes/${aliasedPath}`,
        (() => {
          const h = mutationHeaders(903, { ifNoneMatch: "*" });
          h.set("Content-Type", "text/plain");
          return h;
        })(),
        "private",
      ],
      [
        "DELETE",
        `/api/v2/notes/${aliasedPath}`,
        mutationHeaders(904, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
        undefined,
      ],
      [
        "GET",
        `/api/v2/recovery/${aliasedId}`,
        { Authorization: `Bearer ${TOKEN}` },
        undefined,
      ],
      [
        "GET",
        `/api/v2/recovery/${aliasedId}/content`,
        { Authorization: `Bearer ${TOKEN}` },
        undefined,
      ],
      [
        "POST",
        `/api/v2/recovery/${aliasedId}/seal`,
        mutationHeaders(905, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
        undefined,
      ],
      [
        "POST",
        `/api/v2/recovery/${aliasedId}/purge`,
        mutationHeaders(906, {
          ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
        }),
        undefined,
      ],
    ];
    for (const [method, path, headers, body] of cases) {
      const response = await app.fetch(
        request(path, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(400);
    }
    const hierarchical = await app.fetch(
      request(`/api/v2/notes/${canonicalPath}/child`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(hierarchical.status).toBe(400);
    expect(await errorCode(hierarchical)).toBe(API_ERROR_CODE.invalidPath);
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("refuses both wrong association and wrong writer on every mutation before storage", async () => {
    for (const headerName of ["Bridge-Association-Id", "Bridge-Writer-Id"]) {
      const bucket = new MemoryMirrorBucket();
      const { app } = application(bucket);
      const id = operationId(910);
      const cases = [
        ["PUT", noteRoute("Alpha.md"), { ifNoneMatch: "*" }, "private"],
        [
          "DELETE",
          noteRoute("Alpha.md"),
          { ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"' },
          undefined,
        ],
        [
          "POST",
          `/api/v2/recovery/${id}/seal`,
          { ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"' },
          undefined,
        ],
        [
          "POST",
          `/api/v2/recovery/${id}/purge`,
          { ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"' },
          undefined,
        ],
      ] as const;
      for (const [method, path, condition, body] of cases) {
        const headers = mutationHeaders(911, condition);
        headers.set(headerName, "99999999-9999-4999-8999-999999999999");
        if (method === "PUT") headers.set("Content-Type", "text/plain");
        const response = await app.fetch(
          request(path, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
        );
        expect(response.status).toBe(403);
      }
      expect(bucket.getCount).toBe(0);
      expect(bucket.putKeys).toHaveLength(0);
    }
  });

  it("wires matching preconditions and bodyless validation before application storage", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const id = operationId(920);
    const cases = [
      ["DELETE", noteRoute("Alpha.md")],
      ["POST", `/api/v2/recovery/${id}/seal`],
      ["POST", `/api/v2/recovery/${id}/purge`],
    ] as const;
    for (const [index, [method, path]] of cases.entries()) {
      const missing = await app.fetch(
        request(path, {
          method,
          headers: mutationHeaders(921 + index, {}),
        }),
      );
      expect(missing.status).toBe(428);
      expect(await errorCode(missing)).toBe(
        API_ERROR_CODE.preconditionRequired,
      );

      const malformed = await app.fetch(
        request(path, {
          method,
          headers: mutationHeaders(924 + index, {
            ifMatch: 'W/"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
          }),
        }),
      );
      expect(malformed.status).toBe(400);
      expect(await errorCode(malformed)).toBe(API_ERROR_CODE.invalidRequest);

      const nonempty = await app.fetch(
        request(path, {
          method,
          headers: mutationHeaders(927 + index, {
            ifMatch: '"m3-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"',
          }),
          body: "not empty",
        }),
      );
      expect(nonempty.status).toBe(400);
      expect(await errorCode(nonempty)).toBe(API_ERROR_CODE.invalidRequest);
    }
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });

  it("keeps CORS and no-store on registered successes and errors only", async () => {
    const { app } = application(new MemoryMirrorBucket());
    for (const response of [
      await app.fetch(
        request("/api/v2/mirror", {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      ),
      await app.fetch(
        request("/api/v2/notes/not-base64!", {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      ),
    ]) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "ETag, Bridge-Note-Format",
      );
      expect(
        response.headers.get("Access-Control-Allow-Credentials"),
      ).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});

describe("Worker handler-to-conditional-storage races", () => {
  it("allows exactly one concurrent absence-only create", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    installPutBarrier(bucket, (key) => key === "vault/Alpha.md");
    const responses = await Promise.all([
      notePut(app, 1001, "first", { ifNoneMatch: "*" }),
      notePut(app, 1002, "second", { ifNoneMatch: "*" }),
    ]);
    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 412]);
    const stored = JSON.parse(bucket.body("vault/Alpha.md") ?? "null");
    const acknowledgement = mutationAcknowledgementSchema.parse(
      await required(
        responses.find((response) => response.status === 201),
      ).json(),
    );
    expect(["first", "second"]).toContain(stored.content);
    expect(stored.revision).toBe(acknowledgement.revision);
    expect(bucket.putKeys).toEqual(["vault/Alpha.md", "vault/Alpha.md"]);
    expect(bucket.putKeys.some((key) => key.startsWith("recovery/"))).toBe(
      false,
    );
    expect(
      bucket.putOptions.every((options) => options.onlyIf instanceof Headers),
    ).toBe(true);
  });

  it("allows exactly one of two updates observed at the same application revision", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 1010, "A");
    installPutBarrier(bucket, (key) => key === "vault/Alpha.md");
    const condition = { ifMatch: `"m3-${created.acknowledgement.revision}"` };
    const responses = await Promise.all([
      notePut(app, 1011, "B", condition),
      notePut(app, 1012, "C", condition),
    ]);
    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 412]);
    const stored = JSON.parse(bucket.body("vault/Alpha.md") ?? "null");
    const acknowledgement = mutationAcknowledgementSchema.parse(
      await required(
        responses.find((response) => response.status === 200),
      ).json(),
    );
    expect(["B", "C"]).toContain(stored.content);
    expect(stored.revision).toBe(acknowledgement.revision);
    expect(stored.revision).not.toBe(created.acknowledgement.revision);
    expect(bucket.putKeys.some((key) => key.startsWith("recovery/"))).toBe(
      false,
    );
    expect(
      bucket.putOptions.every(
        (options) =>
          options.onlyIf instanceof Headers || "etagMatches" in options.onlyIf,
      ),
    ).toBe(true);
  });

  it("preserves a winning update while a deletion is held before current-head CAS", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 1020, "A");
    let tombstoneArrived: (() => void) | undefined;
    let releaseTombstone: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      tombstoneArrived = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTombstone = resolve;
    });
    bucket.beforeConditionalPut = async (key, body) => {
      if (key !== "vault/Alpha.md" || JSON.parse(body).kind !== "tombstone")
        return;
      tombstoneArrived?.();
      await release;
    };
    const deletion = app.fetch(
      request(noteRoute("Alpha.md"), {
        method: "DELETE",
        headers: mutationHeaders(1021, {
          ifMatch: `"m3-${created.acknowledgement.revision}"`,
        }),
      }),
    );
    await arrived;
    const update = await notePut(app, 1022, "B", {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    expect(update.status).toBe(200);
    const acknowledgement = mutationAcknowledgementSchema.parse(
      await update.json(),
    );
    releaseTombstone?.();
    expect((await deletion).status).toBe(412);
    const stored = JSON.parse(bucket.body("vault/Alpha.md") ?? "null");
    expect(stored.kind).toBe("live");
    expect(stored.content).toBe("B");
    expect(stored.revision).toBe(acknowledgement.revision);
    expect(
      bucket.putKeys.filter((key) => key.startsWith("recovery/")),
    ).toHaveLength(1);
    expect(
      JSON.parse(bucket.body(`recovery/${operationId(1021)}`) ?? "null").kind,
    ).toBe("prepared");
    expect(
      bucket.putOptions.every(
        (options) =>
          options.onlyIf instanceof Headers || "etagMatches" in options.onlyIf,
      ),
    ).toBe(true);
  });

  it("returns the exact successful acknowledgement before a later overwrite", async () => {
    const bucket = new MemoryMirrorBucket();
    const { app } = application(bucket);
    const created = await createNote(app, 1030, "A");
    let laterResponse: Response | undefined;
    bucket.afterConditionalPut = async (key, body) => {
      const envelope = JSON.parse(body);
      if (key !== "vault/Alpha.md" || envelope.content !== "B") return;
      bucket.afterConditionalPut = undefined;
      laterResponse = await notePut(app, 1032, "C", {
        ifMatch: `"m3-${envelope.revision}"`,
      });
    };
    const first = await notePut(app, 1031, "B", {
      ifMatch: `"m3-${created.acknowledgement.revision}"`,
    });
    expect(first.status).toBe(200);
    expect(laterResponse?.status).toBe(200);
    const acknowledgement = mutationAcknowledgementSchema.parse(
      await first.json(),
    );
    const stored = JSON.parse(bucket.body("vault/Alpha.md") ?? "null");
    expect(acknowledgement.receipt.operationId).toBe(operationId(1031));
    expect(acknowledgement.revision).not.toBe(stored.revision);
    expect(stored.content).toBe("C");
    expect(bucket.putKeys.some((key) => key.startsWith("recovery/"))).toBe(
      false,
    );
    expect(
      bucket.putOptions.every(
        (options) =>
          options.onlyIf instanceof Headers || "etagMatches" in options.onlyIf,
      ),
    ).toBe(true);
  });
});

describe("oversized legacy list compatibility", () => {
  it("filters oversized untagged entries from composed v1/v2 lists while direct reads still fail", async () => {
    const bucket = new MemoryMirrorBucket();
    bucket.seed("vault/Visible.md", "visible");
    bucket.seed("vault/Oversized.md", "x".repeat(1_048_577));
    const { app } = application(bucket);
    const authorization = { Authorization: `Bearer ${TOKEN}` };
    expect(
      await (
        await app.fetch(request("/api/v2/notes", { headers: authorization }))
      ).json(),
    ).toEqual({ notes: ["Visible.md"], nextCursor: null });
    expect(
      await (
        await app.fetch(request("/api/v1/notes", { headers: authorization }))
      ).json(),
    ).toEqual({ notes: ["Visible.md"] });
    expect(
      (
        await app.fetch(
          request(noteRoute("Oversized.md"), { headers: authorization }),
        )
      ).status,
    ).toBe(500);

    bucket.seed("vault/Tagged.md", "x".repeat(1_048_577), {
      bridgeFormat: "2",
    });
    expect(
      (await app.fetch(request("/api/v2/notes", { headers: authorization })))
        .status,
    ).toBe(500);
    expect(
      (await app.fetch(request("/api/v1/notes", { headers: authorization })))
        .status,
    ).toBe(500);
  });
});
