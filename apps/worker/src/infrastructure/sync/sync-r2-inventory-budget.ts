import { MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION } from "@protocol/sync.constants";
import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";

/** Fail-closed signal when a caller attempts an unreserved R2 operation. */
export class SyncInventoryBudgetExhaustedError extends Error {
  /** Distinguishes budget exhaustion from storage failure without exposing internal R2 state. */
  constructor() {
    super("Inventory invocation R2 capacity was not reserved.");
    this.name = "SyncInventoryBudgetExhaustedError";
  }
}

/** Per-Worker-request reservation and physically counted R2 binding capability. */
export interface SyncInventoryInvocationBudget {
  /** Number of actual GET, LIST and PUT calls dispatched in this invocation. */
  readonly actualCalls: number;
  /** Reserves complete-step R2 and conservative CPU allowance before a data-read attempt.
   * @param requiredCalls Worst-case physical calls for the proposed step, including write read-backs.
   * @param requiredCpuAllowance Conservative remaining CPU milliseconds needed to finish the step.
   * @returns False without spending an attempt if either available allowance is insufficient.
   */
  reserve(requiredCalls: number, requiredCpuAllowance: number): boolean;
  /** Gates every physical R2 call on a previously reserved credit.
   * @param bucket Private R2 binding to account for before delegation.
   * @returns A counted binding; unreserved operations throw without dispatch.
   */
  wrap(bucket: R2ConditionalBucketPort): R2ConditionalBucketPort;
  /** Counts one cleanup-only DELETE through the same reservation as every other R2 call.
   * @param remove Scoped deletion implementation injected solely into expired scratch cleanup.
   * @returns Counted deletion that refuses unreserved dispatch.
   */
  wrapDelete(
    remove: (key: string) => Promise<void>,
  ): (key: string) => Promise<void>;
}

/** Creates a fresh non-global inventory budget shared by its wrapped binding's facades.
 * @param remainingCpuAllowance Conservative invocation CPU estimate, in milliseconds; this is not live Free qualification.
 * @returns An invocation-scoped preflight and physically counted R2 capability.
 */
export function createSyncInventoryInvocationBudget(
  remainingCpuAllowance: () => number,
): SyncInventoryInvocationBudget {
  let actualCalls = 0;
  let credits = 0;
  let reservedCpuAllowance = 0;

  /** Consumes one reserved credit before dispatch, even if the R2 promise rejects.
   * @throws SyncInventoryBudgetExhaustedError when no call was reserved.
   */
  function consume(): void {
    if (
      credits <= 0 ||
      actualCalls >= MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION
    ) {
      throw new SyncInventoryBudgetExhaustedError();
    }
    credits -= 1;
    actualCalls += 1;
  }

  return {
    get actualCalls() {
      return actualCalls;
    },
    reserve(requiredCalls, requiredCpuAllowance) {
      const remainingCpu = remainingCpuAllowance();
      if (
        !Number.isFinite(remainingCpu) ||
        remainingCpu < 0 ||
        !Number.isSafeInteger(requiredCalls) ||
        requiredCalls < 1 ||
        !Number.isFinite(requiredCpuAllowance) ||
        requiredCpuAllowance < 0 ||
        actualCalls + credits + requiredCalls >
          MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION ||
        reservedCpuAllowance + requiredCpuAllowance > remainingCpu
      ) {
        return false;
      }
      credits += requiredCalls;
      reservedCpuAllowance += requiredCpuAllowance;
      return true;
    },
    wrapDelete(remove) {
      return (key) => {
        consume();
        return remove(key);
      };
    },
    wrap(bucket) {
      return {
        get(key) {
          consume();
          return bucket.get(key);
        },
        list(options) {
          consume();
          return bucket.list(options);
        },
        put(key, content, options) {
          consume();
          return bucket.put(key, content, options);
        },
      };
    },
  };
}
