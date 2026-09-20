import type { MirrorStateSnapshot } from "@core/mirror/mirror-state.types";

/** Startup-only outcome for migrated v3 local-effect postcondition recovery. */
export type ReconciliationV3LocalEffectRecoveryResult =
  | {
      readonly kind: "completed";
      readonly recoveredOperations: number;
      readonly snapshot: MirrorStateSnapshot;
    }
  | {
      readonly kind: "unavailable";
      readonly snapshot: MirrorStateSnapshot;
    };
