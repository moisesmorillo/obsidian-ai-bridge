import type { R2ConditionalBucketPort } from "@worker/infrastructure/r2.types";
import type {
  SyncR2MutationInvocationCapabilities,
  SyncR2MutationInvocationFactory,
  SyncServerClock,
} from "@worker/infrastructure/sync/sync-r2-mutation.types";
import {
  createSyncR2CallBudget,
  syncR2ObjectStore,
} from "@worker/infrastructure/sync/sync-r2-object";
import { syncR2Publication } from "@worker/infrastructure/sync/sync-r2-publication";
import { syncR2Records } from "@worker/infrastructure/sync/sync-r2-records";

/** Creates a mutation capability factory that gives each invocation one fresh 64-call budget.
 * @param bucket Conditional-only R2 binding shared by independently budgeted invocations.
 * @param clock Unix epoch millisecond clock used by R2 cooldown and publication policy.
 * @returns A factory whose records and publication facades share one new object store per call.
 */
export function createSyncR2MutationInvocationFactory(
  bucket: R2ConditionalBucketPort,
  clock: SyncServerClock,
): SyncR2MutationInvocationFactory {
  return (): SyncR2MutationInvocationCapabilities => {
    const callBudget = createSyncR2CallBudget();
    const objects = syncR2ObjectStore(bucket, clock, callBudget);
    return {
      records: syncR2Records(objects),
      publication: syncR2Publication(objects),
      callBudget,
    };
  };
}
