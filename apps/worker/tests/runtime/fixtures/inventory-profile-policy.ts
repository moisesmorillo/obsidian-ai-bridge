import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";

/** Validates the operator's bounded synthetic head count before any native dispatch.
 * @param value Canonical unsigned decimal population, never exponent notation.
 * @returns Admitted synthetic population; throws RangeError before unsafe seeding.
 */
export function profileHeadCount(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new RangeError("Expected canonical head count.");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > SYNC_RECORD_LIMITS.inventoryHeads)
    throw new RangeError("Head count exceeds inventory ceiling.");
  return count;
}

/** Computes host-side wait without masking an unsafe known response floor.
 * @param now Safe host epoch milliseconds.
 * @param floor Independently known earliest dispatch epoch milliseconds.
 * @returns Nonnegative host wait; unsafe clock/floor throws before aggregation.
 */
export function profileWait(now: number, floor: number): number {
  if (![now, floor].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new RangeError("Invalid profile clock or known retry floor.");
  return Math.max(0, floor - now);
}
