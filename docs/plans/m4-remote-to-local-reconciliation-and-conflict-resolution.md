# M4 implementation plan — reviewed reconciliation and conflict resolution

**Status: M4 Slices 1–3 implemented; Slices 4–8 remain planned.** M4 remains the
single `NEXT` milestone. Slice 1 adds contracts and the state/migration fence, Slice 2
adds the core-only read-only review/admission seam, and Slice 3 adds uncomposed narrow
local-effect and durable preservation primitives. It activates no M4 user behavior or
action orchestration. Do not deploy or install into a personal vault as validation.

[Specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
and [ADRs 0005–0008](../decisions/README.md) are normative. Preserve every completed
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

## Slice 4 — Revisioned adoption and live/live resolution

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

Every general harmful-decision matrix row has deterministic tests asserting exact
surviving bytes/revisions. Existing v2 API remains unchanged. Canonical check and a
stateful structural review pass; still no end-user command.

## Slice 5 — Remote tombstone review and local-first recovery restore

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
- Restore marks `restored-pending-review` before write and consumes own event without
  remote mutation. Follow-up recreation/publication requires a new explicit review.
- All GETs remain read-only; seal/purge semantics remain M3 maintenance only.

### Likely production modules

- core `remote-tombstone-resolution-service.ts`, `recovery-restore-service.ts`, and
  action/state transition tests
- plugin review service reuse of existing recovery RemoteBridge methods
- no Worker source or protocol change unless a separately reviewed contradiction is
  found; such a contradiction stops implementation

### Completion evidence

The complete tombstone matrix and restore workflow pass with exact byte/revision
assertions. API/OpenAPI semantic tests confirm no wire drift. Canonical check passes.

The [non-normative Slices 6–7 implementation preparation](m4-slices-6-7-implementation-preparation.md)
records pre-Slice-4/5 handoff analysis, test matrices, dependencies, and contract gaps.
Revalidate it against the final merged Slices 4–5; it does not amend this plan, the
M4 specification, or accepted ADRs.

## Slice 6 — Deferred rename/history resolution

### Objective and prerequisites

Resolve M3's deliberately preserved complex rename/history blockers by current exact
evidence, without adding automatic reconstruction or multi-key atomic claims.

### Tests first

- Exact destination prerequisite + unchanged source permits preservation then
  recovery-first source cleanup.
- Duplicate source/destination live generations: keep independent, choose canonical,
  or complete remote source cleanup, with preservation before each replaced/
  tombstoned side.
- Rename chains and overlaps mutate while grouped review/read/commit barriers are
  open; old decisions stale and every generation survives.
- Remote former-source edit invalidates old cleanup. Locally recreated source is an
  independent note. Destination later moved/edited invalidates prior mapping. Any
  local rename/removal required by an operator mapping happens outside the plugin and
  forces a new review.
- Insufficient history permits explicit current mapping/retain/defer only.
- Lexical multi-path reservation is deadlock-free; partial steps persist; restart
  resumes exact phase; unrelated paths continue.

### Likely production modules

- core `rename-history-resolution-service.ts` and grouped evidence/transition types
- reuse existing rename/deletion executors only through explicit safe primitives;
  do not broaden their ordinary M3 authority
- focused grouped-status projections

### Completion evidence

Every history matrix row has barrier tests. No arbitrary history list, body queue,
server transaction, compensating delete, or new infrastructure is introduced.
Canonical check and policy-ownership review pass.

## Slice 7 — Runtime, commands, modal, and status composition

### Objective and prerequisites

Only after Slices 1–6 are safe, expose the thin operator review surface through the
existing same-realm owner/session/settings/status architecture.

### Tests first

- Commands register without changing M2 commands or enabling network/local mutation
  when unconfigured, non-writer, incompatible, state-unavailable, or not layout-ready.
- Bounded list/detail modal displays sanitized metadata and text-only previews using
  no Markdown renderer/HTML insertion. Bearer/raw errors/storage internals/bodies do
  not enter status, notice, logs, or serialization.
- Every button emits one typed command with review/session ID; double click, close,
  refresh, stale UI, unload/re-enable, owner replacement, and process restart cannot
  reuse authority.
- Hold local read/remote request/local mutation/state save while unloading and
  replacing the Plugin instance. Runtime owner retains reservations/effect settlement;
  old session cannot display or mutate.
- One-shot timers only schedule existing finite work; no review polling/retry loop.
- M3 outward events on unreserved paths behave unchanged. Own M4 writes are consumed
  into their durable operation before path release.

### Likely production modules

- existing `MirrorRuntimeOwner` facade with a dedicated reconciliation owner rather
  than action policy methods
- `reconciliation-commands.ts`, `reconciliation-modal.ts`, text-only preview/status
  projections, recovery selection modal
- existing attachment epoch, request gate, wake scheduler, configuration admission,
  and plugin session composition

The settings tab may link to commands and show counts; it does not own policy or
render conflict bodies.

### Completion evidence

Focused unit/integration tests compose the actual core services/adapters through host
callbacks. Responsibility inventory proves the runtime facade remains routing-only.
Canonical check passes before artifact work.

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
