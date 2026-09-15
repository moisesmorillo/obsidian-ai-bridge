# M3 implementation plan — automatic eligible-Markdown mirror

**Status: Slices 0–4 implemented; Slice 5 is the next internal M3 work.
No connected user-visible mirror behavior.** PR #8 remains planning/documentation only. M2
merged at `b300726` (PR #7); M3 is the single NEXT
milestone. [Spec](../milestones/m3-remote-bridge-client-and-publishing.md),
[approved decisions/evidence](m3-design-decisions.md) and accepted design ADRs
[0002](../decisions/0002-conditional-remote-note-mutation.md),
[0003](../decisions/0003-publishing-association-and-local-state.md),
[0004](../decisions/0004-recoverable-mirror-deletions.md) supersede the old selected-note
proposal. No material product decision remains; acceptance is not implemented code.

## Execution rules

Implement sequentially, one coherent green slice at a time, after a separate request
to implement M3. No deployment or real-vault installation as validation. Keep M2
inspection behavior independent, inward boundaries, public aliases/exports, strict
closed types, useful TSDoc, dedicated test trees and production coverage inclusion.
No selected flags, durable note-body queue, local note mutations or M4 code.

Each slice starts with the listed failing behavior tests where practical. Use
`mise run test` for focused tests, then `mise run lint`, `mise run typecheck`,
`mise run biome:check`; `mise run check` at handoffs covers coverage/build too.
Preserve 95% lines/statements, 94% functions, 90% branches. Record **actual** evidence
below during future implementation; this plan does not claim its future tests ran.
A1–A11 refer to the spec checklist. Stop on a failed platform safety assumption;
fix/review it rather than silently use old APIs or invent a new product policy.

## 0. Qualify conditional storage and host primitives

- **Objective/dependency:** prove the documented foundation before mutation behavior.
  Read current Worker `infrastructure/r2.types.ts`, installed Workers types,
  `wrangler.jsonc`, `.mise.toml`, plugin manifest/types/artifact suite and official
  source references in the decision brief.
- **Changes:** narrowly scoped local Miniflare/workerd integration harness and
  `worker:storage-test` mise task wired into canonical check if a separate runner
  is needed. Declare an aligned direct dev dependency if needed, not a transitive
  import or new deployed service. No production mirror composition.
- **Tests first:** constructed Headers If-None-Match:* accepts once, refused PUT
  returns null, matching/stale ETag CAS, same text/new embedded revision yields a
  different validator, R2 uploaded timestamp on actual successful put. Exercise
  current and recovery-object CAS, not native physical DELETE.
- **Host checks:** official Vault lifecycle, SecretStorage/SecretComponent,
  loadLocalStorage/saveLocalStorage, declarative settings and standards Fetch
  redirect/abort/stream controls. Feature detection is required in production;
  signatures/fakes are not real desktop/mobile qualification. Record available
  real-host evidence or explicitly keep it unqualified; no unsupported fallback.
- **Failures/gate:** unsupported wildcard/validator/timestamp/transport contract or
  incompatible harness blocks affected work. Use no account, production token,
  remote bucket or deployment to qualify it.
- **Validation/acceptance:** `mise install`, `mise run install`, the new runtime
  task and `mise run check`; prerequisite evidence for A4/A6/A10.
- **Implemented evidence:** [Slice 0 platform qualification](../qualification/m3-slice-0-platform-primitives.md)
  records the pinned local workerd tests and compile-time host API inspection. The
  runtime task proves current/recovery create-only, ETag CAS, failed-write, distinct
  embedded-revision validator and stored-upload-time behavior. Official Obsidian
  1.13.1 and browser declarations expose the planned APIs, but no real desktop or
  mobile host has been exercised. No production mirror/API/host behavior was added.

## 1. Modern baseline and shared typed contracts

- **Objective/dependency:** following 0, establish supported host/API and domain
  contracts before adapters. Inspect core local-vault/note-path/vault exports,
  protocol api schemas/types, plugin manifest/artifact tests and package aliases.
- **Changes:** set M3 minAppVersion to **1.13.0**, artifact expectation and plugin
  development guidance together. Keep non-desktop-only, no Node globals or legacy
  settings path. Add core mirror/conditional/recovery ports and state types; protocol
  v2 schemas/constants using the public core path predicate. Update public exports
  and package dependency only where required; never core→protocol/Obsidian/HTTP.
- **Tests first:** existing M2 command behavior unchanged; all eligible paths need
  no selected state; actual NotePath schema rejects invalid input, revision/UUID/
  hash/cursor/receipt validation, closed live/tombstone/recovery/intent variants,
  absent versus matching precondition and effect-certainty states.
- **Steps:** separate runtime constants/schemas from *.types.ts, define units and
  security/lifecycle contracts with TSDoc, model conditional repository and remote
  client separately from ReadOnlyLocalVault. No local mutation port or body ledger.
- **Failures/gate:** weak framework defaults, unchecked JSON, duplicate policy,
  import cycles, deprecated display(), weakening production Node isolation.
- **Validation/acceptance:** focused/shared tests and canonical check/build;
  A1/A2/A4/A5/A6/A9 contracts only. No automatic work or enabled v2 routes yet.
- **Implemented evidence:** Slice 1 raises `minAppVersion` and the generated-artifact
  expectation to 1.13.0 while preserving the two M2 inspection commands. Core exports
  UUID-v4 identities, strong application ETags, SHA-256 digest validation, conditional
  requirements, closed current/recovery/intent/effect contracts and capability-focused
  current-note/recovery ports. Protocol imports only public core predicates and adds
  strict bounded v2 DTO schemas for those contracts. No Worker v2 handler, R2 adapter,
  plugin settings/state/Fetch client/event wiring or autosync implementation is added.
  Final check/review evidence is recorded in the Slice 1 implementation PR.

## 2. Coherent Worker current-generation and recovery transition

This plan slice is checkpointed as 2A storage/codecs/CAS, 2B application policy,
and 2C HTTP/OpenAPI/v1 retirement. It is not complete until 2C exposes the compatible
surface and retires unsafe v1 mutations; intermediate checkpoints are not rollout-safe.

- **Objective/dependency:** deliver safe remote primitives as a coherent change
  before plugin autosync. Inspect app/index/dependency middleware, core vault
  service/port, R2 adapter/codec types, handlers/OpenAPI/auth/error/logging tests.
- **Changes:** private live/tombstone/recovery codecs and predicates, core conditional
  note/recovery services, v2 identity configuration and describe/list/read/state/
  put/tombstone/recovery/seal/purge handlers; retire **v1 PUT and DELETE in the same slice**.
  Preserve envelope-aware legacy reads/listing; no automatic raw-note adoption.
  V2 CORS/errors/no-store/OpenAPI use shared contracts. The plugin remains local-only.
- **Tests first:** two competing absent creates; two readers of A racing to CAS;
  remote edit exactly between adapter GET and put; same-text ABA; ACK revision from
  actual put despite a later overwrite. Compose handler→real service→real R2 adapter
  with barrier storage double; assert final bytes/revision and refused side effects.
- **Recovery tests first:** archive failure prevents tombstone; successful archive
  followed by failed CAS retains winner; head succeeds/seal fails or ACK is lost;
  deletion timestamp comes from stored head; recreation preserves separate archive;
  expired CAS purge leaves marker; concurrent seal/purge/duplicate prepare cannot
  resurrect expired content. Never use unconditional cleanup DELETE.
- **Protocol tests:** strict headers/media/bytes/path/receipt/cursor, 401/403/410/412/
  428/error bodies; unknown v2 routes auth; correct method-specific OPTIONS/CORS;
  optional empty body but required supported content type; v1 retirement and old
  server incompatibility. Validate generated OpenAPI semantics, not route substrings.
- **Steps:** implement codecs/CAS/core transitions, then expose all compatible
  readers/writers together. Add non-secret association/writer config types without
  assuming real setup. Document stop/drain old writers before future upgrade and
  no old-code rollback over new objects. GETs remain read-only; explicit seal
  maintenance requires designation, matching recovery revision and current-tombstone
  timestamp proof. Core services own policy; adapters own codecs/CAS translation.
- **Failures/gate:** malformed/oversized envelopes are errors, not absence; raw
  JSON-looking legacy stays text; failed recovery sealing cannot undo head commit;
  unsealed material cannot be purged. R2 operators remain trusted.
- **Validation/acceptance:** runtime storage harness, focused suites, coverage,
  build/OpenAPI and canonical check; A4/A6/A9 server. No deployment, migration,
  scheduled cleanup, plugin sync, database or extra storage authority.
- **Implemented checkpoint evidence:** Slice 2A adds strict format-2 current/recovery
  codecs and delete-free create/CAS R2 adapters. Slice 2B composes them under core
  current-generation and recovery services: recognized-absence create, exact live
  update/tombstone recreation, recovery-first tombstone, tombstone-upload-derived
  30-day sealing, metadata inspection, prepared/unexpired content retrieval with
  expiry withholding, bounded lists and sealed-expiry CAS purge to content-free
  markers. Slice 2C composes those real services/adapters into authenticated public
  v2 mirror/current/recovery routes, strict conditional/designation/media/body input,
  exact application ETags/results, method-specific CORS, semantic OpenAPI, separate
  recovery metadata/content reads, envelope-aware v1 reads and authenticated 410 v1
  mutation retirement. Focused HTTP/composed tests cover current/recovery flows,
  parser negatives, no-mutation guards, CORS, v1 compatibility and OpenAPI. No
  deployment, plugin settings/state/client or autosync is included. Slice 2C local
  evidence: 31 source files/362 tests at statements 95.79%, branches 92.49%,
  functions 98.03%, lines 95.94%; the 8-case pinned workerd storage task also passes.
  Canonical check/build evidence was repeated after corrective semantic review; no
  account, bucket or deployment was used.

## 3. Device-local configuration, state owner and handoff model

- **Objective/dependency:** after contracts/server, durable non-content state before
  network dispatch. Inspect plugin main/host adapter/types and existing host doubles.
- **Changes:** plugin preferences/native secret reference adapters; vault-local
  storage codec; core state owner, designation and handoff validation use cases.
  Device UUID/activation/ledger outside data.json; data.json only preferences.
- **Tests first:** missing vs corrupt/future/duplicate state, excluded/invalid paths,
  native secret reference only, no token/body in serialization. Competing complete
  read/apply/save transitions cannot overwrite ACKs/disablement with stale snapshots;
  quota/error before send and ACK-save failure after commit pause globally.
- **Handoff tests:** fail non-writer designation; no activation from synced settings;
  block unresolved mutation/rename; old-state GET or abort is not quiescence; export
  only verified ACK metadata without device activation/ID/secrets; import wrong
  origin/association/revision fails. Keep iCloud hydration pending during import:
  stale local text cannot overwrite a newer transferred live ACK or resurrect a
  transferred tombstone. Stage baselines until one complete local hash/absence and
  remote-verification snapshot aligns, reject late evidence older than the current
  observation generation, batch invalidated observations, and block mismatches.
  Lost-device reset cannot reuse old keys.
- **Steps:** strict boundary codecs, disabled initial state, whole-mirror opt-in,
  HTTPS/exact-loopback pre-canonical validation, serialized configuration changes,
  pause/drain/reset and explicitly transferred handoff metadata. Never add a synced
  ledger, lease/election or permanent note snapshot to solve persistence failures.
- **Failures/gate:** no weak generic merges, auto-adoption, silent state clearing,
  stale token-ref restoration or new keychain claim. Unknown data stays untouched.
- **Validation/acceptance:** focused unit tests, coverage and check; A2/A5/A8 model.
  No Vault watchers/UI activation or remote-to-local writes yet.
- **Implemented evidence:** Slice 3 adds closed core device/lifecycle/per-path state,
  finite unresolved-intent budgets, compare-and-transition serialized ownership,
  explicit isolated-association activation/readiness and distinct durable handoff
  draining/drained states. Pause only enters draining; a separate quiescence-checked
  transition enters drained, and only drained state can export. Strict Obsidian
  boundary codecs distinguish missing/corrupt/future state,
  reject duplicate/invalid/inconsistent/bounded data and never clear failures.
  `data.json` represents endpoint preferences and a native secret reference only;
  App local storage owns device identity, activation, ACK/intent/evidence ledger and
  staged handoff metadata; native SecretStorage retains the bearer. Content-free
  checksum-covered handoff imports remain staged until a complete indexed local and
  remote evidence batch aligns in one owner save; changed observations are invalidated
  as a collapsed batch. A maximum-50,000-path core test guards linear traversal and a
  single save. A package Symbol retains
  the state owner only within the same JavaScript host. The adapters/policy are not
  composed into automatic behavior: no settings UI, Fetch, retries, Vault events,
  dispatch, remote verification or local writes are added. Final Slice 3 evidence is
  79 focused tests and 38 source test files / 453 tests under the canonical check,
  with 95.70% statements, 93.41% branches, 98.42% functions and 96.11% lines.

## 4. Typed bounded Fetch remote adapter

- **Objective/dependency:** implement RemoteBridge over v2 without platform types in
  core. Inspect shared DTOs, Worker fixtures, plugin dependency/production tsconfig.
- **Changes:** cohesive remote transport, streamed-byte reader, response/metadata
  validation and failure-mapping adapters with injected Fetch seam. Token retrieved
  at dispatch from native store; adapter owns URL/auth/AbortController, not UI/core.
- **Tests first:** complete method/status/schema/media/UTF-8/path/receipt/revision
  matrix, stream byte bounds and hanging reads, misleading Content-Length, redirect
  denial, credentials:omit, missing Web APIs, token removal/rotation and old server.
  Keep underlying transport pending after abort to test actual settlement ownership.
- **Steps:** canonical encoded addressing, bounded stream/deadline through consumption,
  exact ACK validation, metadata-only application results. Distinguish not-dispatched,
  refused, confirmed and unknown effects. No raw exception/response echo, v1 PUT/
  DELETE or requestUrl fallback. Enforce global request admission through coordinator.
- **Failures/gate:** wrong own receipt never ACKs; an arbitrary remote GET is not
  mutation authority; 401/403 globally pause even with malformed intermediary body.
- **Validation/acceptance:** focused test/coverage/build/check; A2/A9 transport.
  Retries/coalescing belong to core, no adapter retry loop or direct vault access.
- **Implemented evidence:** Slice 4 adds the typed core `RemoteBridge` contract and
  an uncomposed plugin standards-Fetch v2 adapter. It uses only `fetch` with
  `redirect: "error"`, `credentials: "omit"`, canonical encoded note routes,
  coordinator-provided admission, dispatch-time native SecretStorage reads, a
  30-second full-operation deadline, bounded strict-UTF-8 response streaming, exact
  schema/ETag/receipt checks, and conservative effect-certainty mapping. Focused
  deterministic tests cover request construction, token rotation/removal, response
  bounds/encoding/media/schema failures, exact acknowledgements, state/list/recovery
  adaptation, deadline/body stalls and non-cooperative pending Fetch. The adapter
  makes one attempt and is not composed into automatic runtime behavior.

## 5. Core bootstrap, coalescing and per-path autosync

- **Objective/dependency:** compose the ports without host callbacks/UI. Inspect M2
  read-only service/eligibility behavior, new state owner and remote contracts.
- **Changes:** MirrorSynchronizer, fair two-slot admission/path reservations,
  reconciliation planner, event-generation and finite retry/evidence state machines.
  Delete/rename orchestration follows slice 6; do not wire an incomplete auto-mirror
  to the plugin until both exist.
- **Tests first:** whole eligible bootstrap, events during scan, startup absence
  never deletes, non-writer disabled, rapid modify collapses, mutation during read
  invalidates, change during PUT stays dirty and uses actual prior sent ACK/hash.
  Equal hash avoids write; remote different/missing/legacy/tombstone collision blocks.
  Distinct or empty endless cursor pages hit the total inventory budget and report
  incompleteness, without stopping independent positive synchronization. Read-only
  passes never self-restart on failure or reset a mutation's retry budget.
- **Interleavings:** three-attempt/evidence budgets survive re-enable/restart/events;
  abort/lost ACK while server commit still pending; original-condition exact retry;
  changed local hash cannot replace a pending body; other paths continue; ACK save
  failure pauses globally; hot path cannot starve unrelated work or exceed bounds.
- **Steps:** bootstrap boundary and positive observations, hash saved text, persist
  original intent before dispatch, apply valid ACK through one state owner, preserve
  latest dirty intent and terminal uncertainty. No remote-latest baseline refresh.
- **Failures/gate:** no startup remote-minus-local delete, body history, infinite
  retry/poll or snapshot cancellation claim. Distinguish observing from continuously
  verified remote equality; independent clients may modify between observations.
- **Validation/acceptance:** deterministic core/port tests, coverage and check;
  A1/A3/A5 engine. Still no plugin automatic composition or manual publish primary.

## 6. Runtime deletion, recreation and rename orchestration

- **Objective/dependency:** complete M3 automatic lifecycle before UI wiring.
- **Changes:** core durable runtime-delete evidence, 5-second grace/exact absence,
  rename prerequisite and deferred-cleanup states; associated folder expansion.
  No change to local read-only capabilities.
- **Tests first:** post-bootstrap associated deletion including external-origin
  event, pre-bootstrap/unassociated/pending-first-create negative authority; runtime
  delete during own update waits for ACK; remote competitor causes divergence;
  save failure loses authority safely, never rebuilds it from absence on restart.
- **Rename interleavings:** destination create ACK must persist before source cleanup;
  collision/unknown ACK/remote source edit prevents cleanup. Keep source PUT pending
  while rename occurs; source recreation and further rename during destination PUT
  invalidate cleanup. Folder duplicates, excluded destinations and chain/overlap
  preserve data and report deferred state rather than invent an atomic transaction.
- **Steps:** persistent evidence before send, original-revision tombstone, exact own
  receipt recovery; eligible recreation after acknowledged tombstone uses matching
  condition. Expand indexed folder descendants with path-boundary checks and global
  bounds. No history growth per edit/rename notification.
- **Failures/gate:** archive/sealing/purge outcomes from Worker remain distinct;
  expired recovery does not make a head absent; no local writes, hard delete,
  human-provenance flag, per-delete confirmation or plugin-specific delete command.
- **Validation/acceptance:** core and composed service/adapter tests, coverage/check;
  A6/A7 complete engine, including recovery-by-API guidance, not M4 restore UI.

## 7. Official host events, modern settings and runtime ownership

- **Objective/dependency:** only now expose the complete automatic mirror while
  preserving M2 commands. Inspect main/inspection/unit/integration/artifact doubles.
- **Changes:** thin declarative settings/SecretComponent/status/operational commands,
  official primitive event adapter, onLayoutReady bootstrap and globalThis Symbol
  runtime-owned versioned coordinator registry. Explicit adapter around host globals;
  no weak runtime state escaping into core. Keep one writer host/process per vault.
- **Tests first:** unconfigured enabled plugin no network/scan; configured designated
  writer resumes automatically. Register events before scan, no startup-create storm,
  save events not editor changes; immutable capture of renamed TFile paths/folder index.
- **Lifecycle interleavings:** pending read/network/save; unload; construct a new
  Plugin instance and enable **before settlement**; no duplicate jobs/registry reset,
  stale UI or late onLayoutReady listeners. Reload bundle in same realm; incompatible
  registry fails closed. New process uses persisted intent, never empty in-flight flag.
- **Configuration tests:** ref removal/external data.json/origin change while pending,
  pause/drain with unknown remote effects, no stale connection/activation/ACK save.
  Show text-only health/per-path retry/deferred states, never token/body/raw errors.
- **Steps:** compose typed adapters/services, attach UI session without replacing
  owner, configure whole opt-in/designation, register official events and controls;
  unload detaches and aborts, retaining real slots until settlement. Handoff/export
  is explicit metadata-only UI, not copying a transactional ledger through iCloud.
- **Failures/gate:** no incidental Fetch/DTO/repository logic in settings/callbacks,
  per-note consent state, local mutation, multi-writer takeover or capability fallback.
- **Validation/acceptance:** focused host integration, coverage/typecheck/check;
  A1/A2/A3/A8/A9 end-user behavior. No installation into a personal vault.

## 8. Artifact, operational and final semantic gates

- **Changes:** extend generated CommonJS smoke tests proportionally: modern settings
  and native references, automatic saved event → exact conditional request, actual
  runtime-registry instance/bundle replacement, no Node/token/body leakage. Keep
  source coverage separate; do not copy every unit test into artifact tests.
- **Operations/docs:** synchronize API/architecture/current-state/README/SECURITY/
  plugin development with **implemented** behavior. Document empty association
  setup, full scope, one-writer availability, safe upgrade/handoff/reset, independent
  secret rotation, deletion recovery retrieval and conditional expiry purge. Explain
  iCloud event uncertainty, unsealed over-retention and forbidden lifecycle/old-code
  rollback. Setup/deployment remains a separate operator action.
- **Validation:** `mise install`, `mise run install`, `mise run check`, local storage
  runtime task, `git diff --check`, local documentation links and actual diff/secret
  review. Inspect four coverage metrics, unchanged inclusion/thresholds, editor
  schema/assists/type-aware deprecations; do not claim an editor/host run not performed.
- **Semantic review:** load **code-review** skill and its PR/semantic/TypeScript
  guidance after green checks. Examine boundaries/typing/TSDoc, state ownership,
  all exact harmful interleavings, recovery expiry/late preparation, credentials,
  downgrade/handoff and unsupported guarantees. Turn findings into regression tests,
  fix and re-review every one; no unexplained BLOCKER/MAJOR or product ambiguity.
- **Completion:** record real evidence for A1–A11. Only completed M3 implementation
  permits M3 COMPLETE and M4 NEXT with a refined planning spec; transition canonical
  when merged. Open the implementation PR, do not merge/deploy or start M4 code.

## Planning revision evidence

The prior PR head `e35bd90` contained an obsolete selected-note/manual-primary,
no-delete proposal. Its validation/review is **not** evidence for this redesign.
This revision follows explicit maintainer approval of whole eligible scope,
automatic lifecycle, native SecretStorage/modern baseline, safe v2 CAS, runtime
delete authority, 30-day recovery and one designated writer. No production/test/
manifest/dependency/configuration change belongs to this planning PR.

### Automated validation of the revised planning tree

- `mise install`, `mise run install`, `mise run check` passed after the redesign and
  again after substantive review corrections. Publication reruns the full gate on
  the committed documentation before push. No source/test/manifest/config/dependency
  changes relative to main; all changes are Markdown, including historical M2
  handoff annotations rather than changes to its completed invariants.
- 21 source files / 250 tests and 1 generated-artifact file / 3 tests passed.
  Coverage unchanged: statements 96.75%, branches 93.75%, functions 95.96%, lines
  97.04%; production inclusion and 95/95/94/90 thresholds unchanged.
- Biome formatting/lint/assists, type-aware lint/deprecation checks, all typechecks,
  Worker dry-run and actual CommonJS artifact checks passed. The configured editor
  manifest schema was inspected; no separate editor session is claimed. Wrangler's
  available-version notice is informational, not a diagnostic or reason to change
  locked dependencies in a docs-only PR.
- `git diff --check` and an ephemeral local Markdown file/heading-link validator
  passed. CI for prior head e35bd90 was green; final-head CI is reported in PR #8,
  not inferred from that older run. Canonical results test unchanged M1/M2, **not**
  a nonexistent M3 engine or its future race/platform qualification tests.

### Same-session code-review and corrective review

Read repository rules/CONTRIBUTING/architecture/ADRs, CI/tool/editor/coverage config,
actual documentation diff and relevant current Worker/core/plugin code and tests.
Used the **code-review skill**, PR and semantic checklists, and TypeScript profile
for planned typed boundaries and existing-source evidence. No auxiliary model
output is counted as this manual review. Reviewed conceptual responsibilities,
state/operation/UI lifetimes, unsafe typing/deprecations, semantic sources of truth,
secrets/paths, exact interleavings, storage/HTTP compatibility, retention and handoff.

| Finding | Severity | Corrective status and evidence |
| --- | --- | --- |
| Distinct next cursors could keep inventory traversal unbounded despite cycle detection | MAJOR | **fixed** — spec V2 surface caps total pages, reports incomplete inventory without destructive inference, and tests endless distinct/empty pages; plan slice 5 includes it |
| GET state inspection could seal recovery without the designated mutation contract | MAJOR | **fixed** — ADR 0004/spec/plan make all GETs read-only and require explicit conditional seal with identity checks and proven deletion timestamp |
| Imported remote ACKs could let stale/partially hydrated iCloud data overwrite a live note or recreate a tombstone | MAJOR | **fixed** — ADR 0003/spec/plan stage imports until local hash/absence and remote revision alignment; accepted dirty/in-flight work blocks export; tests hold hydration and verification races open |
| Completed M2 handoff text still sounded like current open selection decisions | MINOR | **fixed** — M2 spec/plan explicitly label historical handoff and link the accepted M3 direction, preserving original implementation evidence |
| Per-path handoff alignment repeatedly scanned, validated and saved the whole bounded ledger | MAJOR | **fixed** — complete indexed local/remote evidence and collapsed invalidations are atomic core batches; the state owner performs one save, with a maximum-50,000-path regression test |
| Local-state wording implied arbitrary valid historical restores were detectable | MINOR | **fixed** — ADR 0003 distinguishes detectable corruption/failure from undetectable valid rollback and requires explicit paused revalidation |

Re-read each corrected contract and its exact planned regression after green checks;
verified ownership stayed in the appropriate application/runtime layer, no stale
snapshot reset/force-adoption path was added, and the fixes do not turn GETs into
mutation authorization or inventory absence into deletion. No actionable finding,
unresolved BLOCKER/MAJOR, silently deferred review issue or material M3 product
choice remains. **Verdict: APPROVE for this documentation-only implementation design.**

The design preserves approved outward authority and all M1/M2 historical facts;
local mutation, general conflict/adoption resolution and richer restore remain M4.
CAS/recoverable tombstones and conservative uncertainty are simpler than a new
transactional database/election/history system for the approved single writer.
Current tests are meaningful baseline evidence, not coverage for proposed behavior.
Real desktop/mobile, iCloud event traces and deployed Worker/R2 remain untested;
source research is not runtime qualification. Supported single-writer operation,
trusted plaintext host/operator, possible unsealed over-retention, retained small
markers and blocked ambiguous paths remain explicit design limits, not hidden fixes.
M3 remains NEXT; PR #8 remains draft, without implementation, deployment or merge.
