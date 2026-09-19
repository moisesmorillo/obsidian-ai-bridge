# M4 implementation plan — reviewed reconciliation and conflict resolution

**Status: M4 Slices 1–7 implemented; Slice 8 is NEXT.** M4 remains the single
`NEXT` milestone. Slices 1–5 establish contracts, reviewed admission, preservation,
local effects, and live/adoption/tombstone/restore execution. Slices 6–7 implement
[ADR 0009](../decisions/0009-m4-history-runtime-and-device-state-v4.md) as one strict
version-4 compatibility transition: bounded history execution plus shared runtime,
session, command, modal, and status composition. Do not deploy or install into a
personal vault as validation; Slice 8 owns qualification.

[Specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
and [ADRs 0005–0009](../decisions/README.md) are normative. Preserve every completed
M3 invariant and its current executable contracts. The eight slices follow dependency
and safe-exposure boundaries—state, read policy, local effects, live resolution,
tombstone/restore, history, host composition, and qualification—not an arbitrary
slice target.

## Execution rules

- Work sequentially. Each slice starts with the listed failing behavior tests where
  practical and ends green before the next slice.
- Do not expose a local mutation command until its durable intent, preservation,
  stale-decision, restart, unknown-effect, and session-lifecycle behavior exists.
- Keep core free of Obsidian, HTTP/Fetch, Hono, Cloudflare, R2, filesystem, and UI
  types. Keep `ReadOnlyLocalVault` unchanged.
- Keep one semantic owner for every decision table. The runtime facade may coordinate
  but may not absorb classification, preservation, action, migration, and UI policy.
- Use only current v2 Worker operations. A discovered need for a new wire operation
  stops the slice and requires a successor ADR/spec review before implementation.
- No note body enters device state, data.json, logs, handoff, status, or fixtures that
  could leak into the generated artifact. No plugin local rename or hard delete.
- Focused validation uses `mise run ...`; each slice handoff runs `mise run check`.
  Preserve production-source coverage inclusion and thresholds: 95% lines/statements,
  94% functions, 90% branches.

## Slice 1 — Closed contracts, state v3, and migration fence — IMPLEMENTED

### Objective and prerequisites

Establish typed M4 authority/evidence/operation state and deterministic M3 v2→M4 v3
migration without exposing M4 behavior. Read the current core mirror state/constants/
validation/owner, strict plugin codec/store, runtime registry, handoff codec, and all
state tests first.

### Tests first

- Every closed authority, classification, review status, operation action, phase,
  preservation receipt, and local/remote effect variant validates exhaustively.
- Invalid phase/action combinations, duplicate review/operation IDs, overlapping path
  reservations, invalid tracked/new-destination references, body-like fields, invalid
  paths/revisions/hashes, and capacity overflow fail.
- Every valid M3 lifecycle, acknowledgement, unresolved mutation phase/budget,
  blocker, delete evidence, rename-deferred phase, and staged handoff migrates exactly.
- Migration performs one same-key save, then read-back; save/read/integrity/quota
  failures fail closed without runtime publication or network/local access.
- Re-running from valid v2 is deterministic; valid v3 loads; version 1/future/corrupt
  data remains unsupported/untouched.
- Old M3 decoder refuses v3. Same-realm old/new runtime-owner versions refuse each
  other. Handoff states do not activate; active M4 operation blocks export.
- Maximum 50,000 M3 paths migrate without per-path M4 field growth; sparse bounded
  reviews/operations remain linear and within the version-3 codec limit.

### Likely production modules

- `packages/core/src/mirror/reconciliation-*.types.ts`
- `packages/core/src/mirror/reconciliation-state.constants.ts`
- `packages/core/src/mirror/reconciliation-state-validation.ts`
- existing mirror state types/validation/owner/public exports
- `apps/obsidian-plugin/src/state/device-state-v2.codec.ts` as a frozen decoder
- version-3 codec/migrator/store startup boundary
- runtime-owner registry version/composition

Do not put runtime constants in `*.types.ts`. Keep migration mechanics in the adapter
and cross-field invariants in core.

### Completion evidence

Implemented modules separate core contract types/constants, core cross-field
validation, the frozen plugin v2 decoder, current v3 codec, deterministic migrator,
and adapter startup persistence boundary. State/registry versions are 3. The corrected
contract uses one immutable content-free review snapshot for runtime/configuration/
listener, per-path local/ACK/remote/M3, exact receipt, and recovery identity; operations
copy and must exactly match that snapshot. The central validator derives required
preservation side/revision/hash from sampled evidence, persists an active
`restored-pending-review` fence, requires linked reviewed successor ownership before a
restore becomes terminal, and excludes active reservations from ordinary M3
scheduling. Focused tests cover every closed set, classification/action/phase and
preservation compatibility, association/path relationships, stale-identity dimensions,
strict/body-free codecs, migration fidelity across M3 state variants, deterministic
retry and exact read-back barriers, downgrade/registry refusal, handoff interaction,
capacity overflow, and exact 50,000-path migration with empty sparse M4 collections.

The migration and state-relationship matrices are recorded in the milestone's
[Slice 1 evidence](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md#slice-1-implementation-evidence). Slice 2 and Slice 3 evidence are recorded in the
milestone's [Slice 2 implementation evidence](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md#slice-2-implementation-evidence) and
[Slice 3 implementation evidence](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md#slice-3-implementation-evidence).
The final canonical source suite passes 64 files / 880 tests with 95.00% statements,
91.35% branches, 98.47% functions, and 96.98% lines. The final diff contains no UI
command/modal/settings action, local writer, Fetch/RemoteBridge or Worker/API/OpenAPI
change, deployment configuration, timer, scan, or runtime M4 mutation capability.

## Slice 2 — Read-only review engine and stale-decision policy — IMPLEMENTED

### Objective and prerequisites

After Slice 1, implement bounded evidence sampling and pure classification without any
new mutation capability.

### Tests first

- Table-test every classification with local, ACK, remote, recovery, unresolved M3,
  deferred history, and availability precedence.
- Equal text with a different revision is not aligned. Remote physical absence is not
  a tombstone. Startup absence is not authority.
- Hold remote reads while local create/modify/delete/rename events occur; sampled
  review becomes stale.
- Same-text local event ABA changes observation generation; remote ABA changes
  revision. Listener epoch/configuration/runtime replacement/restart invalidates open
  reviews.
- Candidate union covers ledger/local/visible-remote/recovery-metadata paths so hidden
  tombstones are inspectable; bounded note/recovery pages, malformed DTO/content,
  oversized bytes, failed local stable read, missing designation/secret, and
  incomplete inventory produce sanitized non-authoritative outcomes.
- No review/read operation calls any mutation port or changes ACKs/intents.

### Likely production modules

- core `divergence-classifier.ts`, `review-evidence-policy.ts`,
  `reconciliation-decision-policy.ts`, and contracts
- plugin `reconciliation-review-service.ts` using existing `ReadOnlyLocalVault`,
  `RemoteBridge`, observation epoch, and state owner
- sanitized review/status projections only; no modal action wiring yet

The classifier owns the complete local+baseline+remote precedence table. The decision
validator owns evidence equality and stale reasons. Do not duplicate either in UI or
the coordinator.

### Completion evidence

Decision-table, same-text observation, refresh, and admission revalidation tests pass;
review remains read-only and unexposed behind a core composition seam. Candidate and
recovery inventory failures remain sanitized and non-authoritative. Canonical check
and semantic review of stateful ownership are required before the slice is complete.

## Slice 3 — Narrow local mutation and conflict preservation — IMPLEMENTED

### Objective and prerequisites

After read-only evidence exists, implement the separate local mutation port, Obsidian
adapter, generated conflict paths, and archive-first preservation. Do not yet expose
resolution buttons.

### Tests first

- Create eligible note: exact absence, path/privacy/UTF-8/1 MiB limits, file/folder
  collision, parent collision, failure before effect, ambiguous effect, post-read hash.
- Atomic replace: `Vault.process` exact expected text; concurrent change inside the
  barrier refuses; post-write verification; same-text event generation still stale.
- Preservation: fixed `.ai-bridge-conflicts/<uuid>/<side>.md`, no remote-path
  interpolation, reusable root folder but create-only operation folder/side files,
  file/config-root and receipt collision refusal, content hash proof, and dot-segment
  exclusion from mirror.
- Prove local rename/delete/move are absent from the port. A concurrent operator host
  rename/delete invalidates review and is handled only by a fresh observation; no hard
  delete/trash/move-to-archive fallback exists.
- Persist intent before effect; preservation receipt after proof; persistence failure
  before/after host effect; restart reconciliation with no body in state.
- Malicious paths, HTML/Markdown/instruction text, invalid UTF-8 boundary data, and
  oversized content remain inert/refused.

### Likely production modules

- core `local-reconciliation-writer.port.ts` and closed result/request types
- core `conflict-preservation-service.ts` and operation phase transitions
- plugin `obsidian-local-reconciliation-writer.ts` plus a minimal host capability
  interface using official `create`, `createFolder`, `process`, and reads
- dedicated unit/integration host doubles; no raw filesystem/Node adapter

Keep `ObsidianLocalVault` and `ReadOnlyLocalVault` unchanged. The application owns
where preservation is required; the adapter owns host mechanics and effect evidence.

### Completion evidence

Implemented core writer contracts expose only create-eligible, replace-eligible, and
create-preservation. `ConflictPreservationService` and
`LocalReconciliationWriteService` bind dispatch to active operation/action/path/phase/
reservation/evidence, persist pending state before host effects, settle only verified
postconditions, retain unknown certainty, and support exact same-operation recovery.
The official Obsidian adapter uses only narrow lookup/create/createFolder/read/process
host operations, creates fixed generated archive paths component-by-component, applies
exact comparison inside `Vault.process`, and rereads identity/text/hash. Focused tests
cover collision and concurrency matrices, persistence barriers, receipt lifecycle,
restart recovery, event fencing, path/privacy/size checks, inert content, and the
absence of rename/delete/move/generic Vault capabilities. Existing M2/M3 tests remain
green. No user-facing M4 action or remote effect is composed.

## Slice 4 — Revisioned adoption and live/live resolution — IMPLEMENTED

### Objective and prerequisites

Compose archive-first Keep local, Use remote, Keep both, defer, and exact format-2
adoption through action-specific core services. Continue to keep UI unexposed.

### Tests first

- Unknown format-2 live + local absent creates local then adopts exact revision.
- Same local bytes require explicit decision and exact revision; equality alone does
  nothing. Different bytes enter conflict policy.
- Keep local: remote archive before conditional PUT; remote changes before admission,
  after archive, and at CAS; local successor event after admission while PUT is
  pending; lost ACK/exact receipt; stale receipt mismatch.
- Use remote: local archive before atomic replacement; local edit at each barrier;
  remote successor after the final evidence point while local replacement is pending;
  local success/state-save failure; restart exact hash+remote revision proof.
- Keep both for each primary side: chosen alternate local/remote absence, archive,
  partial copy, collision, exact absence-only alternate remote ACK, event suppression,
  and release into aligned normal M3 ownership.
- Manual local edit invalidates the review; a fresh Keep local can publish merged
  bytes. No automatic merge code exists.
- Legacy source supports only preserve/export/fork to a different locally/remotely
  absent path; same-path/equal-text adoption and normalization are unrepresentable.
- Path A blocked in every phase while path B progresses within existing bounds.

### Likely production modules

- core `revisioned-adoption-service.ts`, `live-resolution-service.ts`,
  action-specific state transitions, and a thin `resolution-coordinator.ts`
- existing RemoteBridge/intent/evidence helpers reused without changing transport
  policy or refreshing baselines
- runtime path reservations extended to M4 operation ownership

The coordinator routes durable phases. It does not reimplement classifier, evidence
comparison, preservation, ACK matching, or local adapter mechanics.

### Completion evidence

Core now composes archive-first Keep local, Use remote, both Keep both primary-side
orders, exact format-2 adoption, and safe different-path legacy forks through focused
action services and one typed coordinator. One shared effect executor owns exact
local/remote evidence reads, receipt-based unknown-effect recovery, conditional remote
dispatch, atomic baseline completion, and sanitized finite results. Tests cover exact
surviving bytes/revisions, alternate-path absence, collisions, stale evidence,
conditional refusal, persistence fencing, and lost-response recovery. Existing v2
API remains unchanged, and no plugin runtime or end-user command is composed.

## Slice 5 — Remote tombstone review and local-first recovery restore — IMPLEMENTED

### Objective and prerequisites

After live resolution is safe, implement all tombstone rows and richer restore using
the same preservation and stale-decision owners.

### Tests first

- Exact local absence + remote tombstone adopts only after operator decision; startup
  absence alone does nothing.
- Live unchanged/modified/recreated local state versus tombstone: preserve/copy/defer,
  exact conditional recreate, stale local/tombstone evidence, partial hydration block,
  and no plugin delete or rename-as-delete. Operator removal requires a new absent-path
  review before tombstone adoption.
- Local delete event/M3 unresolved mutation wins over M4; remote edit/tombstone races
  preserve current heads and recovery.
- Recovery prepared/unexpired sealed accepted; missing/expired/purged/changed refused;
  content hash/UTF-8/size/status validated.
- Restore original/alternate absent paths, occupied destination archive+replace,
  excluded/invalid/oversized/folder collisions, rename while review pending, host
  failure/unknown, persistence failure after local write, and process restart.
- Restore marks `restored-pending-review` and a synthetic effect observation before
  write; every official host event remains conservative successor evidence and no
  remote mutation occurs. Follow-up recreation/publication requires a new explicit
  review.
- All GETs remain read-only; seal/purge semantics remain M3 maintenance only.

### Likely production modules

- core `remote-tombstone-resolution-service.ts`, `recovery-restore-service.ts`, and
  action/state transition tests
- plugin review service reuse of existing recovery RemoteBridge methods
- no Worker source or protocol change unless a separately reviewed contradiction is
  found; such a contradiction stops implementation

### Completion evidence

Core now executes explicit absent-only tombstone adoption, preserve-first exact
recreation, and local copy to an independently absent path without any local delete or
rename capability. Recovery restore revalidates prepared/unexpired sealed metadata and
content, preserves an occupied destination first, persists the
`restored-pending-review` fence before the local write, and performs no remote
mutation. Serialized successor admission can atomically transfer the restored path
from the completed restore to a fresh reviewed operation; alternate restored paths
receive an explicit absence-only Keep local publication decision across restart.
Focused tests cover stale,
expired, unavailable, changed, collision, persistence, restart, and receipt-recovery
paths. Worker/API/OpenAPI code remains unchanged; no runtime/UI composition exists.

The [non-normative Slices 6–7 implementation preparation](m4-slices-6-7-implementation-preparation.md)
records pre-Slice-4/5 handoff analysis, test matrices, dependencies, and contract gaps.
Revalidate it against the final merged Slices 4–5; it does not amend this plan, the
M4 specification, or accepted ADRs.

## Slice 6 — Device-state v4 and deferred rename/history resolution — NEXT

### Objective and prerequisites

First cross the explicit version-3→4 compatibility fence, then resolve M3's deliberately
preserved complex rename/history blockers by current exact evidence. ADR 0009 is
normative. Do not add automatic reconstruction, local history effects, linked child
operations, or multi-key atomic claims.

### Contract sequence

1. Freeze the merged strict v3 decoder. Add strict v4, deterministic same-key
   v3→v4 migration, exact read-back, 12 MiB v4 bound, and non-empty v3 M4-state
   fixtures. Build this checkpoint first, but do not publish or save v4 from the plugin
   until Slice 7 completes the version-4 owner/registry surface in the same
   implementation PR. Migrated active v3 history and unfenced local effects remain
   conservative blockers; no decision/event evidence is inferred.
2. Add `RenameHistoryGroupPolicy` as the sole durable-edge closure owner. It derives
   the bounded lexical group and validated current-discovery candidates; UI/caller path sets never
   define authority.
3. Admit one closed retain/defer/execute-cleanup decision into one parent operation
   that atomically reserves the complete group and owns a bounded ordered step ledger.
   Give each step a globally unique UUID-v4 that is also its exact Worker v2 mutation/
   recovery operation ID; never reuse the parent ID across remote tombstones.
4. Generate history archives only as
   `.ai-bridge-conflicts/<operation>/<step>/<side>.md`, with UUID-v4 operation/step
   components and evidence-derived receipts.
5. Let `RenameHistoryResolutionService` select the next step while the existing shared
   effect executor performs one exact recovery-first conditional remote tombstone.
   Persist exact completion before advancing; unknown/refused/stale blocks later steps.
6. Clear only the reviewed deferred blockers after every selected step is proven.
   History never performs a local create/replace/rename/delete/move.

### Tests first

- Strict v3→v4 migration of non-empty reviews, live/adoption/tombstone/restore/history
  operations, receipts, successor links, confirmed/unknown effects, exact encoded-size
  boundaries, and oversized atomic refusal; history step effects and non-history
  aggregate effects cannot coexist; every save/read-back/version/registry failure
  remains closed.
- Exact destination prerequisite + unchanged source permits step-scoped preservation
  then recovery-first source cleanup.
- Duplicate source/destination live generations: keep independent, choose only an
  evidence-derived existing canonical path, or complete selected remote cleanup.
- Rename chains, overlaps, cycles and shared destinations mutate while grouped review/
  read/commit barriers are open; the whole pending decision stales and every generation
  survives.
- Remote former-source edit invalidates cleanup. Locally recreated source is
  independent. Destination later moved/edited invalidates prior mapping. Any local
  restructuring happens outside the plugin and forces a fresh ordinary review.
- Caller candidate/path replay, omission, expansion and unrelated-path injection fail.
- Multiple same-side artifacts are unique; wrong step/path/revision/hash/receipt and
  existing-folder collisions fail without effect. A plan exceeding remaining receipt
  capacity or the prospective 12 MiB state budget is refused atomically.
- Restart at each step phase resumes the exact current step; completed steps never
  replay; unknown blocks later steps; unrelated paths continue.

### Production semantic owners

- strict v3 decoder, v4 codec/migrator/store startup boundary;
- `rename-history-group-policy.ts` — transitive durable graph and candidate derivation;
- `rename-history-resolution.types.ts` — closed decisions, steps and results;
- `rename-history-resolution-service.ts` — next-step transition policy;
- `reconciliation-preservation-policy.ts` and `ConflictPreservationService` — exact
  step requirement and create-only artifact proof;
- `ReconciliationEffectExecutor` — mechanical remote evidence/effect settlement only;
- `MirrorStateOwner` — serialized persistence and global fencing.

Do not call `MirrorDeletionExecutor` under history authority and do not add a second
remote cleanup implementation.

### Completion evidence

Every v4 migration and history matrix row has barrier tests. The complete group stays
reserved, exact steps are auditable and bounded, no arbitrary history list/body queue/
server transaction/compensating delete/new API exists, and canonical validation plus
policy-ownership review pass.

## Slice 7 — Runtime, commands, modal, and status composition

### Objective and prerequisites

Only after Slice 6's core/state-v4 checkpoint is safe, expose the thin operator review
surface through the existing same-realm owner/session/settings/status architecture.
Slices 6–7 form one compatibility transition and implementation PR: plugin v4
migration/publication is enabled only with this complete version-4 owner/registry
surface. Runtime composition follows ADR 0009 and adds no new authority.

### Contract sequence

1. Move process scheduler ownership to one long-lived `FairMirrorScheduler` held by
   `MirrorRuntimeOwner`; inject it into M3 and M4. It retains the two-job global bound
   and grants no durable authority.
2. Compose `ReviewedReconciliationRuntime` as event/operation sequencing owner. A
   locally generated durable synthetic effect ID plus exact postcondition proves an
   M4 local write. Every official Vault event remains external successor evidence;
   there is no ignore-next, timing, or path-only suppression. A bounded durable
   successor range and queue barrier force a fresh linked review before release when
   any event was observed while reserved. Exact aligned evidence settles with no effect;
   otherwise an ordinary admitted successor atomically takes ownership.
3. Add `closeReview` and `invalidateSession` to `ReconciliationReviewService`; discard
   transient bodies without touching admitted durable operations.
4. Run `ReconciliationStartupService` against an unpublished owner before commands or
   listeners. Stale orphan durable reviews in one serialized transition; preserve valid
   operation pairs; save failure prevents publication.
5. Expose the review service's bounded content-free recovery selection query, including
   prepared, sealed-active, sealed-expired, purged and incomplete results. Listing
   never fetches content; review creation re-inspects exact selected metadata.
6. Add thin commands, text-only modal/previews, recovery selection, and content-free
   status projections. UI submits typed identities and never derives policy.

### Tests first

- Commands register without changing M2 commands or enabling network/local mutation
  when unconfigured, non-writer, incompatible, state-unavailable, or not layout-ready.
- Combined M3+M4 jobs never exceed two; overlapping paths refuse; unrelated work
  progresses; detach retains reservations through actual settlement.
- Local effect preparation/postcondition and Vault events are ordered. Every host event,
  including same-text create/modify, remains successor evidence; delete/rename is never
  consumed; queued events settle before reservation release. Fresh exact alignment
  closes predecessor/review atomically with no effect; non-aligned paths stay reserved
  until a linked ordinary successor takes ownership.
- Closing one review/session clears only its bodies and authority. Double click,
  refresh, stale UI, unload/re-enable, owner replacement, and restart cannot reuse it;
  admitted operations survive.
- Startup stales every orphan before command availability, preserves active/terminal
  pairs, and fails closed on persistence error without network/local access.
- Recovery listing is bounded/content-free and truthfully represents status/expiry/
  incompleteness; selection metadata change makes the review stale.
- Bounded list/detail modal renders malicious Markdown literally using no Markdown
  renderer/HTML insertion. Bearer/raw errors/storage internals/bodies do not enter
  status, notice, logs, serialization, or artifact fixtures.
- Hold local read/remote request/local mutation/state save while unloading/replacing
  the Plugin. Owner work settles; old session cannot present or mutate.
- One-shot timers schedule only finite persisted work; there is no review polling loop.

### Production semantic owners

- `MirrorRuntimeOwner` — compatible long-lived composition and one scheduler;
- `FairMirrorScheduler` — process concurrency/fairness only;
- `ReviewedReconciliationRuntime` — operation/event sequencing and resume routing;
- `ReconciliationObservationGenerationOwner` — every external event generation;
- `ReconciliationReviewService` — review/session and recovery-query authority;
- `ReconciliationStartupService` — orphan-review transition;
- commands/modal/status — typed routing and text-only presentation only.

The settings tab may link to commands and show counts; it does not own policy or
render conflict bodies.

### Completion evidence

Focused unit/integration tests compose actual core services/adapters through host
callbacks. Responsibility inventory proves every transition has the owner above, the
runtime facade remains routing-only, and canonical check passes before Slice 8 artifact
work.

## Slice 8 — Artifact, operations, qualification, and completion gates

### Objective and prerequisites

Qualify the complete built behavior and synchronize current-state/operational/security
documentation without deployment or personal-vault installation.

### Generated artifact tests

Proportionally exercise the staged CommonJS bundle:

- command/modal registration and text-only malicious-Markdown preview;
- one exact review→archive→conditional resolution path with required v2 identity/
  revision headers and no v1/new route;
- stale session/local event/remote revision prevents mutation;
- local-first restore remains remote-read-only and pending review;
- same-realm replacement retains in-flight M4 operation and rejects incompatible
  registry versions;
- no token, fixture note/recovery/conflict body, Node import, raw filesystem API,
  private key marker, or machine path enters the artifact.

Do not duplicate every policy unit test in the artifact suite. Report real desktop,
mobile, iCloud, native-secret, and deployed Worker qualification exactly; absence is
not failure when the milestone does not authorize those environments.

### Documentation and operations

Update README/current-state/architecture/roadmap/spec/plan/ADRs, API only if actual
wire behavior changed, SECURITY, plugin development, and operations with:

- review/refresh/resolution runbook and conflict archive cleanup;
- tombstone acceptance/recreation and recovery restore procedures;
- version-2→3 migration, same-realm restart requirement, downgrade prohibition,
  unknown-effect recovery, and handoff blocking;
- explicit one-writer, privileged bearer, plaintext, untrusted Markdown, stale local
  evidence, host-atomicity, and no-production claims.

### Final validation

Run and record:

```bash
mise install
mise run install
mise run check
git diff --check
```

Also validate all Markdown file/heading links, exact single `NEXT`, production-source
coverage inclusion and all four thresholds, generated artifact leakage, tracked diff
for credentials/config/deployment, editor diagnostics, and no unauthorized service or
dependency. Inspect complete M3/M4 behavior for contradictions.

Run `/skill:code-review` after green automation. The review must reconstruct the M4
state/action/effect matrix and inspect authority gaps, silent loss, pseudo-atomicity,
hidden state machines, migration/rollback holes, duplicated semantic owners, and
unnecessary infrastructure. Fix every actionable finding and re-run both validation
and corrective review.

### Completion boundary

Record concrete A1–A12 evidence in the M4 specification. Only a completion PR with all
items satisfied may mark M4 COMPLETE and M5 NEXT. Do not merge automatically, deploy,
or claim personal-vault/production qualification.
