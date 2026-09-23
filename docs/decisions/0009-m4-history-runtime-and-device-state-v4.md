# ADR 0009 — Bounded history resolution, runtime authority, and device-state v4

## Status

**Accepted and implemented by M4 Slices 6–7.** The compatibility transition adds
strict device state v4 and the complete version-4 runtime-owner surface together. It
changes no Worker API and extends rather than rewrites
[ADR 0008](0008-m4-device-state-migration.md): version 3 remains the frozen historical
format and version 4 is current. [ADR 0012](0012-host-visible-conflict-preservation-namespace.md)
supersedes only this record's generated preservation-root location for new operations;
step identity and frozen historical receipt semantics remain unchanged. [ADR 0013](0013-listener-ready-effect-authority-and-observation-gap-recovery.md) proposes a corrective v5 listener-gap fence; this record continues to describe the implemented v4 behavior, not proof of continuity through uncovered intervals.

## Context

The post-Slice-5 revalidation found that the implemented version-3 operation model can
represent one reviewed action with aggregate local and remote effect certainty, but
cannot safely represent an explicit grouped history choice, multiple completed cleanup
steps, multiple same-side preservation artifacts, or the exact local-effect observation
fence required by runtime composition. The M3 synchronizer also owns its scheduler
privately, while M4 runtime work must share the same two-job bound.

These are representation and composition questions inside the accepted M4 model. They
do not reopen reviewed-only authority, one designated writer, preserve-first ordering,
the prohibition on plugin local rename/delete/move, the existing Worker v2 API, or the
absence of server-side history.

## Decision

### History group and operator decision

`RenameHistoryGroupPolicy` is the sole owner of history-group discovery. Starting from
the selected deferred rename edge, it derives the bounded transitive closure of current
durable `RenameDeferredMirrorState` source and non-null destination edges. It includes
every overlapping edge and samples every resulting path in lexical order. Caller- or
UI-provided related paths are neither required nor accepted as authority. Capacity,
missing evidence, contradictory edges, physical remote absence, foreign association,
legacy source, or unresolved M3 work produces a typed non-authoritative result.

The review projection exposes only bounded validated candidate paths from the current
process-local discovery set. UI submits the review/session identity, one selected
projected path where required, and one closed operator choice. Admission rejects paths
outside that set, rederives the still-current complete group, and persists only the
resulting evidence-bound decision; caller-supplied related paths never become authority. The durable decision shape is:

```text
HistoryAdmissionRequest
  decision: retain-independent | defer-history | execute-cleanup-plan
  selectedCandidatePath: projected NotePath | null

HistoryDecision                              # durable after admission
  retain-independent
  defer-history
  execute-cleanup-plan
    canonicalPath: NotePath | null          # derived and persisted, never free-form

HistoryProgress                              # same atomic parent record
  decision: HistoryDecision
  steps: HistoryCleanupStep[]                # derived once; sole step authority
  nextStepIndex: nonnegative integer | null
```

`retain-independent` is a terminal no-effect decision that clears only the reviewed
deferred-history blockers represented by the exact snapshot. `defer-history` is a
terminal no-effect operation outcome that leaves those blockers intact for later
review. `execute-cleanup-plan` contains one or more exact remote-former-source cleanup
steps derived from current evidence. Selecting a canonical path is permitted only when
that path is already a member of the derived group and the selected plan needs no
plugin local effect. It records the operator's current mapping choice; it does not
reconstruct historical intent.

Choice fields and evidence ownership are fixed:

| Durable field | Source | Authority rule |
| --- | --- | --- |
| Decision kind | Operator choice from the closed action set | No free-form action |
| Candidate path before admission | Operator selects a bounded path supplied by current process-local discovery | Membership is rechecked, group paths are rederived, and the selection grants no authority to add or omit related paths |
| Complete group and reservations | `RenameHistoryGroupPolicy` from durable rename edges | Caller cannot add or omit paths |
| Canonical path | Admission policy resolves the selected candidate to an existing group member | Never accepted as free-form UI input |
| Cleanup source/prerequisite paths and revisions | Exact immutable snapshot plus durable rename evidence | Persisted as derived evidence; never refreshed to latest |
| Step IDs | Locally generated during serialized admission | Globally unique UUID-v4; also the exact v2 mutation/recovery operation ID for that step, with no semantic path data |
| Step order | History policy over derived paths | Deterministic and not operator-reorderable |

`retain-independent` atomically changes only the exact grouped `rename-deferred`
desired states represented by the snapshot to the existing neutral/no-deferred state;
it does not change ACKs, create local content, or mutate remote heads. `defer-history`
leaves every deferred state unchanged. An execute plan clears a source's deferred state
only after its selected step is exactly confirmed, and clears no unselected edge.

A history decision cannot represent arbitrary path sets, automatic chain collapse,
local create/replace/rename/delete/move, legacy normalization, physical-absence
cleanup, adoption of a newer source revision, compensating deletion, or a new remote
mapping not proven by the snapshot. If the desired mapping needs a local restructuring
or an ordinary local create/replace, the operator performs the host change and opens a
fresh ordinary M4 review. History authority is never transferred into that later
review.

Any change to group membership, path evidence, ACK, revision, receipt, M3 state,
configuration, listener epoch, lifecycle, writer, owner version, or selected candidate
stales the whole decision before admission. After admission, every step revalidates
the evidence it consumes; completed prior steps remain proven while later steps block.

### Parent operation with ordered durable steps

A single parent history operation with a bounded ordered step ledger is normative.
The alternatives were evaluated as follows:

| Criterion | A. Parent with ordered step ledger | B. Parent plus linked child operations |
| --- | --- | --- |
| Restart authority | One record identifies the exact current/completed steps | Must reconstruct authority across parent and independently phased children |
| Reservations | Parent owns the complete group continuously | Children conflict with or require transfer from parent reservations |
| Preservation/effect evidence | Step ID scopes receipts/effects inside one operation | Receipts naturally scope to children but need parent-child proof and transfer |
| Slice 4–5 executor reuse | Executor receives one parent/step request | Executor reuse is direct, but operation lookup/terminal rules need child exceptions |
| Codec/validation | Adds one bounded history-progress union | Adds links, acyclic graph rules, parent/child lifecycle and orphan validation |
| Audit/partial chain | One ordered ledger shows completed/current/later work | Audit must join several records and distinguish child terminality from group terminality |
| Failure behavior | Current unknown/blocked step directly fences later indices | Parent must observe child settlement without losing ownership on save failure |

Model A is selected. Linked child reconciliation operations are rejected because they
would create a second ownership-transfer protocol and make grouped audit/restart state
span several independently terminal records.

Version 4 makes `ReconciliationOperation` an action-discriminated union. Non-history
actions retain their existing aggregate `localEffect`/`remoteEffect` contracts. A new
history operation has `HistoryProgress` instead and has no aggregate effect fields;
step phase and step receipt are the sole cleanup-effect authority. A separate read-only
`legacy-v3-history-unrefined` migration variant preserves any v3 aggregate fields and
receipts but cannot dispatch. Validation rejects a v4 history operation that attempts
to carry both aggregate and step effect truth.

The parent atomically reserves the complete lexical group. `HistoryProgress` above is
the sole owner of its derived step ledger; the decision does not duplicate step data.
Each step is:

```text
HistoryCleanupStep
  stepId: locally generated UUID-v4             # exact v2 mutation/recovery ID
  kind: remote-former-source-cleanup
  sourcePath: NotePath                     # derived from snapshot
  prerequisitePath: NotePath | null        # derived destination prerequisite
  phase: pending | preserving | ready |
         mutating-remote | evidence-required |
         blocked | completed
  remoteEffect:
    not-dispatched | definitely-refused | unknown |
    confirmed-exact-tombstone-receipt
```

Step order is deterministic: source path, prerequisite path with null first, then step
ID only as a final stable tie-break. The ordered ledger has at most one step per group
source. Every cleanup step requires exactly one remote preservation receipt, so total
history steps across state cannot exceed
`MAX_RECONCILIATION_PRESERVATION_RECEIPTS`; admission also accounts for existing
non-history receipts and refuses atomically when the prospective receipt capacity or
encoded-size budget cannot hold every step. Each step ID is globally unique
across the operation collection and is used as that step's existing Worker v2
operation/recovery UUID; the parent operation ID is never reused for multiple remote
tombstones, so recovery objects and receipts cannot collide. Serialized allocation
retries collisions with every currently stored review ID, parent operation ID, history
step ID, unresolved M3 operation ID, and recovery ID, and state validation rejects any
such known duplicate. `nextStepIndex` identifies the only step that may progress; it
is null only for no-effect decisions or after all
steps are complete. A completed step stores the exact returned tombstone revision/
receipt whose operation ID equals the step ID and is never dispatched again. Unknown,
refused, stale, blocked, or persistence-failed current steps prevent every later step.
The parent releases reservations only after the final
state transition has persisted exact step evidence and cleared only the corresponding
deferred blockers. Unrelated groups remain eligible for the shared scheduler.

`RenameHistoryResolutionService` owns the step transition table.
`ReconciliationEffectExecutor` remains the mechanical owner of exact remote reads,
recovery-first conditional tombstone dispatch, receipt recovery, and persistence
fencing. It receives one step-scoped evidence-derived request, dispatches with the
step ID as the remote operation ID, and does not select the step or history policy.

### Step-scoped preservation identity

New history preservation artifacts use exactly:

```text
.ai-bridge-conflicts/<parent-operation-uuid>/<step-uuid>/<side>.md
```

Both UUIDs are locally generated UUID-v4 values validated by core. `side` remains the
closed `local`/`remote` value. A step UUID is chosen instead of a separate artifact
UUID because one history step has at most one requirement per side, already provides
the restart/effect scope, and avoids another identifier/ledger relationship. A generic
artifact UUID would support unconstrained duplicates that policy does not permit. No
reviewed path, remote path, destination, note title, or UI string shapes the archive
path. Existing non-history Slice 3–5 operations retain the version-3 path:

```text
.ai-bridge-conflicts/<operation-uuid>/<side>.md
```

The version-4 preservation receipt is a closed union of operation-scoped and
history-step-scoped identity. A history receipt binds parent operation, step ID,
original path, side, source revision or null, exact content hash, exact generated path,
and proof state. At most one receipt exists per `(operationId, stepId, side)` and every
receipt must match an evidence-derived requirement. The parent operation folder may be
reused only by that exact active parent; each step folder is create-only on its first
dispatch. A pre-existing parent folder is acceptable only when state already contains
a verified history receipt for that parent or the current step's pending requirement
was persisted before the attempted archive write. Same-parent/step recovery may adopt
only the exact expected hash. A foreign parent, unknown step, pre-existing unrecorded
step folder, or mismatching side file blocks. This preserves Slice 3's create-only and
unknown-effect rules while eliminating same-side collisions.

### History effect boundary

A history-native effect may only preserve exact source bytes and perform one reviewed,
recovery-first, conditional remote former-source tombstone at a time. History has no
local effect channel. Local create, replace, rename, move, trash, and delete are invalid
for every history phase and step. A canonical mapping that would need such an effect is
unrepresentable. Ordinary later reconciliation is a fresh review with fresh authority,
not a child of the history operation.

### Device-state version 4

Keeping byte/schema-compatible v3 is rejected: the selected parent-step ledger,
step-scoped receipt discriminant, synthetic local-effect observation, durable successor
range, and `successor-review-required` phase all require strict persisted fields that
v3 cannot encode. Encoding them only in existing aggregate fields would lose exact
restart identity; adding optional fields under version 3 would make older strict-v3
code report a same-version value as corrupt and could hide safety state from code that
omits the fields.

Slice 6 must introduce device-state schema version **4** under the existing
`ai-bridge:mirror-device-state` key. Version 3 remains historical implemented truth.
The implementation must freeze the current strict version-3 decoder before evolving
the current codec.

Startup performs strict v3 decode and semantic validation, deterministic v3-to-v4
projection, complete v4 validation/encoding, one same-key save, one exact read-back
comparison, and strict v4 decode before runtime publication. Any decode, validation,
encoding, save, quota, read-back, integrity, or version failure is state-unavailable.
There is no reverse migration.

Projection preserves every M3 field and every non-empty M4 review, operation, effect,
receipt, reservation, and successor link. It infers no history choice, step completion,
or event causality:

- non-history v3 operations receive the v4 observation state `legacy-v3-unfenced` when
  they contain a started/confirmed/unknown local effect. That state retains the exact
  prior v3 phase and focused recovery progress. Before runtime/UI publication or any
  further mutation, a startup-only transition uses a read-only local inspection and
  the exact postcondition derivable from existing operation evidence: exact expected
  bytes become a recovered synthetic confirmation and resume from a safe prior phase;
  definitely absent/changed evidence becomes a permanent blocked result; and unavailable
  or ambiguous evidence remains evidence-required for a later startup retry. Failed
  persistence aborts startup without publishing the prospective transition. The
  recovery owner has no writer, remote port, review authority, or event source, so it
  cannot redispatch a local effect or infer a host event. Semantic v4 validation also
  rederives the authorized path/digest pair for every persisted `recovered-v3` result;
- v3 history operations receive `legacy-v3-history-unrefined`; their aggregate state
  and receipts are preserved, they dispatch no new effect, and active records become
  permanent migration-attention blockers in M4 because no operator choice can be
  inferred. Slice 6–7 exposes this status but provides no clearing command;
- existing v3 preservation receipts retain their operation-scoped path and receive no
  fabricated step ID;
- operations with no local effect receive `not-required` or `not-started` only from
  their existing action/effect state; no observation event is inferred.

The v4 codec accepts at most **12 MiB**. The existing strict-v3 input remains bounded
at 8 MiB; migration must prove by exact UTF-8 encoded size that the projected value
fits the v4 bound before its first save. Cardinality remains bounded by the existing
50,000 tracked paths, 1,024 reviews, 1,024 operations, and 2,048 preservation receipts.
Because each remote cleanup step requires one receipt, total history steps are bounded
by the same 2,048 receipt ceiling, the available receipt capacity after non-history
requirements, and the paths referenced by their parent snapshots. Those cardinalities
are safety ceilings, not a claim that a
maximum-length instance of every collection fits 12 MiB. Every v4 admission and state
transition must encode the prospective complete state and refuse it atomically with a
typed capacity result when it exceeds 12 MiB. Tests cover the largest valid v3
migration projection, exact byte boundaries, and oversized history admission without
assuming host quota. Host quota failure still fails closed and makes no atomicity
claim.

Version-3 and older runtimes reject v4. The runtime owner and same-realm registry
structural versions become **4** because scheduler, review-session, recovery-query, and
M4 execution methods are added. This is one Slices 6–7 compatibility transition: Slice
6 may build and test the frozen-v3/v4 codec and core history model first, but no plugin
runtime may publish or save v4 until Slice 7's complete version-4 owner/registry surface
is present. The implementation must land these slices together; an intermediate merge
that writes v4 under owner version 3, or advertises owner version 4 without the full
surface, is invalid. A version-3 owner/registry is incompatible and requires host
restart. A valid historical v3/v4 rollback can remain undetectable; operators must
pause and reconcile forward. Active M4 operations, including migrated legacy blockers,
continue to block handoff/export. The content-free handoff record format does not gain
M4 operations and therefore does not need a new wire version; import into v4 still
requires no active reconciliation work.

### One shared runtime scheduler

`MirrorRuntimeOwner` owns one long-lived `FairMirrorScheduler`, constructed once per
same-App realm and injected into both `MirrorSynchronizer` and
`ReviewedReconciliationRuntime`. It retains the existing global maximum of two active
jobs and lexical multi-path process reservations. There is no M4 scheduler.

The process scheduler is execution exclusion and fairness only. Before enqueue and
again before effect dispatch, M3/M4 policy checks durable reservations and state-owner
admission. Restart authority remains the active durable operation. Detach cancels host
wake callbacks but does not release an admitted job before its promise settles.

### Exact local-effect observation protocol

Obsidian host events carry no operation token and therefore cannot safely prove causal
origin. M4 must not guess that the next, nearest, or same-path event was caused by its
write. The exact protocol uses a durable **synthetic local-effect observation** and
classifies every official Vault event as external successor evidence.

Before a local create/replace, the operation persists:

```text
LocalEffectObservation
  prepared
    effectId: locally generated UUID-v4
    path: operation-owned NotePath
    expectedHash: exact action-derived SHA-256
    listenerEpoch: current epoch
    beforeGeneration: current path generation
    successor: none | observed-generation-range
  confirmed | recovered-v3
    same fields
    postconditionHash: expectedHash
    successor: none | observed-generation-range
  legacy-v3-unfenced
    priorPhase: exact frozen-v3 operation phase
    recoveryState: pending | evidence-required | blocked
  not-started
  not-required
    path/listenerEpoch/beforeGeneration
    successor: none | observed-generation-range
```

The path event router and local-effect dispatch are serialized by the long-lived
reviewed-reconciliation runtime. Remote-only reviewed effects retain the structured
`not-required` fence so a local edit while a conditional remote request is pending
cannot disappear merely because no plugin local write was needed. The writer's exact post-read/hash confirms the
synthetic effect ID; it does not consume a Vault event. Every create/modify/delete/
rename callback increments the external observation generation and is sequenced after
or before that state transition. Any generation greater than `beforeGeneration` is
successor evidence—even if the bytes are equal and even if the host event was probably
emitted by the M4 write. Delete and rename are always successor evidence. While the
operation owns the path, the first/latest generation and closed event-kind set are
persisted as a bounded content-free successor range; no event body is retained.

This conservative rule may create an extra review but cannot erase an external event
or grant outward authority. Before release, the runtime inserts a queue barrier and
persists every earlier event. With no observed successor, ordinary completion may
release the path; a later event enters ordinary M3/M4 observation normally. With a
successor range, the operation enters active `successor-review-required` and keeps the
path reserved. Only the runtime owner may create a fresh review linked to that exact
predecessor while the reservation is active. Resolution is a closed atomic transition:

- if the fresh complete snapshot is classified `aligned`, a no-effect alignment
  settlement records the successor review ID, completes that review and predecessor,
  and releases the path in one state save;
- if the snapshot permits and the operator admits an ordinary action, the new
  operation links to the predecessor and takes ownership in the same state save before
  the predecessor becomes terminal;
- stale, incomplete, unavailable, closed, or deferred review state leaves the
  predecessor active and reserved.

The no-effect alignment settlement dispatches neither local nor remote mutation and is
not an operator action or a new history decision. This avoids an endless extra-review
loop when the only callback was the host notification for an otherwise aligned local
effect. Listener gaps/restart invalidate process-local generations; the durable effect
ID, exact postcondition, optional successor range, and persisted successor link remain
the only proof.

`ReviewedReconciliationRuntime` owns serialization and event classification;
`LocalReconciliationWriteService` owns effect preparation/postcondition;
`ReconciliationObservationGenerationOwner` owns external generation allocation.

### Review sessions, startup, and recovery selection

`ReconciliationReviewService` owns transient review sessions. It exposes exact
`closeReview(reviewId, sessionId)` and `invalidateSession(sessionId)` operations in
addition to owner-wide invalidation. They mark only matching pending ephemeral reviews
stale, clear local/remote bodies, and revoke submission. A staged/admitted durable
operation and its already-cleared transient review are never cancelled or erased by UI
closure.

A core `ReconciliationStartupService` owns one serialized pre-publication transition.
It marks each orphan durable `pending` or `blocked` review with `operationId: null`
stale, preserves every reciprocal valid review-operation pair regardless of active or
terminal phase, and leaves already-stale/completed terminal evidence unchanged. It
performs no local/network access. `MirrorRuntimeFactory` constructs an unpublished
state owner, runs this transition, and publishes commands/runtime only after a
committed or no-op result. Save failure is state-unavailable.

`ReconciliationReviewService` also owns the bounded recovery-selection query because it
already owns read-only recovery evidence. The query classifies content-free entries as
prepared, sealed-active, sealed-expired, or purged with an explicit actionability flag
and complete/incomplete pagination status. Expiry classification and restore admission
share one runtime-clock predicate, so expired, purged, and incomplete rows remain
visible but cannot be submitted. Listing fetches no recovery body. The runtime binds
selection to exact metadata from its latest complete process-local projection and
consumes that binding on submission; `createReview` then re-inspects metadata and binds
the exact revision/status/hash/expiry to the new immutable snapshot. Refresh, metadata
change, session invalidation, incomplete inventory, or a forged ID makes the prior
selection stale and grants no restore authority.

## Consequences

Slices 6–7 gain one auditable state path:

```text
durable rename graph
  → derived group and opaque choices
  → exact admitted parent decision and full reservations
  → ordered step-scoped preservation and remote cleanup
  → exact step receipts and restart progress
  → shared runtime scheduling and conservative event sequencing
```

The model stores bounded content-free evidence, not note bodies or reconstructed
history. Version 4 adds migration and compatibility work, and the conservative event
protocol can produce extra review items, but it avoids an unprovable host-event origin
claim. Existing Worker v2 operations remain sufficient.

## Alternatives

Linked child operations were rejected because parent/child reservation transfer and
terminal linkage would create more state and a second authority protocol. Reusing
`<operation>/<side>.md` was rejected because grouped same-side artifacts collide.
Path-derived artifact names were rejected as attacker-controlled. History-native local
writes/moves were rejected because they broaden authority and cannot make rename/delete
conditional. Silently extending strict version 3 was rejected because old v3 code
would report new state as corrupt rather than a newer incompatible format. A second
M4 scheduler was rejected because it would violate the global work bound. Ignoring the
next host event was rejected because host callbacks carry no causal token.

## Evidence / related documents

[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[M4 implementation plan](../plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[Slices 6–7 preparation and revalidation](../plans/m4-slices-6-7-implementation-preparation.md),
[ADR 0005](0005-reviewed-reconciliation-authority.md),
[ADR 0006](0006-conflict-preservation-and-local-mutation.md),
[ADR 0007](0007-explicit-adoption-tombstone-and-restore.md), and
[ADR 0008](0008-m4-device-state-migration.md).
