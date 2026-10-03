import {
  encodeSyncCursor,
  syncFeedEventKey,
  syncFeedLaneHeadKey,
} from "@protocol/sync.codec";
import { SYNC_FEED_LANE_COUNT } from "@protocol/sync.constants";
import {
  syncDeviceIdSchema,
  syncEventSequenceSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type {
  SyncFeedEventRecord,
  SyncLaneHeadRecord,
} from "@worker/infrastructure/sync/sync-publication.types";
import type {
  SyncR2ObjectStore,
  SyncRecordRead,
} from "@worker/infrastructure/sync/sync-r2.types";
import { syncR2Feed } from "@worker/infrastructure/sync/sync-r2-feed";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { describe, expect, it } from "vitest";

const vaultId = syncVaultIdSchema.parse("11111111-1111-4111-8111-111111111111");
const otherVaultId = syncVaultIdSchema.parse(
  "22222222-2222-4222-8222-222222222222",
);
const operationId = syncOperationIdSchema.parse(
  "33333333-3333-4333-8333-333333333333",
);
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const origin = syncDeviceIdSchema.parse("55555555-5555-4555-8555-555555555555");
const path = syncNotePathSchema.parse("feed/item.md");
const NOW = 2_000_000_000_000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/** Formats an exact protocol sequence, including positions beyond JS safe integers.
 * @param value Exact non-negative bigint position.
 * @returns Canonical fixed-width protocol position.
 */
function sequence(value: bigint) {
  return syncSequenceSchema.parse(value.toString().padStart(20, "0"));
}

/** Builds a vault-scoped cursor whose round-robin pointer is independently varied.
 * @param lanes Explicit checkpoint entries; omitted lanes start at zero.
 * @param nextLane Next feed lane to visit.
 * @param forVault Cursor's protocol vault identity.
 * @returns Canonical opaque cursor string.
 */
function cursor(lanes: readonly bigint[], nextLane = 0, forVault = vaultId) {
  return encodeSyncCursor({
    protocolMajor: 1,
    vaultId: forVault,
    laneSequences: Array.from({ length: SYNC_FEED_LANE_COUNT }, (_, lane) =>
      sequence(lanes[lane] ?? 0n),
    ),
    nextLane,
  });
}

/** Supplies a deterministic publication facade without touching R2.
 * @param heads Captured committed head positions by lane.
 * @param events Immutable events keyed by lane and sequence.
 * @param failures Optional unavailable head or event read.
 * @returns Feed reader and exact head/event read-call traces.
 */
function feedFixture(
  heads: ReadonlyMap<number, bigint>,
  events: ReadonlyMap<string, SyncFeedEventRecord>,
  failures: { readonly head?: number; readonly event?: string } = {},
) {
  const calls: { heads: number[]; events: string[] } = {
    heads: [],
    events: [],
  };
  const unused: SyncR2ObjectStore = {
    async read() {
      throw new Error("Unexpected R2 read");
    },
    async create() {
      throw new Error("Unexpected R2 create");
    },
    async replace() {
      throw new Error("Unexpected R2 replace");
    },
  };
  const base = syncR2Publication(unused);
  const key = (value: string) => {
    const validated = createSyncR2Key(value, vaultId);
    if (!validated) throw new Error("Invalid test key");
    return validated;
  };
  const publication = {
    ...base,
    async readLaneHead(
      _vault: typeof vaultId,
      lane: number,
    ): Promise<SyncRecordRead<SyncLaneHeadRecord>> {
      calls.heads.push(lane);
      if (lane === failures.head) return { kind: "unavailable" };
      const highWater = heads.get(lane);
      if (highWater === undefined) return { kind: "absent" };
      return {
        kind: "observed",
        observation: {
          value: {
            kind: "laneHead",
            schemaVersion: 1,
            protocolMajor: 1,
            vaultId,
            lane,
            committedSequence: sequence(highWater),
            committedAtEpochMs: NOW,
          },
          observed: {
            key: key(syncFeedLaneHeadKey(vaultId, lane)),
            etag: "etag",
            bytes: new Uint8Array(),
            uploaded: new Date(NOW),
          },
        },
      };
    },
    async readEvent(
      _vault: typeof vaultId,
      lane: number,
      position: string,
    ): Promise<SyncRecordRead<SyncFeedEventRecord>> {
      const eventKey = `${lane}/${position}`;
      calls.events.push(eventKey);
      if (eventKey === failures.event) return { kind: "unavailable" };
      const event = events.get(eventKey);
      if (!event) return { kind: "absent" };
      return {
        kind: "observed",
        observation: {
          value: event,
          observed: {
            key: key(
              syncFeedEventKey(
                vaultId,
                lane,
                syncEventSequenceSchema.parse(position),
              ),
            ),
            etag: "etag",
            bytes: new Uint8Array(),
            uploaded: new Date(NOW),
          },
        },
      };
    },
  };
  return { reader: syncR2Feed(publication, () => NOW), calls, publication };
}

/** Makes one immutable changed event with only metadata and server commit time.
 * @param lane Feed partition holding the event.
 * @param position Exact non-zero sequence.
 * @param committedAtEpochMs Durable server commit time.
 * @returns Private event fixture for the strict reader.
 */
function event(
  lane: number,
  position: bigint,
  committedAtEpochMs = NOW,
): SyncFeedEventRecord {
  return {
    kind: "changed",
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    lane,
    sequence: syncEventSequenceSchema.parse(sequence(position)),
    path,
    result: { kind: "live", revision },
    operationId,
    origin,
    committedAtEpochMs,
  };
}

/** Places events at canonical lane/sequence fixture identities.
 * @returns An immutable event lookup for the fake publication facade.
 */
function eventMap(...records: SyncFeedEventRecord[]) {
  return new Map(
    records.map((record) => [`${record.lane}/${record.sequence}`, record]),
  );
}

describe("syncR2Feed", () => {
  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe retention clock %s before reading any lane",
    async (now) => {
      const state = feedFixture(new Map(), new Map());
      expect(
        await syncR2Feed(state.publication, () => now).readChanges({
          vaultId,
          cursor: cursor([]),
        }),
      ).toEqual({ kind: "error", code: "storage_unavailable" });
      expect(state.calls.heads).toHaveLength(0);
      expect(state.calls.events).toHaveLength(0);
    },
  );

  it("does not expose a partial page or advance the checkpoint when a later committed event is missing", async () => {
    const state = feedFixture(new Map([[0, 2n]]), eventMap(event(0, 1n)));
    expect(
      await state.reader.readChanges({ vaultId, cursor: cursor([]) }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(state.calls.events).toEqual([
      `0/${sequence(1n)}`,
      `0/${sequence(2n)}`,
    ]);
  });

  it("rejects an unvalidated vault identity before any publication access", async () => {
    const state = feedFixture(new Map(), new Map());
    expect(
      await state.reader.readChanges({
        // @ts-expect-error A caller cannot bypass the public feed's vault validation.
        vaultId: "invalid-vault",
        cursor: cursor([]),
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(state.calls.heads).toHaveLength(0);
    expect(state.calls.events).toHaveLength(0);
  });

  it.each(["vault", "lane", "sequence"] as const)(
    "withholds a page when the publication facade misroutes an event's %s authority",
    async (field) => {
      const record = event(0, 1n);
      const misrouted = {
        ...record,
        vaultId: field === "vault" ? otherVaultId : vaultId,
        lane: field === "lane" ? 1 : 0,
        sequence:
          field === "sequence"
            ? syncEventSequenceSchema.parse(sequence(2n))
            : record.sequence,
      };
      const state = feedFixture(
        new Map([[0, 1n]]),
        new Map([[`0/${sequence(1n)}`, misrouted]]),
      );
      expect(
        await state.reader.readChanges({ vaultId, cursor: cursor([]) }),
      ).toEqual({ kind: "error", code: "storage_unavailable" });
      expect(state.calls.events).toEqual([`0/${sequence(1n)}`]);
    },
  );
  it("captures all 64 lane heads and preserves the pointer on an empty virgin feed", async () => {
    const { reader, calls } = feedFixture(new Map(), new Map());
    expect(
      await reader.readChanges({ vaultId, cursor: cursor([], 37) }),
    ).toEqual({ kind: "page", events: [], nextCursor: cursor([], 37) });
    expect(calls.heads).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    );
    expect(calls.events).toEqual([]);
  });

  it("refuses malformed, foreign, future and unavailable head evidence", async () => {
    const { reader } = feedFixture(new Map(), new Map());
    expect(await reader.readChanges({ vaultId, cursor: "!" })).toEqual({
      kind: "error",
      code: "invalid_cursor",
    });
    expect(
      await reader.readChanges({
        vaultId,
        cursor: cursor([], 0, otherVaultId),
      }),
    ).toEqual({ kind: "error", code: "invalid_cursor" });
    expect(await reader.readChanges({ vaultId, cursor: cursor([1n]) })).toEqual(
      { kind: "error", code: "invalid_cursor" },
    );
    const unavailable = feedFixture(new Map(), new Map(), { head: 63 });
    expect(
      await unavailable.reader.readChanges({ vaultId, cursor: cursor([]) }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });

  it("expires on any lane's first unconsumed old event, not a cursor at high water", async () => {
    const old = event(63, 1n, NOW - THIRTY_DAYS - 1);
    const { reader } = feedFixture(new Map([[63, 1n]]), eventMap(old));
    expect(await reader.readChanges({ vaultId, cursor: cursor([]) })).toEqual({
      kind: "error",
      code: "cursor_expired",
    });
    expect(
      await reader.readChanges({
        vaultId,
        cursor: cursor(
          Array.from({ length: 64 }, (_, i) => (i === 63 ? 1n : 0n)),
        ),
      }),
    ).toEqual({
      kind: "page",
      events: [],
      nextCursor: cursor(
        Array.from({ length: 64 }, (_, i) => (i === 63 ? 1n : 0n)),
      ),
    });
  });

  it("fails closed on missing and unavailable committed events", async () => {
    const { reader } = feedFixture(new Map([[0, 1n]]), new Map());
    expect(await reader.readChanges({ vaultId, cursor: cursor([]) })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    const unavailable = feedFixture(
      new Map([[0, 1n]]),
      eventMap(event(0, 1n)),
      { event: `0/${sequence(1n)}` },
    );
    expect(
      await unavailable.reader.readChanges({ vaultId, cursor: cursor([]) }),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });

  it("rotates fairly, consuming at most one per lane per round and advancing the pointer", async () => {
    const records = [
      event(0, 1n),
      event(0, 2n),
      event(0, 3n),
      event(1, 1n),
      event(63, 1n),
    ];
    const { reader, calls } = feedFixture(
      new Map([
        [0, 3n],
        [1, 1n],
        [63, 1n],
      ]),
      eventMap(...records),
    );
    const result = await reader.readChanges({
      vaultId,
      cursor: cursor([], 63),
    });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    expect(
      result.events.map(
        ({ lane, sequence: position }) => `${lane}/${position}`,
      ),
    ).toEqual([
      `63/${sequence(1n)}`,
      `0/${sequence(1n)}`,
      `1/${sequence(1n)}`,
      `0/${sequence(2n)}`,
      `0/${sequence(3n)}`,
    ]);
    expect(result.nextCursor).toBe(
      cursor([3n, 1n, ...Array<bigint>(61).fill(0n), 1n], 1),
    );
    expect(calls.heads).toHaveLength(64);
    expect(calls.events).toHaveLength(5);
  });

  it("stops at 100 records and never reads beyond the captured high-water mark", async () => {
    const records = Array.from({ length: 101 }, (_, index) =>
      event(3, BigInt(index + 1)),
    );
    const fixture = feedFixture(new Map([[3, 101n]]), eventMap(...records));
    const first = await fixture.reader.readChanges({
      vaultId,
      cursor: cursor([]),
    });
    expect(first.kind).toBe("page");
    if (first.kind !== "page") return;
    expect(first.events).toHaveLength(100);
    expect(first.nextCursor).toBe(cursor([0n, 0n, 0n, 100n], 4));
    expect(fixture.calls.events).toHaveLength(100);
    const { reader, calls } = feedFixture(
      new Map([[3, 1n]]),
      eventMap(...records),
    );
    const single = await reader.readChanges({ vaultId, cursor: cursor([]) });
    expect(single.kind).toBe("page");
    expect(calls.events).toEqual([`3/${sequence(1n)}`]);
  });

  it("advances a 20-digit position above the JavaScript safe integer limit exactly", async () => {
    const huge = 9_007_199_254_740_993n;
    const checkpoint = Array.from({ length: 64 }, (_, i) =>
      i === 9 ? huge : 0n,
    );
    const { reader } = feedFixture(
      new Map([[9, huge + 1n]]),
      eventMap(event(9, huge + 1n)),
    );
    const result = await reader.readChanges({
      vaultId,
      cursor: cursor(checkpoint),
    });
    expect(result).toEqual({
      kind: "page",
      events: [
        {
          kind: "changed",
          lane: 9,
          sequence: sequence(huge + 1n),
          path,
          result: { kind: "live", revision },
          operationId,
          origin,
          committedAtEpochMs: NOW,
        },
      ],
      nextCursor: cursor(
        checkpoint.map((value, i) => (i === 9 ? value + 1n : value)),
        10,
      ),
    });
  });
});
