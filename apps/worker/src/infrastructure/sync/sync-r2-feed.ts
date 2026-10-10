import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncChangeEvent,
  SyncReadChangesResult,
  SyncStoreFailure,
} from "@core/sync/sync-store.types";
import { decodeSyncCursor, encodeSyncCursor } from "@protocol/sync.codec";
import {
  SYNC_ERROR_CODE,
  SYNC_FEED_LANE_COUNT,
  SYNC_SEQUENCE_WIDTH,
} from "@protocol/sync.constants";
import {
  syncEventSequenceSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncSequenceDto } from "@protocol/sync.types";
import type { SyncFeedEventRecord } from "@worker/infrastructure/sync/sync-publication.types";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import type { SyncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";

/** Longest permitted age of the first unread committed change in any lane. */
const SYNC_CURSOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Maximum metadata events emitted in one bounded feed page. */
const SYNC_FEED_PAGE_LIMIT = 100;
/** Keeps independent lane-head reads below Workers' six simultaneous outgoing connections. */
const SYNC_FEED_HEAD_READ_CONCURRENCY = 4;
/** Canonical initial clock used only for a verified absent lane head. */
const INITIAL_SEQUENCE = syncSequenceSchema.parse(
  "0".repeat(SYNC_SEQUENCE_WIDTH),
);

/** Produces the exact successor of a nonterminal fixed-width decimal position.
 * @param position Committed sequence below the captured high-water mark.
 * @returns The next non-zero protocol sequence without numeric rounding.
 */
function successor(position: SyncSequenceDto) {
  return syncEventSequenceSchema.parse(
    (BigInt(position) + 1n).toString().padStart(SYNC_SEQUENCE_WIDTH, "0"),
  );
}

/** Projects a strictly decoded private publication into content-free core metadata.
 * @param record Validated immutable event read from the feed.
 * @returns The public event without private schema and vault envelope fields.
 */
function publicEvent(record: SyncFeedEventRecord): SyncChangeEvent {
  if (record.kind === "changed") {
    return {
      kind: record.kind,
      lane: record.lane,
      sequence: record.sequence,
      path: record.path,
      result: record.result,
      operationId: record.operationId,
      origin: record.origin,
      committedAtEpochMs: record.committedAtEpochMs,
    };
  }
  return {
    kind: record.kind,
    lane: record.lane,
    sequence: record.sequence,
    operationId: record.operationId,
    reason: record.reason,
    committedAtEpochMs: record.committedAtEpochMs,
  };
}

/** Reads only committed, metadata-only events at a captured per-lane high-water mark.
 * @param publication Marker-gated strict private record reader.
 * @param clock Server clock for first-unconsumed-event expiry.
 * @returns A vault-scoped fair incremental feed capability.
 */
export function syncR2Feed(
  publication: SyncR2Publication,
  clock: SyncServerClock,
): Pick<SyncStore, "readChanges"> {
  return {
    async readChanges({ vaultId, cursor }): Promise<SyncReadChangesResult> {
      if (!syncVaultIdSchema.safeParse(vaultId).success) {
        return { kind: "error", code: SYNC_ERROR_CODE.invalidInput };
      }
      const checkpoint = decodeSyncCursor(cursor, vaultId);
      if (!checkpoint) {
        return { kind: "error", code: SYNC_ERROR_CODE.invalidCursor };
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) {
        return { kind: "error", code: SYNC_ERROR_CODE.storageUnavailable };
      }

      // A verified missing lane head is an unused zero clock, not a missing event.
      const highWaters: SyncSequenceDto[] = [];
      for (
        let firstLane = 0;
        firstLane < SYNC_FEED_LANE_COUNT;
        firstLane += SYNC_FEED_HEAD_READ_CONCURRENCY
      ) {
        const batchSize = Math.min(
          SYNC_FEED_HEAD_READ_CONCURRENCY,
          SYNC_FEED_LANE_COUNT - firstLane,
        );
        const reads = await Promise.all(
          Array.from({ length: batchSize }, (_, offset) =>
            publication.readLaneHead(vaultId, firstLane + offset),
          ),
        );
        for (const read of reads) {
          if (read.kind === "unavailable") {
            return { kind: "error", code: SYNC_ERROR_CODE.storageUnavailable };
          }
          highWaters.push(
            read.kind === "absent"
              ? INITIAL_SEQUENCE
              : read.observation.value.committedSequence,
          );
        }
      }
      if (
        highWaters.some((high, lane) => {
          const position = checkpoint.laneSequences[lane];
          return position === undefined || position > high;
        })
      ) {
        return { kind: "error", code: SYNC_ERROR_CODE.invalidCursor };
      }

      const positions = [...checkpoint.laneSequences];
      const nextEvents: (SyncFeedEventRecord | undefined)[] = Array.from({
        length: SYNC_FEED_LANE_COUNT,
      });
      const unavailable: SyncStoreFailure = {
        kind: "error",
        code: SYNC_ERROR_CODE.storageUnavailable,
      };
      /** Reads exactly one expected event, retaining no bytes or storage generation in the result.
       * @param lane Captured lane with an unconsumed committed position.
       * @returns Its next exact event, or an unavailable-evidence failure.
       */
      const readNext = async (
        lane: number,
      ): Promise<SyncFeedEventRecord | SyncStoreFailure> => {
        const position = positions[lane];
        if (position === undefined) return unavailable;
        const expected = successor(position);
        const read = await publication.readEvent(vaultId, lane, expected);
        if (read.kind !== "observed") return unavailable;
        const record = read.observation.value;
        if (
          record.vaultId !== vaultId ||
          record.lane !== lane ||
          record.sequence !== expected
        )
          return unavailable;
        return record;
      };

      // Expiry is checked across every lane before even a full first page can succeed.
      for (let lane = 0; lane < SYNC_FEED_LANE_COUNT; lane += 1) {
        const position = positions[lane];
        const highWater = highWaters[lane];
        if (position === undefined || highWater === undefined)
          return unavailable;
        if (position >= highWater) continue;
        const record = await readNext(lane);
        if (record.kind === "error") return record;
        if (record.committedAtEpochMs < now - SYNC_CURSOR_RETENTION_MS) {
          return { kind: "error", code: SYNC_ERROR_CODE.cursorExpired };
        }
        nextEvents[lane] = record;
      }

      const events: SyncChangeEvent[] = [];
      let nextLane = checkpoint.nextLane;
      for (
        let round = 0;
        round < SYNC_FEED_PAGE_LIMIT && events.length < SYNC_FEED_PAGE_LIMIT;
        round += 1
      ) {
        let emitted = false;
        const roundStart = nextLane;
        for (
          let offset = 0;
          offset < SYNC_FEED_LANE_COUNT && events.length < SYNC_FEED_PAGE_LIMIT;
          offset += 1
        ) {
          const lane = (roundStart + offset) % SYNC_FEED_LANE_COUNT;
          const position = positions[lane];
          const highWater = highWaters[lane];
          if (position === undefined || highWater === undefined)
            return unavailable;
          if (position >= highWater) continue;
          const record = nextEvents[lane] ?? (await readNext(lane));
          if (record.kind === "error") return record;
          nextEvents[lane] = undefined;
          events.push(publicEvent(record));
          positions[lane] = record.sequence;
          emitted = true;
          nextLane = (lane + 1) % SYNC_FEED_LANE_COUNT;
        }
        if (!emitted) break;
      }
      return {
        kind: "page",
        events,
        nextCursor: encodeSyncCursor({
          protocolMajor: checkpoint.protocolMajor,
          vaultId,
          laneSequences: positions,
          nextLane: events.length === 0 ? checkpoint.nextLane : nextLane,
        }),
      };
    },
  };
}
