# Project roadmap

This is the canonical execution roadmap: implemented facts, planned direction and
unresolved choices are distinct. Dates are intentionally not assigned. Engineering
rules live in [AGENTS.md](../AGENTS.md).

## Project end state

`obsidian-ai-bridge` maintains a **private personal mirror of all eligible Markdown
notes** for authorized remote API/AI/agent access, while the user keeps the working
Obsidian vault. This supersedes PR #8's selected-note/manual-publishing drift.

```text
iCloud ↔ working Obsidian vaults
               |
       one designated plugin writer
               ↓
        Cloudflare Worker ← authorized REST and MCP clients
               ↓
          private R2 mirror
```

- The user opts into the entire eligible Markdown mirror. Saved local creates,
  changes, eligible runtime removals and renames propagate automatically, with
  bounded work, visible progress/divergence and operational retry/pause controls.
  No per-note selection, folder/tag/frontmatter allow-list or manual-primary model.
- Retain canonical literal NotePath, lowercase .md, dot/config exclusions and 1 MiB
  UTF-8 limit. The mirror is not a backup of credentials, configuration, attachments
  or arbitrary vault files. Eligibility determines scope, **not authorization**.
- iCloud remains device-to-device sync. R2 is mirror/API persistence, not the sole
  authority or complete guaranteed backup. The designated writer must be running
  for freshness. NAS replication/stronger remote authority may be considered later,
  but are not present requirements or implemented capabilities.
- Local saved state is the normal M3 mutation source. Remote revision changes are
  divergence, not permission to overwrite or import. M4 uses reviewed-only,
  evidence-bound conflict/adoption/restoration flows; no automatic or hybrid
  bidirectional synchronization.
- An observed post-bootstrap Obsidian delete event for an already-associated eligible
  note authorizes recoverable mirror removal, including iCloud/external activity.
  No human-provenance claim or per-delete confirmation. Startup/scan absence never
  authorizes deletion; permanent revisioned heads prevent unsafe resurrection.
- The Worker authenticates remote clients to named principals from a bounded
  digest-only registry; the plugin accesses local vault data. The host/Worker/cloud
  operator are trusted with plaintext. One exhaustive operation policy enforces exact
  independent `read`, `write`, and `delete` permissions before service/storage dispatch;
  mirror inclusion and writer IDs remain separate non-secret mutation guards.
- MCP will adapt established authorized operations, not bypass Worker/application
  policy or access R2 directly. It never executes instructions found in notes.

Outside this roadmap: replacing iCloud/Obsidian Sync, general file backup,
attachments, search/indexing, embeddings/inference, collaboration, arbitrary
filesystem access and SaaS multi-tenancy. No additional database/service is assumed.
New infrastructure requires a concrete need and [ADR](decisions/README.md).

## Current state

**M3 — Automatic eligible-Markdown remote mirror — COMPLETE.** PR #27 merged at
`63b0599` and made the M3→M4 transition canonical. M1 and M2 remain complete; M2 merged at
`b300726` (PR #7) and its metadata-only inspection remains available. M3 Slices 0–8
compose an experimental connected outward mirror, not a production-ready or
remote-to-local system. Canonical validation passed, the final semantic review's three
MINOR findings were corrected at `e97af36`, and the corrective review returned APPROVE
with no open findings. M4 Slices 1–8 and M5 are COMPLETE; M6 is COMPLETE in this completion transition. No milestone is NEXT, and no M7 is defined. M5's support claim is limited to the latest v1.0.2 release and its exact [qualification report](qualification/m5-final.md). M4's reviewed-only authority, preservation, local mutation,
adoption/tombstone/restore, migration, and one-writer product decisions are implemented
and qualified. Slice 1 implements the closed contracts, sparse state v3, deterministic
v2 migration/read-back fence, downgrade refusal, and runtime registry compatibility
fence. Slice 2 adds the core-only bounded read-only review/classification engine,
ephemeral stale-bound reviews, allowed-action policy, and serialized content-free
admission. Slice 3 adds operation-authorized local create/replace and durable
preservation primitives. Slices 4–5 add core-only exact live/adoption/tombstone/restore
action execution, receipt-based remote effect recovery, and restored-path successor
ownership. ADR 0009's compatibility transition is implemented by Slices 6–7: strict
state v4, bounded reviewed history cleanup, shared M3/M4 scheduling, durable synthetic
local-effect/successor evidence, and text-only runtime/UI composition. Slice 8 adds
proportional packaged M4 behavior, stale/restore/replacement/leakage gates, synchronized
operations/security guidance, canonical validation, and final semantic approval.
The later corrective [ADR 0013](decisions/0013-listener-ready-effect-authority-and-observation-gap-recovery.md)
implementation advances current device state and owner/registry authority to v5, adds
cold-start/listener-gap fencing and dispatch leases, and has bounded disposable-host
evidence; this correction does not constitute M5 qualification or support.
Slice 0 qualifies the pinned local
conditional-storage runtime and host declarations. Slice 1 raises the plugin baseline
to 1.13.0 and adds shared typed contracts. Worker Slice 2A–2C implements private conditional storage, application current/
recovery transitions, public safe v2 HTTP/OpenAPI/CORS, envelope-aware v1 reads and
v1 mutation retirement. Slice 3 adds strict uncomposed plugin configuration/native
secret-reference boundaries, App-local state persistence, serialized transition
ownership, explicit writer activation and staged handoff validation. Slice 4 adds an
uncomposed typed bounded v2 Fetch `RemoteBridge` adapter with dispatch-time native
secret retrieval and conservative effect certainty. Slice 5 adds independently
testable core bootstrap, positive-event coalescing, fair two-slot path scheduling,
finite mutation/evidence recovery and bounded inventory reporting. Slice 6 adds
core runtime deletion, exact tombstone recreation, destination-first rename and
bounded folder expansion. Slice 7 composes official Vault events, layout-ready
bootstrap, runtime timers, modern SecretStorage/settings, Fetch, and same-realm
ownership. Slice 8 adds proportional built-artifact qualification and the
[operator guide](operations.md). No deployment, real desktop/mobile host, iCloud event
trace, or background iOS behavior was qualified.

See [M3 completion evidence](milestones/m3-remote-bridge-client-and-publishing.md#slice-8-acceptance-evidence),
[current-state evidence](current-state.md), [architecture](architecture.md),
[implemented API](api.md), [M2 completion](milestones/m2-obsidian-read-only-local-adapter.md#completion-evidence)
and [M2 plan](plans/m2-obsidian-read-only-local-adapter.md). Current test counts
and coverage evidence are recorded in [current-state](current-state.md); that M3 evidence
exercised no deployed Worker or real Obsidian desktop/mobile host. Later corrective M4
evidence is limited to the preservation root and one Keep-local path. M4's then-planned
evidence requirements were not existing coverage or permission to start production
implementation.

## Milestone table

A milestone is `NEXT` only while its prerequisites and specification authorize
implementation. M1–M6 are COMPLETE in the current transition, so none is marked
`NEXT`; no later milestone is defined. Future direction does not authorize production
code. Dependencies include all previous milestones.

| ID | Milestone | Status | User-visible outcome | Dependency |
| --- | --- | --- | --- | --- |
| M1 | Worker API foundation and engineering quality | COMPLETE | Authenticated remote Markdown CRUD/listing with R2 and enforced quality gate | None |
| M2 | Obsidian read-only local-vault adapter | COMPLETE | Explicit local inspection without sending or changing notes | M1 |
| M3 | Automatic eligible-Markdown remote mirror | COMPLETE | Whole eligible saved vault mirrors outward, including recoverable removals/renames, with one designated writer | M2 |
| M4 | Remote-to-local reconciliation and conflict resolution | COMPLETE | Review/adopt/resolve remote divergence and richer restoration without silent local data loss | M3 |
| M5 | Operational and security readiness | COMPLETE | Latest-only, bounded v1.0.2 software support with reviewed limits, permissions, runbooks and qualification evidence | M4 |
| M6 | MCP adapter | COMPLETE | Same authorized operations for MCP-capable agents through the M5 authentication and application-service boundary; bounded official-client qualification complete | M5 |

### M1 — Worker API foundation and engineering quality

- **Implemented:** Hono HTTP, single-token auth, canonical path validation, 1 MiB
  bound, typed core service/port, R2, Zod/OpenAPI/Scalar, sanitized LogTape, strict
  tools and coverage-enforced dedicated tests.
- **Historical non-goals/retained risks:** M1 had no plugin sync, conditional writes,
  recovery or production guarantees. Current Worker Slice 2 retires unconditional v1
  mutations and adds conditional v2/recovery; plugin sync and production guarantees
  remain absent.
- **Exit met:** canonical check, tests, manual semantic review and API/architecture
  documentation accompany the merged foundation. M3 deliberately changes its remote
  mutation contract without rewriting these implemented historical facts.

### M2 — Obsidian read-only local-vault adapter

- **Implemented:** loadable CommonJS plugin, read-only local port/service and
  official saved-vault adapter; two explicit metadata-only inspection commands,
  source tests, artifact checks and disposable-vault instructions.
- **Non-goals/retained risks:** no network/settings/token/state persistence, watchers,
  local writes/deletes, remote client or MCP. Reads are best-effort, not atomic;
  no real-host compatibility test. The M2 artifact used 1.5.0; M3 Slice 1 now raises
  the current plugin baseline to 1.13.0 without changing those commands.
- **Exit met:** [completed spec](milestones/m2-obsidian-read-only-local-adapter.md)
  records all acceptance items, coverage and independent semantic review.
- **Boundary preserved:** inspection alone is not mirror opt-in. M3 adds whole-mirror
  activation and automatic behavior; it does not reinterpret an M2 inspection as
  consent or change the local read-only command semantics.

### M3 — Automatic eligible-Markdown remote mirror

**COMPLETE — Slices 0–8, canonical/runtime/artifact/coverage/diagnostic gates,
operational documentation, and final semantic review completed in PR #27, merged at
`63b0599`. The transition is canonical; no deployment is implied.**
[Specification](milestones/m3-remote-bridge-client-and-publishing.md),
[approved decisions/evidence](plans/m3-design-decisions.md),
[sequential test-first plan](plans/m3-remote-bridge-client-and-publishing.md) and
accepted-design ADRs 0002–0004 define the behavior. Do not deploy or mark M3 complete
merely because the server-side storage and application checkpoints are implemented.

- **Scope:** whole eligible scope/opt-in; modern SecretStorage/settings with M3 host
  minimum 1.13.0; HTTPS/exact loopback; Fetch/CORS; bootstrap and saved Vault events;
  bounded coalescing/concurrency/retries; per-path ACK/hash/uncertainty state;
  safe conditional creates/updates/deletes/recreation/rename; health/pause/retry.
- **Delete/recovery:** associated post-bootstrap runtime removals, never scan
  difference; archive before CAS tombstone; 30-day recoverability; separate recovery
  list/read and safe conditional expiry purge to retained markers. No native R2
  trash/versioning/precise-erasure claim; no lifecycle expiry of authoritative heads.
- **Writer/state:** one explicitly designated supported device, host-local activation
  and ledger, static Worker ID guard, clean pause/drain/export/import handoff.
  Staged imports require matching local hashes/tombstone absence before activation,
  preventing stale iCloud data from overwriting/recreating remote state. No iCloud
  transaction/election/leases; unresolved work blocks takeover. Lost-device
  reset uses a new empty association without redirecting old requests into it.
- **Remote prerequisite:** fresh body-embedded server revisions/receipts and R2 CAS;
  v2-only mutations and retirement of **both** unsafe v1 PUT and DELETE. Legacy
  raw objects remain readable but are not silently adopted. Real path schemas and
  runtime/OpenAPI media/empty-body agreement are part of this change.
- **Safety/qualification:** [Slice 0](qualification/m3-slice-0-platform-primitives.md)
  proves the required conditional predicates in the pinned local workerd runtime
  and records declaration-only host availability. Exact production race windows
  and real desktop/mobile host behavior remain unqualified; unsupported host
  primitives fail closed. No abort =
  rollback assumption, refresh-and-overwrite, body queue or Plugin-instance-only
  lock. Same-runtime owner survives replacement/re-enable; restart uses ledger.
- **Exit met:** A1–A11 are complete with tested delete/recovery/rename/restart/
  handoff behavior, bounded typed failures, synchronized docs, 61 files / 752 source
  tests, 6 artifact tests, 8 workerd storage tests, and coverage of 95.01% statements,
  91.06% branches, 98.38% functions and 96.95% lines. The final review's three MINOR
  findings were corrected and the corrective review approved `e97af36` with no open
  findings. No remaining material M3 decision.
- **Non-goals:** remote-to-local writes, merging/arbitrary adoption, richer restore
  UX, multi-writer coordination, scheduled polling/cleanup, MCP or new infrastructure.

### M4 — Remote-to-local reconciliation and conflict resolution

**COMPLETE — Slices 1–8 implemented, qualified, documented, and semantically
approved in this completion PR.** The
[specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[test-first plan](plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
and accepted ADRs 0005–0009 resolve the material product and technical choices.
Slices 1–8 were implemented and qualified before M5 was authorized by its separate
implementation-ready specification. M5 and M6 are now complete in this transition.

- **Authority:** reviewed/manual reconciliation only. Remote divergence remains a
  review item until an operator chooses an evidence-bound typed action. One immutable
  content-free snapshot closes runtime/configuration/listener, lifecycle, every path's
  local/ACK/remote/M3 state, exact remote receipt and selected recovery identity; a
  change in any dimension makes the decision stale. Confirmed actions persist the same
  snapshot and content-free phases before effects. No automatic/hybrid
  bidirectionality.
- **Implemented reviewed actions:** focused services execute archive-first Keep local,
  Use remote, Keep both, exact format-2 adoption, distinct-path legacy fork, explicit
  tombstone adoption/recreation/copy, and local-first recovery restore. Conditional
  effects retain exact receipt evidence across restart; restore remains
  `restored-pending-review` until a fresh reviewed successor atomically takes the path.
  Bounded deferred-history cleanup is also implemented through ordered step ledgers;
  no automatic decision is composed.
- **Preservation/local mutation:** competing bytes are create-only and post-verified
  under the explicit host-visible `ai-bridge-conflicts/<operation>/` namespace before
  replacement. Corrective real-host qualification found the historical
  `.ai-bridge-conflicts` root physically creatable but absent from the Obsidian Vault
  index; ADR 0012 changes new generation only. Both namespaces are mirror-excluded,
  and frozen legacy receipts remain exact and conservative rather than repaired. The state-v4 validator derives the required operation- or step-scoped side/revision/hash
  matrix from sampled evidence and rejects unbound or extra receipts. A dedicated
  narrow core port supports exact create, atomic replace, and create-only preservation;
  the M3 read-only port stays unchanged. No plugin local rename/delete or generic
  Vault capability.
- **Adoption/deletion/restore:** exact format-2 revisions can be explicitly adopted;
  legacy objects can only be preserved/forked to a different path because they lack
  conditionable generation identity. Remote tombstones allow absent-only adoption or
  live preserve/copy/recreate/defer choices; no plugin local delete/move. Recovery
  restore is local-only first and retains an active `restored-pending-review`
  reservation across restart/re-enable until a linked reviewed successor atomically
  takes ownership and completes the second remote decision.
- **State/API/writer:** Slice 1 migrates device state deterministically from v2
  to incompatible v3, preserving every M3 intent/blocker, verifying the same-key write,
  and fencing downgrade/same-realm M3 ownership. Slice 2 adds only a core read-only
  review/admission seam: bounded candidate union discovery, exact content-free evidence,
  deterministic classification, transient review bodies, stale refresh/observation
  fencing, allowed-action policy, and serialized content-free operation admission.
  Existing v2 Worker operations remain unchanged; no new API/infrastructure capability
  exists. Slice 3 adds the separate local writer and preservation services; Slices 4–5
  compose them with existing `RemoteBridge` operations only inside core. One designated
  writer remains.
- **Slice 1 evidence:** closed authority/classification/action/status/evidence/
  preservation contracts, immutable stale-decision identity, evidence-bound receipt
  matrix, restored-pending-review ownership transfer, restart-time M3 scheduling and
  handoff/export fences, strict v3 codec/validation, frozen v2 decoder, migration
  failure barriers, registry version 3, and exact 50,000-path sparse migration are
  covered.
- **Slice 2 evidence:** bounded candidate/recovery inventory, exact local/remote
  sampling, precedence classification, action policy, ephemeral review lifecycle,
  same-text observation fencing, snapshot revalidation, reservation checks, and
  serialized content-free admission are covered by focused unit tests.
- **Slice 3 evidence:** the narrow local writer permits only eligible create, exact
  atomic replace, and fixed create-only preservation. Core services persist prepared
  effects/pending receipts before dispatch, verify receipts after reread/hash, retain
  unknown effects, and fence persistence failure. The official Obsidian adapter uses
  lookup/create/createFolder/read/process only; no local delete/rename/move, generic
  Vault, UI command, remote mutation, deployment, or personal-vault installation is
  composed.
- **Slices 4–5 evidence:** focused action services and a shared exact-effect executor
  cover archive-first live resolution, exact adoption, different-path legacy fork,
  explicit tombstone choices, and local-first recovery restore. Tests include stale
  barriers, path collisions, conditional refusal, persistence failure, unknown-effect
  receipt recovery, restore restart, and expired/unavailable recovery. No plugin
  command, modal, timer, runtime composition, Worker/API change, deployment, or
  personal-vault installation is composed.
- **Slices 6–7 evidence:** ADR 0009's parent ordered history-step ledger,
  step-scoped conflict paths, remote-only history effects, strict same-key v3→v4
  migration, one runtime-owned M3/M4 scheduler, synthetic exact local-effect
  observations with every later Vault event retained as successor evidence,
  session invalidation, startup orphan staling, bounded recovery selection, commands,
  text-only modals, and sanitized status are implemented together. No intermediate
  runtime publishes or saves v4 with an older owner/registry surface.
- **Exit met at M4 completion:** A1–A12 were supported by exact barrier tests,
  generated-artifact qualification, canonical diagnostics/coverage/docs, and final
  semantic approval. That historical validation ran 75 source files / 1,194 tests,
  8 workerd tests, and 11 artifact tests at 95.02% statements, 90.62% branches,
  98.12% functions, and 96.96% lines. It made M5 NEXT without M5 production code,
  deployment, personal-vault installation, or real-host/iCloud/background-iOS
  qualification; the later M5 host evidence is recorded in the [final report](qualification/m5-final.md).
- **Non-goals:** silent last-writer-wins, automatic import/adoption/merge, same-path
  legacy normalization, blanket remote authority, multi-writer coordination,
  collaboration, attachments, new server history, or replacement of working-vault
  sync.

### M5 — Operational and security readiness

**COMPLETE.** M5 closed A1–A12 without adding production TypeScript in its final
qualification transition. The only M5-qualified release is latest-only **v1.0.2** for
one active writer on Obsidian Desktop 1.13.7 / macOS 26.6.2 / Apple M4 Pro, with a
10,000-eligible-note synthetic-vault ceiling. The [final qualification report](qualification/m5-final.md)
records retained 1k/5k/10k and credential-rotation/Keep-local evidence, current v5
migration/restart measurements, the loopback recovery/diagnostics exercise, release
identity and reproducibility, canonical validation, and semantic review. No personal
vault or production Worker/R2 deployment was used. The v1.0.2 GitHub release has no
binary assets; the qualified plugin artifact is built from the version-aligned source.
M5 is not security certification, complete backup, general production-service
approval, mobile/other-desktop support, or multi-writer support. See the
[M5 specification](milestones/m5-operational-and-security-readiness.md),
[consolidated threat model](threat-model.md), [ADR 0010](decisions/0010-scoped-client-credentials-and-permissions.md),
and [ADR 0011](decisions/0011-m5-operational-envelope.md) for the accepted boundary.

- **Slice 2 — credential lifecycle:** at most 16 named opaque bearer credentials;
  strict digest-only registry; typed principal; independent `read`, `write`, and
  `delete`; one-time token display, revoke/rotation/loss recovery. The temporary
  singleton migration authority is removed.
- **Slice 3 — live diagnostics:** content-free completed-request events identify the
  authenticated client ID and closed operation/authentication outcomes; names, secrets,
  content, concrete identifiers, receipts, and raw failures remain absent. Retention is
  zero application days; events are not an audit trail.
- **Slice 4 — authorization and v1 retirement:** one exhaustive policy enforces exact
  independent permissions before service/storage dispatch. Singleton auth and every
  v1 route/OpenAPI contract are retired; v2 is the only authenticated API.
- **Slice 5 — operational runbooks:** setup, permission, rotation/revocation, handoff,
  lost-registry, manual recovery/export, upgrade, rollback refusal, and release
  procedures are synchronized with the implemented effects. No recovery automation,
  quota/limiter, durable log sink, or deployment was added.
- **Slice 6 — integrated qualification:** real-host active-writer behavior through
  10,000 synthetic notes and v4→v5 migration/restart matrix pass on the exact stated
  profile; live loopback recovery/diagnostics, current artifact identity/reproducibility,
  platform limits, canonical validation, and final semantic review are recorded in the
  report.
- **Final transition scope:** 0 production TypeScript files / 0 production LOC.
  Broader desktop versions, mobile, iCloud event ordering, background iOS, production
  resources, complete backup, and SaaS-scale guarantees remain outside the claim.

### M6 — MCP adapter

**COMPLETE in this completion transition.** The implementation-ready [M6
specification](milestones/m6-mcp-adapter.md), accepted [ADR
0014](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md), and [final
qualification report](qualification/m6-final.md) record the adapter, tests, canonical
validation, official-client evidence, and residual compatibility limits. This roadmap
The single M6 completion PR remains unmerged; this transition becomes canonical only when it merges.

- **Scope:** thin stateless Streamable HTTP adapter at `POST /mcp` over existing
  Worker authentication, exact M5 permission grants, and current/recovery application
  services. No direct R2 shortcut, second sync engine, OAuth provider, MCP-only
  credential, or additional infrastructure.
- **Surface:** eight narrow tools and two explicit note/recovery resource templates;
  conditional remote create/update/recreation, recovery-first tombstone, exact seal,
  and eligible purge remain service-owned. Read/write/delete are independent.
- **Safety:** static user-confirmation guidance and mutation annotations are advisory
  to MCP clients, not server proof of a human decision. Tool errors carry stable typed
  codes, note content is explicit-resource-only untrusted text, and logs are
  content/argument/path-free. OAuth-only client compatibility is not claimed.
- **Qualification:** official MCP TypeScript Client 2.0.0 exercised the in-process
  Worker-compatible handler with a synthetic registry bearer and in-memory storage;
  no Inspector/UI-client compatibility or deployed service is claimed. Canonical
  checks, coverage, and final semantic/security review are recorded in the report.
- No MCP-only inference/search/product expansion. M6 is the final defined milestone;
  no M7 is inferred.

## Unresolved product decisions

**None for M1–M6.** M3's accepted choices and
primary-source limits are in its [decision brief](plans/m3-design-decisions.md). M4's
reviewed-only authority, conflict preservation, bounded local mutation,
revisioned/legacy adoption, tombstone/restore, history, runtime authority, and
one-writer choices are resolved in [ADRs 0005–0009](decisions/README.md). M5's
credential/permission model and qualified operating policy are recorded in
[ADRs 0010](decisions/0010-scoped-client-credentials-and-permissions.md) and
[0011](decisions/0011-m5-operational-envelope.md). M6's accepted design is recorded in
accepted [ADR 0014](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md),
its completed [specification](milestones/m6-mcp-adapter.md), and [qualification
report](qualification/m6-final.md).

There are no unresolved product decisions through the final current milestone, M6.
No M7 is currently defined; any future roadmap work requires an explicit roadmap
update rather than an inferred follow-on.

Technical implementation and qualification must satisfy the specifications; milestone
order never permits weakening accepted data-loss/security prerequisites. Keep a
material decision open rather than guessing or treating a planning recommendation as
a support claim.

## Agent onboarding and execution

Read in order: [README](../README.md), [AGENTS](../AGENTS.md),
[architecture](architecture.md), this roadmap, the completed
[M6 specification](milestones/m6-mcp-adapter.md) and [qualification report](qualification/m6-final.md),
[ADR 0014](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md), then the
completed [M5 specification](milestones/m5-operational-and-security-readiness.md) and
[qualification report](qualification/m5-final.md), followed by the completed
[M4 specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
and its [sequential plan](plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[threat model](threat-model.md), [credential ADR](decisions/0010-scoped-client-credentials-and-permissions.md),
[operational-policy ADR](decisions/0011-m5-operational-envelope.md), and completed M3
[spec](milestones/m3-remote-bridge-client-and-publishing.md),
[plan](plans/m3-remote-bridge-client-and-publishing.md), and
[decisions](plans/m3-design-decisions.md). M1–M6 are COMPLETE in this completion
transition, with no milestone marked NEXT and no M7 defined. Inspect relevant
source/tests/tooling/CI,
[CONTRIBUTING](../CONTRIBUTING.md) and [SECURITY](../SECURITY.md).
[current-state](current-state.md) is an evidence map, not a substitute for code.

Repository state beats conversation assumptions; current code beats stale docs.
Correct discrepancies explicitly without changing a completed invariant silently.
Implement only NEXT. The M6 completion transition records the accepted design, implementation, and
qualification; do not infer later roadmap work.
Use [ADRs](decisions/README.md) when consequential implementation evidence requires
an explicitly accepted successor decision.

### Validation and milestone transition

- `mise install`, `mise run install`, focused mise tasks, then `mise run check`.
  Tests/coverage/build/diagnostics are necessary, not sufficient; no test deployment.
- Perform the code-review semantic/security pass after green checks. Fix and
  re-review all concrete findings; document bounded permitted deferrals explicitly.
- Check all active acceptance items. In the implementation completion PR, update
  spec/status/evidence, roadmap, current-state/architecture/API/ADRs/operations.
- Merged PR #27 records the approved M3 A1–A11 evidence; the M4 completion transition
  preceded M5 qualification. The M5 completion transition made M5 COMPLETE and M6 NEXT.
  This single M6 completion PR records final adapter evidence and marks M6 COMPLETE;
  the roadmap then has no NEXT milestone and defines no M7. The transition becomes
  canonical only when the PR merges; do not merge your own work here.
- After M6 there is no inferred M7; propose an explicit new roadmap objective.
