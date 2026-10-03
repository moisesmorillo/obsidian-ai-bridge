import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import type {
  SyncR2WriteResult,
  SyncRecordObservation,
} from "@worker/infrastructure/sync/sync-r2.types";
import type { SyncR2InventoryScratch } from "@worker/infrastructure/sync/sync-r2-inventory";
import type { SyncServerClock } from "@worker/infrastructure/sync/sync-r2-mutation.types";
import { syncInventoryCursorJournalSchema } from "@worker/infrastructure/sync/sync-record.schemas";
import type {
  SyncInventoryChunk,
  SyncInventoryCursorJournal,
  SyncInventoryCursorWitness,
  SyncInventoryManifest,
} from "@worker/infrastructure/sync/sync-record.types";

/** Private result of checking one exact truncated-output cursor before manifest CAS. */
export type SyncInventoryCursorCheck =
  | { readonly kind: "proved" | "incomplete" }
  | { readonly kind: "effect_unknown"; readonly retryAfterEpochMs?: number }
  | { readonly kind: "progress"; readonly retryAfterEpochMs?: number };

/** Retains a known write cooldown without interpreting an unconfirmed effect as progress.
 * @param result Definitive refusal or unresolved conditional write from a claim or target.
 * @returns Typed uncertainty carrying only a known safe retry floor when supplied.
 */
function unresolvedWrite(result: SyncR2WriteResult): SyncInventoryCursorCheck {
  return result.kind === "effect_unknown" &&
    result.retryAfterEpochMs !== undefined
    ? { kind: "effect_unknown", retryAfterEpochMs: result.retryAfterEpochMs }
    : { kind: "effect_unknown" };
}

/** Confirms the originally reserved manifest and own active slot remain authoritative now.
 * @param manifest Exact generation that admitted the already verified chunk.
 * @param scratch Strict scan-scoped observation boundary.
 * @param clock Server time fencing the 24-hour lifetime.
 * @returns False on expiry, unavailable storage, changed generation or lost slot.
 */
async function ownsCurrentScan(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
): Promise<boolean> {
  const { vaultId, inventoryId, expiresAtEpochMs } = manifest.value;
  if (clock() >= expiresAtEpochMs) return false;
  const current = await scratch.readManifest(vaultId, inventoryId);
  if (current.kind !== "observed") return false;
  const original = manifest.observed;
  const observed = current.observation.observed;
  if (
    observed.key !== original.key ||
    observed.etag !== original.etag ||
    observed.uploaded.getTime() !== original.uploaded.getTime() ||
    observed.bytes.byteLength !== original.bytes.byteLength ||
    !observed.bytes.every((byte, index) => byte === original.bytes[index]) ||
    current.observation.value.schemaVersion !== 2
  ) {
    return false;
  }
  const active = await scratch.readActive(vaultId);
  return (
    active.kind === "observed" &&
    active.observation.value.state === "active" &&
    active.observation.value.inventoryId === inventoryId &&
    clock() < expiresAtEpochMs
  );
}

/** Requires the current journal generation still be the exact UUID this invocation claimed.
 * @param scratch Strict claim reader.
 * @param manifest Reserved scan whose step owns the claim.
 * @param owned Previously confirmed own claim generation.
 * @returns Whether no later isolate replaced this generation before target dispatch.
 */
async function ownsCurrentClaim(
  scratch: SyncR2InventoryScratch,
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  owned: SyncRecordObservation<SyncInventoryCursorJournal>,
): Promise<boolean> {
  const latest = await scratch.readCursorJournal(
    manifest.value.vaultId,
    manifest.value.inventoryId,
    manifest.value.nextStep,
  );
  if (latest.kind !== "observed") return false;
  const before = owned.observed;
  const now = latest.observation.observed;
  return (
    latest.observation.value.state === "attempting" &&
    latest.observation.value.claimId === owned.value.claimId &&
    now.key === before.key &&
    now.etag === before.etag &&
    now.uploaded.getTime() === before.uploaded.getTime() &&
    now.bytes.byteLength === before.bytes.byteLength &&
    now.bytes.every((byte, index) => byte === before.bytes[index])
  );
}

/** Claims one absent journal generation before the isolate's sole create-only target PUT.
 * @param manifest Original generation that reserved this step and cursor.
 * @param scratch Exact per-scan journal, slot and witness capability.
 * @param clock Server clock for expiry and conditional-write admission.
 * @param witness Canonical immutable target bound to the verified chunk.
 * @returns Progress after a confirmed target or typed uncertainty without manifest advance.
 */
async function claimAndWriteWitness(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
  witness: SyncInventoryCursorWitness,
): Promise<SyncInventoryCursorCheck> {
  if (!(await ownsCurrentScan(manifest, scratch, clock))) {
    return { kind: "effect_unknown" };
  }
  const claim = syncInventoryCursorJournalSchema.parse({
    ...witness,
    state: "attempting",
    claimId: crypto.randomUUID(),
  });
  const created = await scratch.createCursorJournal(claim);
  if (created.kind === "throttled") {
    return { kind: "progress", retryAfterEpochMs: created.retryAfterEpochMs };
  }
  if (created.kind !== "confirmed") return unresolvedWrite(created);
  return dispatchClaimedWitness(
    manifest,
    scratch,
    clock,
    witness,
    claim.claimId,
  );
}

/** Allows one target PUT only from this invocation's exact newly confirmed UUID generation.
 * @param manifest Original scan generation still required for eventual manifest CAS.
 * @param scratch Strict claim, slot and target-witness capability.
 * @param clock Server time fencing late orphan writes.
 * @param witness Canonical target record tied to the verified chunk.
 * @param claimId UUID this invocation itself confirmed through a create or exact CAS.
 * @returns Deferred proof or uncertainty; never treats an unobserved target as success.
 */
async function dispatchClaimedWitness(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
  witness: SyncInventoryCursorWitness,
  claimId: SyncInventoryCursorJournal["claimId"],
): Promise<SyncInventoryCursorCheck> {
  const ownRead = await scratch.readCursorJournal(
    witness.vaultId,
    witness.inventoryId,
    witness.step,
  );
  if (
    ownRead.kind !== "observed" ||
    ownRead.observation.value.state !== "attempting" ||
    ownRead.observation.value.claimId !== claimId ||
    ownRead.observation.value.chunkHash !== witness.chunkHash ||
    ownRead.observation.value.cursorDigest !== witness.cursorDigest
  ) {
    return { kind: "effect_unknown" };
  }
  if (
    !(await ownsCurrentScan(manifest, scratch, clock)) ||
    !(await ownsCurrentClaim(scratch, manifest, ownRead.observation))
  ) {
    return { kind: "effect_unknown" };
  }
  const written = await scratch.createCursorWitness(witness);
  if (written.kind === "throttled") {
    return { kind: "progress", retryAfterEpochMs: written.retryAfterEpochMs };
  }
  if (written.kind === "confirmed") return { kind: "progress" };
  return unresolvedWrite(written);
}

/** Reconciles a target that may have appeared since the first absent-witness read.
 * @param manifest Original reserved scan that must still own the active slot.
 * @param scratch Strict digest-keyed witness reader.
 * @param clock Server clock fencing adoption after scan expiry.
 * @param target Immutable expected record for this exact producing chunk.
 * @returns Definite absence, matching proof, divergence or unavailable authority.
 */
async function recheckWitnessAbsence(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
  target: SyncInventoryCursorWitness,
): Promise<{ readonly kind: "absent" } | SyncInventoryCursorCheck> {
  const latest = await scratch.readCursorWitness(
    target.vaultId,
    target.inventoryId,
    target.cursorDigest,
  );
  if (latest.kind === "absent") return { kind: "absent" };
  if (latest.kind === "invalid") return { kind: "incomplete" };
  if (latest.kind === "unavailable") return { kind: "effect_unknown" };
  if (
    latest.observation.value.step !== target.step ||
    latest.observation.value.chunkHash !== target.chunkHash ||
    latest.observation.value.cursorDigest !== target.cursorDigest
  ) {
    return { kind: "incomplete" };
  }
  return (await ownsCurrentScan(manifest, scratch, clock))
    ? { kind: "proved" }
    : { kind: "effect_unknown" };
}

/** Advances a cooled journal through retry_wait before any fresh-UUID target attempt.
 * @param manifest Original scan generation against which retry must still be authorized.
 * @param scratch Strict conditional journal and target-witness boundary.
 * @param clock Server time for separate same-key floors.
 * @param witness Canonical missing target whose chunk binding must remain unchanged.
 * @param observed Exact existing journal generation read after witness absence.
 * @returns Deferral, a newly claimed attempt's result, or uncertainty without PUT.
 */
async function recoverMissingWitness(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
  witness: SyncInventoryCursorWitness,
  observed: SyncRecordObservation<SyncInventoryCursorJournal>,
): Promise<SyncInventoryCursorCheck> {
  const now = clock();
  const uploadedAt = observed.observed.uploaded.getTime();
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(uploadedAt)) {
    return { kind: "effect_unknown" };
  }
  const sameKeyFloor = uploadedAt + SYNC_R2_WRITE_COOLDOWN_MS;
  if (observed.value.state === "attempting") {
    if (now < sameKeyFloor) {
      return { kind: "progress", retryAfterEpochMs: sameKeyFloor };
    }
    if (!(await ownsCurrentScan(manifest, scratch, clock))) {
      return { kind: "effect_unknown" };
    }
    const latestWitness = await recheckWitnessAbsence(
      manifest,
      scratch,
      clock,
      witness,
    );
    if (latestWitness.kind !== "absent") return latestWitness;
    if (clock() >= manifest.value.expiresAtEpochMs)
      return { kind: "effect_unknown" };
    const retryAfterEpochMs = Math.max(
      now + SYNC_R2_WRITE_COOLDOWN_MS,
      sameKeyFloor,
    );
    if (!Number.isSafeInteger(retryAfterEpochMs))
      return { kind: "effect_unknown" };
    const waiting = syncInventoryCursorJournalSchema.parse({
      ...observed.value,
      state: "retry_wait",
      retryAfterEpochMs,
    });
    const replaced = await scratch.replaceCursorJournal(observed, waiting);
    if (replaced.kind === "throttled") {
      return {
        kind: "progress",
        retryAfterEpochMs: replaced.retryAfterEpochMs,
      };
    }
    return replaced.kind === "confirmed"
      ? { kind: "progress", retryAfterEpochMs }
      : unresolvedWrite(replaced);
  }
  const floor = Math.max(sameKeyFloor, observed.value.retryAfterEpochMs);
  if (now < floor) return { kind: "progress", retryAfterEpochMs: floor };
  if (!(await ownsCurrentScan(manifest, scratch, clock))) {
    return { kind: "effect_unknown" };
  }
  const latestWitness = await recheckWitnessAbsence(
    manifest,
    scratch,
    clock,
    witness,
  );
  if (latestWitness.kind !== "absent") return latestWitness;
  if (clock() >= manifest.value.expiresAtEpochMs)
    return { kind: "effect_unknown" };
  const claim = syncInventoryCursorJournalSchema.parse({
    ...witness,
    state: "attempting",
    claimId: crypto.randomUUID(),
  });
  const replaced = await scratch.replaceCursorJournal(observed, claim);
  if (replaced.kind === "throttled") {
    return { kind: "progress", retryAfterEpochMs: replaced.retryAfterEpochMs };
  }
  if (replaced.kind !== "confirmed") return unresolvedWrite(replaced);
  return dispatchClaimedWitness(
    manifest,
    scratch,
    clock,
    witness,
    claim.claimId,
  );
}

/** Fences every v2 truncated cursor against all prior outputs before original-manifest CAS.
 * @param manifest Exact reserved scan generation, already verified as schema v2 by the caller.
 * @param chunk Exact verified chunk whose output cursor is proposed for advancement.
 * @param next Candidate successor whose root is the hash of the chunk's strict bytes.
 * @param scratch Scoped conditional journal and immutable witness capability.
 * @param clock Server clock for claims and expiry checks.
 * @returns Proof, divergent evidence or same-ID deferral/uncertainty; never manifest success.
 */
export async function checkSyncInventoryCursor(
  manifest: SyncRecordObservation<SyncInventoryManifest>,
  chunk: SyncRecordObservation<SyncInventoryChunk>,
  next: SyncInventoryManifest,
  scratch: SyncR2InventoryScratch,
  clock: SyncServerClock,
): Promise<SyncInventoryCursorCheck> {
  if (!chunk.value.truncated) {
    return (await ownsCurrentScan(manifest, scratch, clock))
      ? { kind: "proved" }
      : { kind: "effect_unknown" };
  }
  const { vaultId, inventoryId, nextStep } = manifest.value;
  const hash = next.chunkHash;
  if (hash === null) return { kind: "incomplete" };
  const digest = chunk.value.outputCursorDigest;
  const witness = await scratch.readCursorWitness(vaultId, inventoryId, digest);
  if (witness.kind === "invalid") return { kind: "incomplete" };
  if (witness.kind === "unavailable") return { kind: "effect_unknown" };
  if (
    witness.kind === "observed" &&
    (witness.observation.value.step !== nextStep ||
      witness.observation.value.chunkHash !== hash ||
      witness.observation.value.cursorDigest !== digest)
  ) {
    return { kind: "incomplete" };
  }
  const journal = await scratch.readCursorJournal(
    vaultId,
    inventoryId,
    nextStep,
  );
  if (journal.kind === "invalid") return { kind: "incomplete" };
  if (journal.kind === "unavailable") return { kind: "effect_unknown" };
  if (witness.kind === "observed") {
    if (journal.kind !== "observed") return { kind: "incomplete" };
    if (
      journal.observation.value.chunkHash !== hash ||
      journal.observation.value.cursorDigest !== digest
    ) {
      return { kind: "incomplete" };
    }
    return (await ownsCurrentScan(manifest, scratch, clock))
      ? { kind: "proved" }
      : { kind: "effect_unknown" };
  }
  const target: SyncInventoryCursorWitness = {
    schemaVersion: 1,
    protocolMajor: 1,
    vaultId,
    inventoryId,
    step: nextStep,
    chunkHash: hash,
    cursorDigest: digest,
  };
  if (journal.kind === "observed") {
    if (
      journal.observation.value.chunkHash !== hash ||
      journal.observation.value.cursorDigest !== digest
    ) {
      return { kind: "incomplete" };
    }
    return recoverMissingWitness(
      manifest,
      scratch,
      clock,
      target,
      journal.observation,
    );
  }
  return claimAndWriteWitness(manifest, scratch, clock, target);
}
