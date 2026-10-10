import type {
  SyncDemoClientEnvironment,
  SyncDemoLedger,
  SyncDemoLedgerStore,
  SyncDemoLocal,
  SyncDemoRemote,
  SyncDeviceId,
  SyncEventSequence,
  SyncMutationResult,
  SyncNotePath,
  SyncOperationId,
  SyncReadCurrentResult,
  SyncRevision,
  SyncVaultId,
  SyncVersionRecord,
} from "@core/index";
import { SyncDemoClient } from "@core/sync/sync-demo-client";
import { createContentSha256 } from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

const vaultId = "22222222-2222-4222-8222-222222222222" as SyncVaultId;
const deviceId = "33333333-3333-4333-8333-333333333333" as SyncDeviceId;
const path = "demo.md" as SyncNotePath;
const otherPath = "other.md" as SyncNotePath;
const cursor = "synthetic-zero-cursor";
const sequence = "00000000000000000001" as SyncEventSequence;
let identity = 10;
function uuid() {
  identity += 1;
  return `${identity.toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
}
async function hash(content: string) {
  const value = createContentSha256(
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
    ).toString("hex"),
  );
  if (value === undefined) throw new Error("Invalid fixture hash");
  return value;
}
async function fixture(initial: string | null = "local") {
  let ledger: SyncDemoLedger = {
    schemaVersion: 1,
    vaultId,
    deviceId,
    cursor,
    entries: [{ path, base: null, work: null }],
  };
  let local = initial;
  let now = 1000;
  const copies = new Map<SyncRevision, string>();
  const versions = new Map<
    SyncRevision,
    Extract<SyncVersionRecord, { kind: "live" }>
  >();
  let head: SyncReadCurrentResult = { kind: "never_seen" };
  const requests: Parameters<SyncDemoRemote["mutate"]>[0][] = [];
  const committed = new Map<string, SyncMutationResult>();
  const store: SyncDemoLedgerStore = {
    load: async () => ({ kind: "ready", ledger: structuredClone(ledger) }),
    save: async (value) => {
      ledger = structuredClone(value);
      return true;
    },
  };
  const host: SyncDemoLocal = {
    observe: async () =>
      local === null ? { kind: "absent" } : { kind: "live", content: local },
    apply: async (_path, expected, content) => {
      if (local !== expected) return "refused";
      local = content;
      return "applied";
    },
    preserve: async (_path, revision, content) => {
      if (!copies.has(revision)) copies.set(revision, content);
    },
    preserved: async (_path, revision) => copies.get(revision) ?? null,
  };
  async function publish(content: string, origin = deviceId) {
    const revision = uuid() as SyncRevision;
    const operationId = uuid() as SyncOperationId;
    const version = {
      kind: "live" as const,
      vaultId,
      path,
      revision,
      operationId,
      origin,
      parent:
        head.kind === "live"
          ? { kind: "revision" as const, revision: head.revision }
          : { kind: "never_seen" as const },
      contentSha256: await hash(content),
      content,
      byteSize: new TextEncoder().encode(content).byteLength,
      mediaType: "text/markdown" as const,
    };
    versions.set(revision, version);
    const {
      content: _content,
      vaultId: _vaultId,
      path: _path,
      ...metadata
    } = version;
    head = metadata;
    return version;
  }
  const remote: SyncDemoRemote = {
    beginPass: () => {},
    current: async () => head,
    version: async (revision) => {
      const version = versions.get(revision);
      return version ? { kind: "present", version } : { kind: "absent" };
    },
    mutate: async (request) => {
      requests.push(structuredClone(request));
      const replay = committed.get(request.operationId);
      if (replay) return replay;
      if (
        request.parent.kind === "never_seen"
          ? head.kind !== "never_seen"
          : head.kind !== "live" || head.revision !== request.parent.revision
      )
        return { kind: "error", code: "stale_revision" };
      const version = {
        ...request,
        kind: "live" as const,
        byteSize: new TextEncoder().encode(request.content).byteLength,
      };
      versions.set(request.revision, version);
      const {
        content: _content,
        vaultId: _vaultId,
        path: _path,
        ...metadata
      } = version;
      head = metadata;
      const outcome: SyncMutationResult = {
        kind: "committed",
        revision: request.revision,
        operationId: request.operationId,
        position: { lane: 0, sequence },
      };
      committed.set(request.operationId, outcome);
      return outcome;
    },
    changes: async () => ({ kind: "page", events: [], nextCursor: cursor }),
  };
  const environment: SyncDemoClientEnvironment = {
    binding: { vaultId, deviceId, paths: [path] },
    now: () => now,
    operationId: () => uuid() as SyncOperationId,
    revision: () => uuid() as SyncRevision,
  };
  const client = () => new SyncDemoClient(store, host, remote, environment);
  return {
    client,
    store,
    host,
    remote,
    environment,
    versions,
    requests,
    copies,
    publish,
    ledger: () => ledger,
    setLedger: (value: SyncDemoLedger) => {
      ledger = value;
    },
    local: () => local,
    edit: (value: string | null) => {
      local = value;
    },
    head: () => head,
    setHead: (value: SyncReadCurrentResult) => {
      head = value;
    },
    advance: () => {
      now += 5000;
    },
  };
}

async function twoPathFixture() {
  const f = await fixture();
  let otherLocal: string | null = "other local";
  let otherHead: SyncReadCurrentResult = { kind: "never_seen" };
  const otherRequests: Parameters<SyncDemoRemote["mutate"]>[0][] = [];
  const originalObserve = f.host.observe.bind(f.host);
  const originalCurrent = f.remote.current.bind(f.remote);
  const originalMutate = f.remote.mutate.bind(f.remote);
  const ledger = f.ledger();
  f.setLedger({
    ...ledger,
    entries: [...ledger.entries, { path: otherPath, base: null, work: null }],
  });
  Object.assign(f.environment, {
    binding: { vaultId, deviceId, paths: [path, otherPath] },
  });
  vi.spyOn(f.host, "observe").mockImplementation((target) =>
    target === path
      ? originalObserve(target)
      : Promise.resolve(
          otherLocal === null
            ? { kind: "absent" as const }
            : { kind: "live" as const, content: otherLocal },
        ),
  );
  vi.spyOn(f.remote, "current").mockImplementation((target) =>
    target === path ? originalCurrent(target) : Promise.resolve(otherHead),
  );
  vi.spyOn(f.remote, "mutate").mockImplementation(async (request) => {
    if (request.path === path) return originalMutate(request);
    otherRequests.push(structuredClone(request));
    if (
      request.parent.kind === "never_seen"
        ? otherHead.kind !== "never_seen"
        : otherHead.kind !== "live" ||
          otherHead.revision !== request.parent.revision
    )
      return { kind: "error", code: "stale_revision" };
    const byteSize = new TextEncoder().encode(request.content).byteLength;
    f.versions.set(request.revision, {
      ...request,
      kind: "live",
      byteSize,
    });
    const {
      content: _content,
      vaultId: _vaultId,
      path: _path,
      ...head
    } = request;
    otherHead = {
      ...head,
      kind: "live",
      byteSize,
    };
    return {
      kind: "committed",
      revision: request.revision,
      operationId: request.operationId,
      position: { lane: 0, sequence },
    };
  });
  return {
    ...f,
    otherRequests,
    editOther: (value: string | null) => {
      otherLocal = value;
    },
    otherHead: () => otherHead,
    publishOther: async (content: string) => {
      const version = {
        kind: "live" as const,
        vaultId,
        path: otherPath,
        revision: uuid() as SyncRevision,
        operationId: uuid() as SyncOperationId,
        origin: deviceId,
        parent:
          otherHead.kind === "live"
            ? { kind: "revision" as const, revision: otherHead.revision }
            : { kind: "never_seen" as const },
        contentSha256: await hash(content),
        content,
        byteSize: new TextEncoder().encode(content).byteLength,
        mediaType: "text/markdown" as const,
      };
      f.versions.set(version.revision, version);
      const {
        content: _content,
        vaultId: _vaultId,
        path: _path,
        ...head
      } = version;
      otherHead = head;
      return version;
    },
  };
}

describe("durable exact-base local demo reconciliation", () => {
  it("holds every path before a manual fresh-client pass during a durable shared marker floor", async () => {
    const f = await twoPathFixture();
    const ledger = f.ledger();
    const first = ledger.entries[0];
    const second = ledger.entries[1];
    if (first === undefined || second === undefined)
      throw new Error("missing two-path fixture");
    f.setLedger({
      ...ledger,
      entries: [
        {
          ...first,
          work: {
            kind: "push",
            certainty: "uncertain",
            operationId: uuid() as SyncOperationId,
            revision: uuid() as SyncRevision,
            parent: { kind: "never_seen" },
            contentSha256: await hash("local"),
            retryAfterEpochMs: 5000,
            vaultRetryAfterEpochMs: 5000,
          },
        },
        second,
      ],
    });
    const current = vi.spyOn(f.remote, "current");
    const beginPass = vi.spyOn(f.remote, "beginPass");
    expect(await f.client().syncNow()).toBe("pending");
    expect(beginPass).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    expect(f.otherRequests).toHaveLength(0);
    expect(f.ledger().cursor).toBe(cursor);
    f.advance();
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.requests).toHaveLength(1);
    expect(f.otherRequests).toHaveLength(1);
  });
  it("settles a healthy path while another is pending, withholding the whole-page cursor", async () => {
    const f = await twoPathFixture();
    f.setHead({
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs: 5000,
    });
    const changes = vi.spyOn(f.remote, "changes");
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.otherRequests).toHaveLength(1);
    expect(f.ledger().entries[1]?.base?.revision).toBe(
      f.otherRequests[0]?.revision,
    );
    expect(f.ledger().cursor).toBe(cursor);
    expect(changes).not.toHaveBeenCalled();
    f.setHead({ kind: "never_seen" });
    changes.mockResolvedValue({
      kind: "page",
      events: [],
      nextCursor: "next-complete-page",
    });
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.ledger().cursor).toBe("next-complete-page");
    expect(f.otherRequests).toHaveLength(1);
  });
  it("stops the pass before another path when persistence throws", async () => {
    const f = await twoPathFixture();
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("uncertain ledger persistence"),
    );
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(0);
    expect(f.otherRequests).toHaveLength(0);
    expect(f.ledger().entries.every((entry) => entry.work === null)).toBe(true);
    expect(f.ledger().cursor).toBe(cursor);
  });
  it("does not infer deletion from one path while another advances at its exact base", async () => {
    const f = await twoPathFixture();
    expect(await f.client().syncNow()).toBe("settled");
    const otherBase = f.ledger().entries[1]?.base?.revision;
    f.edit(null);
    f.editOther("other successor");
    const changes = vi.spyOn(f.remote, "changes");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(1);
    expect(f.otherRequests[1]?.parent).toEqual({
      kind: "revision",
      revision: otherBase,
    });
    expect(f.ledger().entries[1]?.base?.revision).toBe(
      f.otherRequests[1]?.revision,
    );
    expect(f.ledger().cursor).toBe(cursor);
    expect(changes).not.toHaveBeenCalled();
  });
  it("reports stale CAS conflict above another pending path and preserves both versions", async () => {
    const f = await twoPathFixture();
    expect(await f.client().syncNow()).toBe("settled");
    const originalBase = f.ledger().entries[1]?.base;
    f.setHead({
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs: 5000,
    });
    f.editOther("other local competitor");
    const mutate = f.remote.mutate.bind(f.remote);
    let competitor: Awaited<ReturnType<typeof f.publishOther>> | undefined;
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => {
      competitor = await f.publishOther("other remote competitor");
      return mutate(request);
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.otherRequests[1]?.parent).toEqual({
      kind: "revision",
      revision: originalBase?.revision,
    });
    expect(f.ledger().entries[1]?.base).toEqual(originalBase);
    expect(f.ledger().entries[1]?.work?.kind).toBe("conflict");
    expect(competitor && f.copies.get(competitor.revision)).toBe(
      "other remote competitor",
    );
    expect(f.ledger().cursor).toBe(cursor);
  });
  it("publishes a fresh positive note and persists committed exact base without note bytes", async () => {
    const f = await fixture();
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.ledger().entries[0]?.base).toEqual({
      revision: f.requests[0]?.revision,
      contentSha256: await hash("local"),
    });
    expect(f.ledger().entries[0]?.work).toBeNull();
    expect(JSON.stringify(f.ledger())).not.toContain('"content":');
  });
  it("imports into fresh absent local state and applies a later clean revision", async () => {
    const f = await fixture(null);
    await f.publish("remote first");
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.local()).toBe("remote first");
    const next = await f.publish("remote second");
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.local()).toBe("remote second");
    expect(f.ledger().entries[0]?.base?.revision).toBe(next.revision);
  });
  it("publishes a saved change only at the durable exact parent", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const parent = f.ledger().entries[0]?.base?.revision;
    f.edit("saved edit");
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.requests[1]?.parent).toEqual({
      kind: "revision",
      revision: parent,
    });
    expect(f.requests[1]?.content).toBe("saved edit");
  });
  it("retains both concurrent versions without replacing local bytes or refreshing a stale parent", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const base = f.ledger().entries[0]?.base;
    f.edit("local competitor");
    const remote = await f.publish("REST competitor");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("local competitor");
    expect(f.copies.get(remote.revision)).toBe("REST competitor");
    expect(f.ledger().entries[0]).toMatchObject({
      base,
      work: {
        kind: "conflict",
        target: { revision: remote.revision },
        preserved: true,
      },
    });
    expect(f.requests).toHaveLength(1);
  });
  it("refuses adoption even when an existing untracked target has identical text", async () => {
    const f = await fixture("same");
    const remote = await f.publish("same");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
    expect(f.local()).toBe("same");
    expect(f.copies.get(remote.revision)).toBe("same");
  });
  it("catches an edit inside atomic replacement and preserves the remote competitor", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const remote = await f.publish("remote race");
    vi.spyOn(f.host, "apply").mockImplementation(async () => {
      f.edit("raced local");
      return "refused";
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("raced local");
    expect(f.copies.get(remote.revision)).toBe("remote race");
  });
  it("never infers deletion from local absence", async () => {
    const f = await fixture();
    await f.client().syncNow();
    f.edit(null);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(1);
    expect(f.head().kind).toBe("live");
  });
  it("cannot dispatch an effect after ledger save failure", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "save").mockResolvedValue(false);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(0);
    expect(f.local()).toBe("local");
  });
  it("persists unknown mutation identity and floor through restart, then replays the identical full request", async () => {
    const f = await fixture();
    const mutate = f.remote.mutate.bind(f.remote);
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => {
      await mutate(request);
      return {
        kind: "error",
        code: "effect_unknown",
        operationId: request.operationId,
        retryAfterEpochMs: 5000,
        retryScope: "vault",
      };
    });
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.ledger().entries[0]?.base).toBeNull();
    expect(f.ledger().entries[0]?.work).toMatchObject({
      kind: "push",
      retryAfterEpochMs: 5000,
      vaultRetryAfterEpochMs: 5000,
    });
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.requests).toHaveLength(1);
    f.advance();
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.requests[1]).toEqual(f.requests[0]);
  });
  it("reconstructs an uncertain original request from fully matching immutable evidence, retaining a newer local edit", async () => {
    const f = await fixture();
    const mutate = f.remote.mutate.bind(f.remote);
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => {
      await mutate(request);
      return { kind: "error", code: "effect_unknown" };
    });
    expect(await f.client().syncNow()).toBe("pending");
    f.edit("newer saved successor");
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.local()).toBe("newer saved successor");
    expect(f.ledger().entries[0]?.base?.contentSha256).toBe(
      await hash("local"),
    );
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.requests[2]?.content).toBe("newer saved successor");
  });
  it("cannot substitute changed local bytes or acknowledge merely present version evidence", async () => {
    const f = await fixture();
    vi.spyOn(f.remote, "mutate").mockResolvedValue({
      kind: "error",
      code: "effect_unknown",
    });
    await f.client().syncNow();
    f.edit("lost original");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
  });
  it("settles only the prepared local postcondition after interruption and never redispatches divergent work", async () => {
    const f = await fixture(null);
    const target = await f.publish("prepared remote");
    const ledger = f.ledger();
    f.setLedger({
      ...ledger,
      entries: [
        {
          path,
          base: null,
          work: {
            kind: "apply",
            target: {
              revision: target.revision,
              contentSha256: target.contentSha256,
            },
            expectedHash: null,
          },
        },
      ],
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBeNull();
    f.edit("prepared remote");
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.ledger().entries[0]?.base?.revision).toBe(target.revision);
  });
  it("rejects tombstones without local deletion", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const head = f.head();
    if (head.kind !== "live") throw new Error("fixture failed");
    f.setHead({
      ...head,
      kind: "tombstone",
      parent: { kind: "revision", revision: head.revision },
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("local");
  });
  it("reports cursor failure without reset or progress", async () => {
    const f = await fixture();
    await f.client().syncNow();
    vi.spyOn(f.remote, "changes").mockResolvedValue({
      kind: "error",
      code: "cursor_expired",
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().cursor).toBe(cursor);
  });
  it("treats historical feed events as hints and never regresses a newer base", async () => {
    const f = await fixture(null);
    const old = await f.publish("old");
    const newer = await f.publish("new");
    vi.spyOn(f.remote, "changes").mockResolvedValue({
      kind: "page",
      events: [
        {
          kind: "changed",
          lane: 0,
          sequence,
          path,
          result: { kind: "live", revision: old.revision },
          operationId: old.operationId,
          origin: old.origin,
          committedAtEpochMs: 1,
        },
      ],
      nextCursor: cursor,
    });
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.local()).toBe("new");
    expect(f.ledger().entries[0]?.base?.revision).toBe(newer.revision);
  });
  it.each(["\ud800", "x".repeat(16385)])(
    "refuses malformed or oversized saved bytes before effects",
    async (content) => {
      const f = await fixture(content);
      expect(await f.client().syncNow()).toBe("attention");
      expect(f.requests).toHaveLength(0);
    },
  );
  it("preserves an intervening remote edit when an original-parent push loses CAS", async () => {
    const f = await fixture();
    await f.client().syncNow();
    f.edit("local losing CAS");
    const mutate = f.remote.mutate.bind(f.remote);
    let competing: SyncRevision | undefined;
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => {
      competing = (await f.publish("remote winning CAS")).revision;
      return mutate(request);
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("local losing CAS");
    expect(competing && f.copies.get(competing)).toBe("remote winning CAS");
    expect(f.requests).toHaveLength(2);
  });
  it("withholds ACK after a local effect until persistence, then settles the same prepared postcondition after restart", async () => {
    const f = await fixture(null);
    const target = await f.publish("target after interrupted save");
    const save = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save")
      .mockImplementationOnce(save)
      .mockResolvedValueOnce(false);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("target after interrupted save");
    expect(f.ledger().entries[0]?.base).toBeNull();
    expect(f.ledger().entries[0]?.work).toMatchObject({
      kind: "apply",
      target: { revision: target.revision },
    });
    expect(await f.client().syncNow()).toBe("settled");
    expect(f.ledger().entries[0]?.base?.revision).toBe(target.revision);
  });
  it("keeps uncertain local effects prepared and never repeats the replacement after restart", async () => {
    const f = await fixture(null);
    await f.publish("remote prepared");
    vi.spyOn(f.host, "apply").mockResolvedValue("unknown");
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.local()).toBeNull();
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
  });
  it("does not overwrite a conflicting preservation copy or mark it verified", async () => {
    const f = await fixture();
    await f.client().syncNow();
    f.edit("local competitor");
    const target = await f.publish("remote competitor");
    f.copies.set(target.revision, "foreign copy");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.copies.get(target.revision)).toBe("foreign copy");
    expect(f.ledger().entries[0]?.work).toMatchObject({
      kind: "conflict",
      preserved: false,
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("local competitor");
  });
  it.each([
    "operation_id_reused",
    "invalid_input",
    "sequence_exhausted",
  ] as const)(
    "retains the original intent on terminal refusal %s",
    async (code) => {
      const f = await fixture();
      vi.spyOn(f.remote, "mutate").mockResolvedValue({ kind: "error", code });
      expect(await f.client().syncNow()).toBe("attention");
      expect(f.ledger().entries[0]?.base).toBeNull();
      expect(f.ledger().entries[0]?.work?.kind).toBe("push");
    },
  );
  it("refuses a committed response for another request identity", async () => {
    const f = await fixture();
    vi.spyOn(f.remote, "mutate").mockResolvedValue({
      kind: "committed",
      revision: uuid() as SyncRevision,
      operationId: uuid() as SyncOperationId,
      position: { lane: 0, sequence },
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
  });
  it("refuses pending context for another operation without changing original identity", async () => {
    const f = await fixture();
    vi.spyOn(f.remote, "mutate").mockResolvedValue({
      kind: "error",
      code: "operation_pending",
      operationId: uuid() as SyncOperationId,
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.work?.kind).toBe("push");
  });
  it("retains pre-journal original identity when admission is refused", async () => {
    const f = await fixture();
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => ({
      kind: "error",
      code: "mutation_not_admitted",
      operationId: request.operationId,
    }));
    expect(await f.client().syncNow()).toBe("pending");
    const work = f.ledger().entries[0]?.work;
    expect(work?.kind).toBe("push");
    expect(await f.client().syncNow()).toBe("settled");
    if (work?.kind === "push")
      expect(f.requests[0]).toMatchObject({
        operationId: work.operationId,
        revision: work.revision,
        parent: work.parent,
      });
  });
  it("rejects corruption, foreign bindings and unavailable observation without effects", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "load").mockResolvedValueOnce({ kind: "blocked" });
    expect(await f.client().syncNow()).toBe("attention");
    f.setLedger({
      ...f.ledger(),
      deviceId: "44444444-4444-4444-8444-444444444444" as SyncDeviceId,
    });
    expect(await f.client().syncNow()).toBe("attention");
    f.setLedger({ ...f.ledger(), deviceId });
    vi.spyOn(f.host, "observe").mockResolvedValue({ kind: "blocked" });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(0);
  });
  it("does not convert failed established reads into new creates or empty settled pages", async () => {
    const f = await fixture();
    await f.client().syncNow();
    f.setHead({ kind: "error", code: "storage_unavailable" });
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.requests).toHaveLength(1);
    vi.spyOn(f.remote, "changes").mockResolvedValue({
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs: 5000,
    });
    const request = f.requests[0];
    if (!request) throw new Error("Missing fixture request");
    const current = f.versions.get(request.revision);
    if (!current) throw new Error("Missing fixture generation");
    f.setHead(current);
    expect(await f.client().syncNow()).toBe("pending");
    expect(f.ledger().cursor).toBe(cursor);
  });
  it("rejects linked current metadata with divergent body identity", async () => {
    const f = await fixture(null);
    const version = await f.publish("verified remote");
    f.versions.set(version.revision, { ...version, content: "tampered" });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBeNull();
    f.versions.set(version.revision, {
      ...version,
      operationId: uuid() as SyncOperationId,
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
  });
  it("refuses missing immutable evidence for a published head", async () => {
    const f = await fixture(null);
    const version = await f.publish("remote");
    f.versions.delete(version.revision);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBeNull();
  });
  it("refuses missing ACK bytes before a clean replacement", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const base = f.ledger().entries[0]?.base;
    await f.publish("remote successor");
    if (!base) throw new Error("Missing base");
    f.versions.delete(base.revision);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.local()).toBe("local");
  });
  it("contains raw local host failures without resetting prepared authority", async () => {
    const f = await fixture(null);
    await f.publish("remote");
    vi.spyOn(f.host, "apply").mockRejectedValue(
      new Error("private host failure"),
    );
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.work?.kind).toBe("apply");
  });
  it("rejects foreign and tombstone feed events without checkpoint advancement", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const head = f.head();
    if (head.kind !== "live") throw new Error("Missing head");
    const event = {
      kind: "changed" as const,
      lane: 0,
      sequence,
      path,
      result: { kind: "tombstone" as const, revision: head.revision },
      operationId: head.operationId,
      origin: deviceId,
      committedAtEpochMs: 1,
    };
    vi.spyOn(f.remote, "changes").mockResolvedValue({
      kind: "page",
      events: [event],
      nextCursor: "must-not-advance",
    });
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().cursor).toBe(cursor);
  });
  it("closes admission when the content-identity provider fails", async () => {
    const f = await fixture();
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("private crypto failure"),
    );
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(0);
    expect(f.ledger().entries[0]?.work).toBeNull();
  });
  it("does not reconstruct a pre-journal not-admitted request from remote version existence", async () => {
    const f = await fixture();
    const mutate = f.remote.mutate.bind(f.remote);
    vi.spyOn(f.remote, "mutate").mockImplementationOnce(async (request) => {
      await mutate(request);
      return {
        kind: "error",
        code: "mutation_not_admitted",
        operationId: request.operationId,
      };
    });
    expect(await f.client().syncNow()).toBe("pending");
    f.edit("changed before pre-journal retry");
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toBeNull();
    expect(f.requests).toHaveLength(1);
  });
  it("refuses an internally consistent remote body that reuses the ACK revision with a different hash", async () => {
    const f = await fixture();
    await f.client().syncNow();
    const base = f.ledger().entries[0]?.base;
    if (!base) throw new Error("Missing base");
    const prior = f.versions.get(base.revision);
    if (!prior) throw new Error("Missing version");
    const content = "mutated immutable generation";
    const version = {
      ...prior,
      content,
      contentSha256: await hash(content),
      byteSize: content.length,
    };
    f.versions.set(base.revision, version);
    f.setHead(version);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.ledger().entries[0]?.base).toEqual(base);
    expect(f.local()).toBe("local");
  });
  it("retains a conflict receipt without retrying a missing remote immutable target", async () => {
    const f = await fixture();
    await f.client().syncNow();
    f.edit("local conflict");
    const target = await f.publish("remote conflict");
    expect(await f.client().syncNow()).toBe("attention");
    f.versions.delete(target.revision);
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.copies.get(target.revision)).toBe("remote conflict");
    expect(f.local()).toBe("local conflict");
  });
  it("rejects an invalid digest provider result before admitting a new request", async () => {
    const f = await fixture();
    vi.spyOn(crypto.subtle, "digest").mockResolvedValueOnce(new ArrayBuffer(0));
    expect(await f.client().syncNow()).toBe("attention");
    expect(f.requests).toHaveLength(0);
  });
  it("serializes overlapping passes rather than duplicating a fresh operation", async () => {
    const f = await fixture();
    const client = f.client();
    expect(await Promise.all([client.syncNow(), client.syncNow()])).toEqual([
      "settled",
      "settled",
    ]);
    expect(f.requests).toHaveLength(1);
  });
});
