# M4 Slices 6–7 implementation preparation

> **Non-normative preparation/handoff:** Current source plus the accepted
> [M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
> and [ADRs 0005–0008](../decisions/README.md) remain authoritative. This analysis
> was produced before Slices 4–5 were implemented; those slices were considered only
> as planned contracts. Every gap, likely module, and possible API described here
> **MUST** be revalidated against the final merged Slices 4–5 before any contract or
> production-code change. This document must not justify implementation that
> contradicts later merged code, and no new product decision is accepted merely
> because it appears here.

## Purpose

Preserve implementation preparation for M4 Slice 6 (deferred rename/history
resolution) and Slice 7 (runtime/UI composition) across handoff and context
compaction. This document records dependencies, existing semantic owners, test
matrices, lifecycle and security constraints, and technical contract gaps found in
the pre-Slice-4/5 repository.

It is not an ADR, an amendment to accepted M4 semantics, implementation authority,
or evidence that either slice is complete. Resolve no listed gap by inference: first
inspect the merged Slices 4–5 source, tests, current specification, plan, and ADRs.

## Basis and constraints

- Reviewed repository state: clean `main` at exact commit `cd8fb36`
  (`feat(reconciliation): add durable local mutation primitives (#35)`), aligned
  with `origin/main` when this analysis was prepared.
- M4 Slices 1–3 were implemented in that source state.
- M4 Slices 4–5 were analyzed only through the accepted specification and planned
  contracts. No Slice 4 or Slice 5 production implementation was assumed.
- No Slice 6 or Slice 7 production behavior was implemented as part of this work.
- No Worker deployment, personal-vault installation, or environment mutation is
  implied or authorized.
- Existing v2 Worker operations remain the accepted remote capability. This analysis
  does not propose a new route, DTO, CORS capability, OpenAPI operation, database, or
  Cloudflare service.
- Current source wins over this preparation document. Later merged code wins over
  every proposed filename, interface shape, or composition seam recorded below.

---

# Slice 6 — Deferred rename/history resolution

## Prerequisites

1. **Slice 1 — contracts and durable state**
   - `ReconciliationReviewSnapshot`, operation/action/phase contracts.
   - Durable path reservations, action/phase validation, M3-before-M4 precedence,
     and device-state v3 migration/downgrade fencing.
2. **Slice 2 — read-only review and admission**
   - `ReconciliationReviewService`, exact evidence sampling, observation-generation
     staleness, immutable snapshot equality, and serialized decision admission.
3. **Slice 3 — preservation and local-write primitives**
   - `ConflictPreservationService`, evidence-derived preservation requirements,
     verified receipts, and exact same-operation recovery.
   - The deliberately narrow `LocalReconciliationWriter` boundary.
4. **Final merged Slice 4 contracts**
   - Resolution coordinator, exact remote-effect preparation/settlement, receipt
     recovery, operation completion, and baseline-finalization ordering.
5. **Final merged Slice 5 contracts**
   - Recovery-first conditional tombstone primitives and exact unknown-effect/restart
     behavior suitable for M4 operator authority.
6. **Preserved M3 behavior**
   - `RenameDeferredMirrorState`, destination ACK prerequisites, conditional v2
     mutation semantics, recovery-backed tombstones, and permanent current heads.

## Exact semantic owners to reuse

| Concern | Existing or expected authoritative owner |
| --- | --- |
| M3 rename evidence | `RenameDeferredMirrorState` and `mirror-lifecycle-state.ts` |
| Candidate sampling and stale review identity | `ReconciliationReviewService` |
| Classification | `DivergenceClassifier` in `divergence-classifier.ts` |
| Action admission | `reconciliation-decision-policy.ts` |
| Exact snapshot comparison | `reconciliationReviewSnapshotsEqual` |
| Durable serialization and persistence fencing | `MirrorStateOwner` |
| Preservation requirement matrix | `reconciliation-preservation-policy.ts` |
| Preservation execution | `ConflictPreservationService` |
| Conditional transport | `RemoteBridge.mutateNote` |
| Recovery-first tombstone execution | Revalidate and reuse the final Slice 5 M4 primitive |
| Process-local lexical reservations | `FairMirrorScheduler` or the final merged shared scheduler owner |
| Durable M3 exclusion | `isReconciliationPathReserved` and `MirrorSynchronizer` reservation filtering |

Do not call `MirrorDeletionExecutor.run()` directly under history-decision authority.
That executor consumes M3 event-derived deletion/rename authority and grace state,
not an admitted operator history decision. Reuse only an explicitly extracted safe
primitive or the final Slice 5 M4-authorized remote-effect boundary after inspecting
its merged contract.

## Likely new modules

These names describe likely responsibilities, not approved contracts:

- `packages/core/src/mirror/rename-history-group-policy.ts`
  - Derive the complete bounded connected group from current durable rename edges.
- `packages/core/src/mirror/rename-history-resolution.types.ts`
  - Closed current-state choice, step, and result contracts, if still needed after
    Slices 4–5 merge and after resolving the contract gaps below.
- `packages/core/src/mirror/rename-history-resolution-service.ts`
  - Execute one persisted evidence-bound history step at a time.
- Focused tests, likely:
  - `packages/core/tests/unit/rename-history-group-policy.test.ts`
  - `packages/core/tests/unit/rename-history-resolution.test.ts`

The final Slice 4 coordinator should route history phases. It must not absorb grouped
history policy, classification, preservation, remote transport mechanics, or UI
formatting.

## Grouped evidence and reservation rules

- Derive the group from durable M3 rename edges, not arbitrary related paths supplied
  by a command, modal, or caller.
- Include the bounded transitive closure of:
  - every source path;
  - every non-null destination path;
  - all overlapping plans and rename-chain members;
  - current local, ACK, remote, unresolved-M3, and deferred-history evidence for each
    involved path.
- Bound discovery by `MAX_MIRROR_TRACKED_PATHS`; capacity failure is explicit and
  non-authoritative.
- Sort the final unique path set lexically before admission and scheduling.
- Persist the complete reservation set atomically. Do not acquire path ownership
  incrementally or hold one path while waiting for another.
- Any change in any grouped path, baseline, revision, M3 evidence, configuration,
  lifecycle, listener epoch, or runtime identity invalidates the whole decision.
- Process-local scheduler reservations are secondary exclusion only. The durable
  `ReconciliationOperation` remains restart authority.
- M3 and other M4 work on unrelated paths must continue within the shared global
  concurrency bound.
- The group is a current-evidence graph, not reconstructed historical truth. Missing
  edges or contradictory history do not authorize guessed mappings.

## Complete transition/state matrix

| Current exact evidence | Permitted operator decision | Required ordering | Terminal or attention result |
| --- | --- | --- | --- |
| Destination ACK is exact; source remote is the expected live revision; local source is freshly absent | Complete remote source cleanup | Persist decision → preserve exact remote source → revalidate destination/source/local absence → exact conditional tombstone → persist exact receipt/ACK → clear deferred history last | Complete, stale, blocked, or evidence-required |
| Source and destination are both live | Retain independently, choose an explicit current canonical mapping, clean up only a specifically selected remote source, or defer | Preserve every generation that would be replaced or tombstoned; apply one proven step at a time | No silent duplicate collapse |
| Exact chain A→B→C | Explicitly map current generations or retain them independently | Reserve A/B/C together; persist each completed step before the next | Partial state resumes exactly |
| Overlapping rename plans | Explicit current mapping/retention or defer | Reserve the complete connected group; never infer an automatic chain collapse | Unrelated groups remain runnable |
| Former source has a newer remote revision | Treat it as independent current divergence | Old cleanup predicate is stale; perform no cleanup | Fresh review required |
| Source has been locally recreated | Treat recreated local bytes as an independent note | Never consume old cleanup authority against recreated bytes | Existing local bytes survive; old decision is stale |
| Destination moved or changed after sampling | Review the current destination state again | Do not reuse the old destination prerequisite | Group becomes stale |
| Remote source is physically absent | No tombstone/adoption inference | Never treat physical absence as a deletion generation | Unsupported lineage/block |
| Former source is legacy | Preserve/fork/defer only | No same-path cleanup or normalization | Original legacy object remains untouched |
| History is contradictory or incomplete | Retain current states, choose only explicit current mappings, or defer | No historical reconstruction | Durable blocked/deferred result |
| Operator selects no-effect retention/defer | Persist only the accepted no-effect outcome when required | No local or remote effect | Completed no-effect decision or retained blocker, according to final contract |

## Preservation requirements

- Every version selected for replacement or remote cleanup must already remain at its
  exact current generation or be present in a verified preservation artifact.
- Remote cleanup requires preservation of the exact source live bytes and exact
  revision before the conditional tombstone.
- A local version must be preserved before any permitted operation replaces it.
- A no-effect retain/defer result requires no new artifact.
- Receipt identity must remain derived from admitted evidence: operation, original
  path, side, source revision/null relationship, exact hash, generated path, and proof
  state.
- Failed, colliding, ambiguous, or mismatching preservation stops the dependent
  action. No compensation deletes another surviving version.
- Existing conflict artifacts remain explicit operator-cleanup material and are not
  automatically removed.

The current one-`local.md`/one-`remote.md` representation cannot safely be assumed to
support every grouped case; see contract gaps 3 and 4.

## Safe remote-source cleanup requirements

Remote source cleanup is admissible only when all conditions remain true:

1. Authority is exactly `operator-history-decision`.
2. The operation owns every involved path reservation.
3. Runtime owner, configuration generation, listener epoch, association, designated
   writer, device, lifecycle, review identity, and action remain exact.
4. No involved path has unresolved M3 mutation authority.
5. Local source absence remains exact and current.
6. The destination ACK and destination revision prerequisite remain exact.
7. The source remains a same-association format-2 live generation at the sampled
   revision.
8. Exact source bytes are post-verified in the excluded preservation archive.
9. The conditional tombstone uses the sampled source revision, never a refreshed
   latest revision.
10. The existing Worker v2 deletion operation performs recovery-first conditional
    tombstoning and returns an exact receipt.
11. ACK/baseline changes and deferred-history cleanup are persisted last, after the
    effect is proven.

An unknown remote effect transitions to evidence-required. Recovery inspects the exact
operation receipt/current revision and never blindly redispatches, adopts a newer
revision, or substitutes a new operation ID. Remote physical absence, a foreign
association, legacy content, or malformed evidence cannot authorize cleanup.

## TDD matrix

### Group formation

- Single source/destination edge.
- A→B→C transitive chain.
- Two sources sharing one destination.
- Cycle or overlap without unbounded traversal.
- Rename out of eligibility with a null destination.
- Exact capacity boundary and deterministic lexical output.
- Caller-provided related paths cannot omit required group members.
- Caller-provided related paths cannot expand the authoritative group with unrelated
  paths.
- Every grouped path contributes current local/ACK/remote/M3 evidence.

### Decision rows

- Exact destination prerequisite plus unchanged source cleanup.
- Duplicate live source/destination retained independently.
- Explicit canonical source cleanup with preservation.
- Former-source remote edit.
- Local source recreation.
- Destination changed or moved.
- Legacy former source.
- Remote physical absence.
- Insufficient or contradictory history.
- No-effect retain/defer completion.
- Mapping requiring forbidden local rename/removal is refused and requires an
  operator host action plus fresh review.

### Preservation and cleanup

- Archive verification occurs before any remote mutation call.
- Wrong source revision, hash, operation, path, or association is rejected.
- Archive collision blocks cleanup.
- Unknown archive effect requires exact same-operation evidence.
- Exact conditional tombstone receipt confirms cleanup.
- Receipt mismatch and same-text remote ABA remain stale.
- The recovery object/current tombstone survive successful cleanup.
- No native R2 delete, new route, v1 mutation, or local delete/rename is called.
- An extra preservation receipt not derived from admitted evidence is invalid.

### Reservation and progress

- Full lexical group is reserved atomically.
- Overlapping operation admission is refused.
- Disjoint path progresses while a group is blocked.
- Every partial step is persisted before the next starts.
- Terminal operations release only their own paths.
- M3 scheduling remains excluded from every active reserved path.
- A persistence failure leaves all reservations/evidence conservatively active.

## Restart/interleaving matrix

| Interleaving | Required outcome |
| --- | --- |
| Restart after admission but before preservation | Resume the exact group; no effect has occurred |
| Restart after a pending archive write | Inspect/adopt only an exact same-operation artifact |
| Restart after verified archive | Revalidate exact source/destination evidence before dispatch |
| Remote source changes while archive is written | Archive survives; old cleanup becomes stale |
| Remote tombstone commits but response is lost | Inspect the exact operation receipt; do not blindly retry |
| Remote commit succeeds but state save fails | Persistence fences later effects; tombstone/recovery and archive survive |
| Restart after one chain step | Completed step is not replayed; remaining steps stay reserved |
| Local source is recreated before cleanup | Recreated bytes survive; old cleanup is refused |
| Destination changes between steps | Whole group blocks/stales; completed copies remain |
| Unload or configuration change during a request | No new dispatch; reservation remains through actual settlement |
| Two overlapping history reviews attempt admission | Exactly one durable reservation set wins |
| Unrelated path becomes ready | It progresses under the shared global bound |
| Same-text remote ABA occurs before cleanup | Revision mismatch rejects the old decision |
| Persistence fails before first effect | No local or remote effect is dispatched |
| Evidence budget or finite retry budget is exhausted | No hidden polling; durable attention state remains |

## Lifecycle risks

- Restart must not reconstruct intent from incomplete rename history.
- Configuration or listener-epoch changes must invalidate open grouped reviews.
- Persistence failure after a remote effect must fence every later mutation.
- A blocked, partial, unknown-effect, or evidence-required history operation must
  continue blocking handoff/export.
- Process-local scheduler ownership must never be mistaken for restart authority.
- Deferred M3 plans must be cleared only after exact reviewed completion, not after
  admission or preservation alone.
- A new current path observation must invalidate old cleanup dependencies without
  deleting already materialized archives.
- The final implementation must not create an independent retry engine or an
  unbounded resume loop.

## Security and privacy risks

- Former-source remote Markdown is untrusted plaintext and must remain inert.
- Source paths must never shape preservation destinations.
- Group, operation, status, and handoff records remain content-free.
- Never log note bodies, raw transport failures, bearer values, recovery content,
  storage validators, or response envelopes.
- Reject malformed paths, foreign associations, legacy cleanup, oversized content,
  and file/folder ambiguity before effects.
- Conflict archives may contain sensitive plaintext and must not be automatically
  opened, uploaded as ordinary mirror content, or removed.
- No reviewed note content, frontmatter, embedded command, or instruction grants
  authority.

## Explicit non-goals

- Automatic rename reconstruction or chain collapse.
- Multi-key atomic rename claims.
- Plugin local rename, move, trash, or delete.
- Compensating deletion.
- Same-path legacy normalization.
- New Worker routes, history database, event log, Durable Object, queue, or other
  infrastructure.
- Automatic preservation cleanup.
- Reuse of old M3 cleanup authority for recreated or edited source bytes.
- Automatic canonical-path selection.
- Deployment or personal-vault qualification.

---

# Slice 7 — Runtime, commands, modal, and status composition

## Prerequisites

- All Slice 1–6 core behavior and restart paths are complete.
- Final Slice 4 resolution facade and remote-effect settlement API are merged.
- Final Slice 5 recovery selection/restore API and restored-successor transfer are
  merged.
- Final Slice 6 grouped-history API and status outcomes are merged.
- The existing M3 same-realm owner/session/settings/status architecture remains
  behaviorally intact.

## Exact semantic owners to reuse

| Concern | Authoritative owner |
| --- | --- |
| Same-realm owner lifetime | `MirrorRuntimeOwner` and the versioned runtime registry |
| Configuration/connection identity | `MirrorConnectionAdmissionCoordinator` |
| Request permits and cancellation | `MirrorRequestGate` |
| Listener and presentation epochs | `MirrorObservationEpochCoordinator` |
| M3 bootstrap identity | Existing `MirrorReconciliationCoordinator` |
| One-shot host wake mechanics | `MirrorWakeScheduler` |
| Saved host events | `ObsidianMirrorEvents` |
| Review sampling and admission | `ReconciliationReviewService` |
| Same-text local event generations | `ReconciliationObservationGenerationOwner` |
| Resolution policy and effects | Final Slice 4–6 core services |
| Durable state | `MirrorStateOwner` |
| Local write mechanics | `ObsidianLocalReconciliationWriter` |
| Remote transport | Existing `FetchRemoteBridge` |
| Sanitized M3 status | `mirror-status.ts`, extended through a focused M4 projector rather than UI inspection |

Avoid naming the new owner `MirrorReconciliationCoordinator`; that name already owns
M3 bootstrap identity. A name such as `ReviewedReconciliationRuntime` or
`ReconciliationRuntimeOwner` would better distinguish the responsibility, but the
merged code must be checked before choosing a filename.

## Likely modules and integration points

Likely new plugin modules, subject to post-Slice-5 revalidation:

- `apps/obsidian-plugin/src/runtime/reconciliation-runtime-owner.ts`
- `apps/obsidian-plugin/src/commands/reconciliation-commands.ts`
- `apps/obsidian-plugin/src/reconciliation/reconciliation-review-modal.ts`
- `apps/obsidian-plugin/src/reconciliation/recovery-selection-modal.ts`
- `apps/obsidian-plugin/src/reconciliation/reconciliation-ui.types.ts`
- `apps/obsidian-plugin/src/status/reconciliation-status.ts`

Likely existing integration points:

- `apps/obsidian-plugin/src/runtime/mirror-runtime-owner.ts`
- `apps/obsidian-plugin/src/runtime/mirror-runtime-factory.ts`
- `apps/obsidian-plugin/src/runtime/mirror-plugin-session.ts`
- `apps/obsidian-plugin/src/events/obsidian-mirror-events.ts`
- `apps/obsidian-plugin/src/state/runtime-mirror-coordinator.ts`
- `apps/obsidian-plugin/src/status/mirror-status.ts`
- `apps/obsidian-plugin/src/status/mirror-status-ui.ts`
- `apps/obsidian-plugin/src/main.ts`
- plugin runtime, event, modal, status, registry, source integration, and generated
  artifact test support.

## Runtime-owner responsibilities

The dedicated reconciliation runtime owner should:

- construct the core review/resolution graph for the current connection generation;
- expose sanitized query and command results to the current plugin session;
- own transient review sessions and discard bodies on close/detach;
- invalidate reviews on configuration, listener epoch, owner, process, or UI-session
  changes;
- resume persisted operations independently of UI lifetime;
- route eligible local events through M4 observation/own-write handling before
  ordinary M3 scheduling;
- share request admission and the global bounded scheduler;
- retain reservations and effect settlement across plugin replacement/re-enable;
- notify only the current presentation session without retaining modal objects;
- make stale or incompatible sessions incapable of presenting or mutating.

It must not classify conflicts, choose allowed actions, calculate preservation,
construct conditional requests, interpret recovery state, or update ACKs itself. Those
remain core policy responsibilities.

## Commands

Register two focused commands without altering M2 or existing M3 command identities:

- **AI Bridge: Review remote divergence**
- **AI Bridge: Restore recovery snapshot**

Each command should:

1. verify the current attached session, layout, configuration, connection,
   designation, lifecycle, and capability readiness through runtime owners;
2. invoke a typed application/runtime method;
3. receive a sanitized list, detail, recovery, or failure projection;
4. submit exactly one typed command containing review/session/action identity and any
   explicitly validated destination selection;
5. show a fixed unavailable/stale result when authority is absent.

Command registration alone must never trigger network access or local mutation. A
button or command callback is not authority; serialized application revalidation is.

## UI/no-policy boundary

The UI may:

- render supplied candidate, detail, recovery, and status projections;
- display the closed allowed-action set supplied by core;
- collect an operator-entered destination string;
- submit a typed request such as
  `{ reviewId, sessionId, action, destinationPath? }`;
- disable controls after one submission as a presentation safeguard;
- request a bounded text preview only after explicit operator action.

The UI must not:

- derive classification or allowed actions;
- decide preservation requirements;
- generate operation, revision, receipt, association, or conditional identity;
- refresh remote state and reinterpret the original command;
- sequence local and remote effects;
- retry unknown effects;
- update ACKs, phases, reservations, or durable state;
- call Vault, Fetch, SecretStorage, or `MirrorStateOwner` directly;
- infer product policy from display strings.

Settings may link to commands and show sanitized counts. Settings do not own
reconciliation policy or render note bodies.

## Text-only preview requirements

- Use read-only text controls or `textContent`/text-backed element creation.
- Never use Markdown rendering, `innerHTML`, embeds, links, frontmatter execution,
  command interpretation, templates, or automatic note opening.
- Previews are explicit and bounded by existing content-size policy.
- Clear DOM text and transient references on close, refresh, unload, and session
  invalidation.
- Malicious Markdown, HTML, link syntax, embeds, and instruction-like content display
  literally.
- Do not include preview bodies in device state, plugin data, status, notices, logs,
  handoff data, or generated-artifact fixtures.
- Warn before writing untrusted remote/recovery content into the working vault; do not
  automatically open or render the resulting note.

## Lifecycle/state matrix

| Runtime/session state | Review/list behavior | Mutation behavior |
| --- | --- | --- |
| Preferences unconfigured or invalid | Sanitized unavailable result | None |
| Secret/current connection unavailable | Unavailable | None |
| Current session not layout-ready | Commands may be registered; operation reports not ready | None |
| Device is not designated or association mismatches | Blocked/unavailable projection | None |
| Disabled, paused, or handoff lifecycle | Any read behavior follows the final merged readiness contract; no action admission | None |
| Active, designated, current epoch and connection | Bounded discovery/detail allowed | Typed admission/effects allowed |
| Modal closes | Its review/session authority is invalidated and bodies discarded | Already admitted durable operation remains unaffected |
| Plugin unloads | Events, timers, commands, UI and open reviews detach/invalidate | In-flight owner work settles and retains reservations |
| Same-realm plugin re-enables | New session and listener epoch; old commands are stale | Durable operation resumes; no old UI authority is reused |
| Process restarts | Ephemeral reviews disappear; orphan durable reviews become stale before UI | Persisted operations resume only from exact phase/evidence |
| Configuration generation changes | Open reviews become stale; old connection retires | No new old-generation dispatch; already dispatched work settles conservatively |
| Existing registry/owner is incompatible | M2 remains available; M4 runtime is unavailable | None |
| Persistence or global runtime fence is active | Sanitized status remains visible | No further effect admission |
| Active restore is `restored-pending-review` | Fresh successor review may be shown | Ordinary M3 scheduling/handoff remains fenced until linked successor completion |

## Own-write event consumption ordering

1. Every eligible host event first advances the
   `ReconciliationObservationGenerationOwner`, including same-text saves.
2. Events on unreserved paths continue through unchanged M3 behavior.
3. Preservation-path events remain excluded by the existing dot-segment policy.
4. Create/modify events on an M4-reserved eligible path are offered to the
   reconciliation owner before M3.
5. Such an event may be consumed as the operation's own write only when the durable
   phase, reserved path, expected hash, observation identity, and exact postcondition
   prove that relationship.
6. An extra event, mismatching current bytes, delete, or rename is external successor
   evidence, not an own-write event.
7. Successor evidence remains dirty/reviewable and is not erased when the admitted
   operation completes.
8. Reservations release only after own-event/postcondition settlement is durably
   recorded.
9. If unload occurs while an expected event is pending, the durable operation and
   exact local postcondition—not the detached callback—remain recovery authority.
10. M4 never emits a local delete or rename, so delete and rename events on a reserved
    path always invalidate/block rather than being consumed as expected M4 effects.

The current operation contract lacks a durable own-event identity; see contract gap
9. Do not approximate this with timing, a boolean suppression flag, or path-only event
filtering.

## Status projections

Add content-free projections derived from authoritative closed state, potentially
including:

- current bounded review/candidate availability;
- stale review count;
- active operation count;
- partial, evidence-required, or blocked operation count;
- `restored-pending-review` count;
- grouped-history attention state;
- sanitized per-path or per-group outcomes.

Exact field names and grouping must follow the final Slice 4–6 result contracts. The
presentation layer must consume a projector rather than inspect durable state variants
or reproduce phase policy.

Do not expose note/recovery bodies, bearer values, raw failures, response envelopes,
storage validators, hidden recovery internals, or host exceptions. Validated paths,
hashes, revisions, and fixed outcome labels may appear only where the accepted spec
allows them and must not be logged by default.

## TDD matrix

### Command and readiness behavior

- Both commands register alongside all existing M2/M3 commands.
- Unconfigured, invalid, no-secret, non-writer, incompatible-owner,
  state-unavailable, and pre-layout states dispatch no mutation.
- Command registration itself performs no network request.
- Duplicate command submission admits at most one operation.
- Existing M2 inspection and M3 operational command behavior remains unchanged.

### Modal and preview behavior

- Bounded candidate list → selected detail → explicit preview.
- Bounded recovery selection → exact destination confirmation.
- Local and remote malicious content renders literally.
- No Markdown renderer or HTML insertion method is called.
- Close, refresh, and unload clear bodies and invalidate authority.
- Destination text is passed to core validation without UI path repair or
  normalization.
- Allowed buttons exactly match the supplied action projection.
- Bearer/raw errors/storage internals never enter modal text or notices.

### Session authority

- Refresh creates a new review ID and invalidates the prior ID.
- Modal close invalidates its review/session command authority.
- Double-click and replay are stale.
- Unload/re-enable changes session ID and listener epoch.
- Old asynchronous completion cannot present UI or mutate.
- Process restart cannot recreate an ephemeral decision.
- Owner replacement with an incompatible structural surface fails closed.

### Runtime settlement

- Hold a local read, remote request, local mutation, and state save separately across
  unload.
- Owner retains reservations until real settlement.
- Re-enable joins the same compatible owner.
- Configuration replacement closes admission without claiming transport rollback.
- Persistence failure after an effect fences subsequent work.
- Persisted partial operations resume without a modal or retained body.

### Event consumption

- Exact M4 create/replace event is consumed into the operation.
- A same-text extra event after the own write remains a successor generation.
- External edit during local write remains dirty/reviewable.
- Delete/rename on a reserved path invalidates rather than being consumed.
- Unreserved M3 event behavior is unchanged.
- Preservation archive events never enter eligible scheduling.
- An event arriving after admission but before remote settlement is sequenced rather
  than lost.

### Timer and status behavior

- Only finite persisted work produces one-shot wakes.
- No review polling or hidden retry loop exists.
- Detach cancels callbacks but not admitted work.
- Counts match durable review/operation phases.
- Status, notices, logs, and serialization contain no bodies, bearer, raw errors, or
  storage internals.
- Status updates from a stale session are ignored.

## Concurrency/interleaving cases

- Review read is pending while a local event arrives: review becomes stale; no action
  is admitted.
- Action is admitted while the plugin unloads: operation continues; old session
  receives no UI result.
- Local M4 write emits an event before post-verification: reservation remains until
  classification and durable settlement.
- External edit follows an own event before settlement: exact operation effect and
  successor evidence remain separately visible.
- Configuration changes while a remote request is pending: no new old-generation
  request; unknown effect remains explicit.
- M3 path B runs while reserved M4 path A is blocked.
- Restore successor review races with re-enable: only the new session may admit; the
  durable restore fence remains.
- Two modals select overlapping path groups: only one durable admission succeeds.
- Process restarts after a partial operation: content is reconstructed only from exact
  local, revisioned remote, recovery, or verified preservation evidence.
- Modal closes while admission revalidation is pending: stale session cannot present
  or submit again; application validation remains authoritative.

## Lifecycle risks

- Storing `ReconciliationReviewService` only in a plugin session would lose required
  invalidation/operation ownership on re-enable.
- A separate M4 scheduler could exceed the intended global bound unless scheduling is
  shared with M3.
- Detach must invalidate ephemeral authority without cancelling durable settlement.
- Registry compatibility checks must include the final new callable runtime surface.
- Startup must stale every durable review lacking an active operation before commands
  become usable.
- Review operations must not accidentally inherit broader verification-time request
  admission permitted for disabled or paused lifecycle states.
- Configuration retirement must not replace the long-lived `MirrorStateOwner` or
  discard unknown-effect evidence.
- A timer must never keep a review current or turn failure into an infinite retry.

## Security and privacy risks

- Remote and recovery Markdown is untrusted and must remain inert.
- Conflict copies are sensitive plaintext; warn before writing and never open them
  automatically.
- Secret lookup belongs only at the dispatch-time transport boundary, never UI code.
- Destination and path values require core validation before display-driven mutation.
- Notices and status use fixed typed messages, never raw exceptions.
- Review bodies must not survive close, refresh, unload, connection retirement, or
  process restart.
- Association, writer, operation, and review IDs are identity, not authorization.
- Generated artifact tests must detect accidental body, token, machine-path, raw
  filesystem, or private-key leakage.

## Explicit non-goals

- Policy in commands, modals, settings, status, or event adapters.
- Automatic review refresh or polling.
- Automatic remote-to-local import or equal-text adoption.
- Automatic merge.
- Local delete, rename, move, or trash.
- New Worker/API/OpenAPI/CORS behavior.
- Multiple writers, election, leases, or automatic takeover.
- Rendering or executing note content.
- Automatic cleanup of preservation files.
- Deployment, personal-vault installation, or production-readiness claims.

---

# Dependency split

## Work that can proceed once Slices 4–5 are merged

The following is relatively independent of Slice 4–5 internal implementation, but the
merged public contracts must still be inspected first:

- Pure rename-group graph/closure tests and lexical reservation policy.
- Current-evidence history classification tests.
- No-effect retain/defer transition tests.
- Text-only modal components and malicious-content rendering tests.
- Session-scoped command guards and modal cleanup behavior.
- Content-free status projection tests.
- Observation-generation invalidation wiring for ordinary external events.
- Registry and session lifecycle tests that do not execute action services.

## Work that MUST wait for final merged Slice 4–5 APIs

- Actual `RenameHistoryResolutionService` phase routing.
- Remote source-cleanup dispatch, exact receipt evidence, and restart recovery.
- Shared M3/M4 scheduler ownership.
- Operation completion and baseline-finalization helpers.
- Restore selection and successor-ownership UI commands.
- Runtime resume/wake surface for partial M4 operations.
- Own-write event consumption and durable binding to local-effect settlement.
- Final command result and status discriminants.
- Construction of the complete runtime service graph in
  `mirror-runtime-factory.ts`.

No speculative interface in this document should be implemented ahead of those merged
contracts.

---

# Contract gaps discovered before Slices 4–5 implementation

Every gap below must be revalidated against the final merged Slice 4–5 source and
tests before changing a contract. A merged slice may change, narrow, or eliminate a
gap. Finding a gap here is not permission to alter accepted product policy.

## 1. History decision payload is not expressive enough

**Why it matters:** Slice 6 must distinguish retaining notes independently, selecting
a specific remote cleanup, choosing a current canonical mapping, handling a chain, or
deferring. A kind-only action cannot durably prove which explicit current-state choice
the operator made.

**Current cause:** `ResolveHistoryReconciliationAction` in
`packages/core/src/mirror/reconciliation-state.types.ts` contains only
`kind: "bounded-history-decision"`. `ReconciliationAdmissionRequest` can carry an
action and at most one destination path, not a grouped history choice or mapping.

**Blocks:** Slice 6 admission, state validation, restart recovery, and Slice 7 history
modal command construction.

**Possible Slice 4–5 effect:** The final resolution coordinator or action contracts may
introduce a generic step/decision payload that removes the need for a separate history
shape.

**Required follow-up:** Revalidate against merged Slices 4–5 before adding or changing
any action discriminant, payload, codec, or validator.

## 2. Grouped completed steps are not durably representable

**Why it matters:** The accepted plan says a grouped operation persists every reserved
path and completed step. Without per-step evidence, restart cannot distinguish a
completed cleanup from a step that is pending, ambiguous, or not dispatched.

**Current cause:** `ReconciliationOperation` has one operation-wide `phase`, one
`localEffect`, and one `remoteEffect`. It has no typed bounded step ledger or per-path
effect evidence.

**Blocks:** Slice 6 multi-step chains/overlaps, exact restart, and Slice 7 partial-group
status.

**Possible Slice 4–5 effect:** Their merged phase-routing or effect-evidence model may
add reusable bounded step state, or may establish a safe decomposition into linked
single-effect operations.

**Required follow-up:** Revalidate the merged state model and validators before adding
step fields or changing operation granularity.

## 3. Multiple same-side preservation artifacts collide

**Why it matters:** A grouped decision may need to preserve more than one remote
source, or more than one local competitor, before multiple selected effects. Every
version that will be replaced or tombstoned must survive independently.

**Current cause:** `createReconciliationPreservationPath` generates exactly
`.ai-bridge-conflicts/<operation>/local.md` or `remote.md`. Multiple receipts for the
same side but different original paths would target the same file.

**Blocks:** Slice 6 grouped cleanup where more than one version requires preservation.
It may also affect final Slice 4 keep-both composition if one operation can materialize
multiple same-side competitors.

**Possible Slice 4–5 effect:** The merged implementation may constrain each operation
to one preservation per side, introduce linked child operations, or add a safe
locally-generated artifact discriminator.

**Required follow-up:** Revalidate actual merged operation granularity and preservation
contracts before changing path generation. Never interpolate a remote/source path into
the archive tree.

## 4. Preservation dispatch currently selects only by side

**Why it matters:** Even if state could record multiple remote preservation
requirements, execution must select the exact original path/revision/hash to preserve.
Side alone is ambiguous.

**Current cause:** `ConflictPreservationRequest` contains `operationId`, `side`, and
content. `ConflictPreservationService.authorize()` finds the first requirement whose
`side` matches, and the writer request also carries only operation and side.

**Blocks:** Slice 6 grouped preservation and exact restart adoption for multiple
same-side artifacts.

**Possible Slice 4–5 effect:** The final preservation orchestration may introduce an
exact requirement ID, path-bound command, child operation, or otherwise eliminate
multiple requirements per operation.

**Required follow-up:** Revalidate merged preservation APIs before adding selectors.
Any selector must remain derived from admitted evidence and must not permit a
caller-supplied archive path.

## 5. Current history action forbids local effects while some mapping designs may require them

**Why it matters:** The accepted history matrix allows explicit current mappings to an
existing or new destination, but M4 also forbids local rename/delete. Some possible
mapping interpretations could require eligible local creation or replacement. The
implementation must not guess whether those are one history operation, linked ordinary
actions, or operator-performed host changes.

**Current cause:** `validateActionPhase` rejects local mutation/effect state for
`resolveHistory`, and `validateCompletedEffects` permits history completion only with
no effects or a remote confirmed effect.

**Blocks:** Slice 6 choices involving a new destination and Slice 7 presentation of
only truly executable history actions.

**Possible Slice 4–5 effect:** The final live-resolution/restore services may provide a
linked-operation ownership model that safely decomposes mapping into existing actions,
eliminating any need for history-local effects.

**Required follow-up:** Revalidate merged action composition. Do not broaden history
local authority or add local rename/delete. Surface any remaining semantic ambiguity
instead of choosing policy in code.

## 6. History group discovery is only direct, not transitive

**Why it matters:** Chains and overlapping renames require one immutable snapshot and
reservation set covering every involved path. Sampling only an immediate destination
can omit a path whose change should stale the decision.

**Current cause:** `ReconciliationReviewService.reviewPaths()` adds the target path,
caller-provided related paths, optional destination, and only the target entry's direct
rename destination. It does not derive the transitive closure of rename edges.

**Blocks:** Slice 6 grouped evidence/admission and Slice 7 accurate grouped detail
presentation.

**Possible Slice 4–5 effect:** Their merged review or resolution facade may add an
authoritative related-path policy or generic operation-group sampler.

**Required follow-up:** Revalidate merged discovery APIs before adding a history-group
policy. UI-supplied path lists must never become the semantic owner.

## 7. Extending the currently closed v3 contract requires an explicit compatibility decision

**Why it matters:** Fixing gaps 1–5 may require new durable fields or variants. Strict
v3 codecs, validation, runtime-owner structural compatibility, and downgrade behavior
must remain coherent; old code must not silently ignore partial history state.

**Current cause:** Slice 1 documents its authority/action/state contract as closed,
uses strict version-3 codecs, and sets runtime/registry structural versions to 3.
Slices 2–3 already construct non-empty reconciliation records in tests even though no
UI composes them.

**Blocks:** Any Slice 6 state-shape change and potentially Slice 7 registry surface
changes.

**Possible Slice 4–5 effect:** Their implementation may already refine v3 with the
necessary generic phase/step fields and structural runtime methods, eliminating this
gap or defining the compatible extension method.

**Required follow-up:** Revalidate codecs, migration, validators, runtime registry,
and actual reachable state after Slice 5. Do not silently append incompatible fields
or increment/reuse a version without an explicit compatibility analysis consistent
with ADR 0008.

## 8. Shared/global M3+M4 scheduler ownership is unresolved

**Why it matters:** Accepted behavior requires bounded work and unrelated-path
progress. A private M3 scheduler plus an independent M4 scheduler could exceed the
intended global two-job bound or produce inconsistent fairness, even if network
permits remain separately bounded.

**Current cause:** `MirrorSynchronizer` privately constructs its own
`FairMirrorScheduler`. `MirrorRequestGate` limits remote request permits, but there is
no shared M3+M4 job scheduler/composition boundary.

**Blocks:** Slice 6 multi-path execution and Slice 7 runtime composition/timers.

**Possible Slice 4–5 effect:** Final action orchestration may introduce a shared
scheduler/admission owner, expose the existing scheduler safely, or establish another
single global bound.

**Required follow-up:** Revalidate merged runtime and coordinator construction before
creating any M4 scheduler. Do not create a parallel unbounded or independently capped
engine by default.

## 9. Own-write event consumption lacks durable identity

**Why it matters:** Slice 7 must consume the host event caused by an exact M4 local
write without granting ordinary M3 outward authority, while preserving an external or
same-text successor event. Path and timing alone cannot distinguish those cases.

**Current cause:** `ReconciliationOperation` records effect certainty but no consumed
observation generation or expected own-event identity. `ObsidianMirrorEvents` routes
primitive events directly to `MirrorRuntimeOwner`, and current M3 event handling has
no M4-local-effect association.

**Blocks:** Slice 7 own-write consumption, restore fencing, exact successor-event
handling, and safe reservation release.

**Possible Slice 4–5 effect:** Local-resolution or restore orchestration may add exact
post-write observation/effect metadata or a runtime event-consumption protocol.

**Required follow-up:** Revalidate final local-effect and restore state before adding
any event field. Do not use a timeout, path-only suppression set, or generic "ignore
next event" flag.

## 10. Session-scoped review invalidation is missing

**Why it matters:** Modal close, refresh, unload, and session replacement must discard
sampled bodies and revoke only the relevant ephemeral authority without disrupting an
already admitted durable operation.

**Current cause:** `ReconciliationReviewService.invalidate()` invalidates all open
reviews. It can refresh one review but exposes no explicit close-review or
invalidate-session command. `ReconciliationReviewQuery` also omits the full mutation-
free review command surface needed by a typed runtime facade.

**Blocks:** Slice 7 modal lifecycle, concurrent presentation tests, and clean
separation between session UI and owner-lifetime work.

**Possible Slice 4–5 effect:** Their final facade may introduce session-scoped review
ownership or a complete review command interface.

**Required follow-up:** Revalidate merged review APIs before adding methods. Session
invalidation must clear transient bodies and must not stale or cancel an admitted
operation merely because its modal closes.

## 11. Startup staling of orphan durable reviews is documented but not composed

**Why it matters:** A persisted read-only review without an active operation must not
become executable after process restart. Commands must not become available before
that durable stale transition is settled.

**Current cause:** The specification and ADR 0008 require startup staling, and state
validation supports stale review status, but current startup composition loads v3 and
constructs `MirrorStateOwner` without a dedicated transition that marks orphan durable
reviews stale.

**Blocks:** Slice 7 startup command enablement and A9 restart evidence. It may also
block any earlier slice that begins persisting standalone durable reviews.

**Possible Slice 4–5 effect:** Their startup/resume coordinator may compose this
transition or prove that their reachable state always pairs durable reviews with
operations.

**Required follow-up:** Revalidate reachable merged state and startup flow before
adding a transition. Preserve valid active operations and never delete evidence to
make state load.

## 12. Recovery selection does not yet expose a UI-ready bounded query

**Why it matters:** The restore command needs a bounded list of selectable recovery
metadata and must bind the chosen exact recovery ID/revision/status/hash to a review.
A path-only candidate union cannot populate or safely refresh that selection surface.

**Current cause:** Slice 2's `discover()` uses bounded recovery inventory to add paths
to the candidate union, but `ReconciliationDiscoveryResult` does not expose recovery
metadata entries. `createReview()` accepts a `recoveryId`, assuming a caller already
has an exact selection.

**Blocks:** Slice 7 recovery selection modal and exact restore command construction.

**Possible Slice 4–5 effect:** Slice 5 is expected to implement recovery restore and
may add the necessary bounded selection query/projection.

**Required follow-up:** Revalidate the final merged Slice 5 recovery service before
adding another query. Reuse its exact validation and bounds; do not let the UI query
`RemoteBridge` directly or infer restore authority from list results.

---

## Handoff rule

Before implementing Slice 6 or Slice 7:

1. update to the final clean merged main containing Slices 4–5;
2. reread the M4 specification, canonical implementation plan, ADRs 0005–0008, and
   the complete merged Slice 4–5 source/tests;
3. re-evaluate every dependency, proposed module, and all twelve gaps above;
4. remove or revise observations already resolved by merged code;
5. surface any remaining contract contradiction without inventing product policy;
6. implement only under an explicit production implementation request.
