import { GRANT_REVOCATION_OBJECT_PREFIX } from "@worker/auth/grant-revocation.constants";
import {
  createGrantRevocationId,
  parseGrantRevocationId,
} from "@worker/auth/grant-revocation-id";
import type { GrantRevocationBucketPort } from "@worker/infrastructure/r2-grant-revocation.repository";
import { R2GrantRevocationRepository } from "@worker/infrastructure/r2-grant-revocation.repository";
import { describe, expect, it } from "vitest";

const ID = parseGrantRevocationId("11111111-1111-4111-8111-111111111111");
if (ID === undefined) throw new Error("Invalid fixture");

class MemoryBucket implements GrantRevocationBucketPort {
  readonly objects = new Set<string>();
  readonly attempts: Array<{ key: string; onlyIf: Headers; body: string }> = [];
  failHead = false;
  failPut = false;
  failAfterCommit = false;

  async head(key: string): Promise<{ readonly key: string } | null> {
    if (this.failHead) throw new Error("R2 read unavailable");
    return this.objects.has(key) ? { key } : null;
  }

  async put(
    key: string,
    body: string,
    options: {
      readonly onlyIf: Headers;
      readonly httpMetadata: { readonly contentType: string };
    },
  ): Promise<{ readonly key: string } | null> {
    this.attempts.push({ key, onlyIf: options.onlyIf, body });
    expect(options.httpMetadata.contentType).toBe("application/octet-stream");
    if (this.failPut) throw new Error("R2 write unavailable");
    if (this.objects.has(key)) return null;
    this.objects.add(key);
    if (this.failAfterCommit) throw new Error("response lost after commit");
    return { key };
  }
}

describe("grant revocation storage", () => {
  it("accepts only canonical UUID-v4 IDs and creates fresh opaque IDs", () => {
    expect(parseGrantRevocationId("../../vault/note.md")).toBeUndefined();
    expect(parseGrantRevocationId("11111111-1111-4111-8111-111111111111")).toBe(
      ID,
    );
    const first = createGrantRevocationId();
    const second = createGrantRevocationId();
    expect(first).not.toBe(second);
    expect(parseGrantRevocationId(first)).toBe(first);
  });

  it("creates a marker outside note namespaces and confirms repeated revocation", async () => {
    const bucket = new MemoryBucket();
    const store = new R2GrantRevocationRepository(bucket);
    expect(await store.check(ID)).toBe("active");
    expect(await store.revoke(ID)).toBe("confirmed");
    expect(await store.check(ID)).toBe("revoked");
    expect(await store.revoke(ID)).toBe("confirmed");
    expect(bucket.objects.size).toBe(1);
    expect(bucket.attempts[0]?.key).toBe(
      `${GRANT_REVOCATION_OBJECT_PREFIX}${ID}`,
    );
    expect(bucket.attempts[0]?.key.startsWith("vault/")).toBe(false);
    expect(bucket.attempts[0]?.key.startsWith("recovery/")).toBe(false);
    expect(bucket.attempts[0]?.onlyIf.get("If-None-Match")).toBe("*");
    expect(bucket.attempts[0]?.body).toBe("");
  });

  it("does not report an unavailable read or uncertain write as active", async () => {
    const bucket = new MemoryBucket();
    const store = new R2GrantRevocationRepository(bucket);
    bucket.failHead = true;
    expect(await store.check(ID)).toBe("unavailable");
    bucket.failPut = true;
    expect(await store.revoke(ID)).toBe("uncertain");
    expect(bucket.objects.size).toBe(0);
  });

  it("confirms a committed marker after a lost write response", async () => {
    const bucket = new MemoryBucket();
    bucket.failAfterCommit = true;
    const store = new R2GrantRevocationRepository(bucket);
    expect(await store.revoke(ID)).toBe("confirmed");
    expect(await store.check(ID)).toBe("revoked");
  });
});
