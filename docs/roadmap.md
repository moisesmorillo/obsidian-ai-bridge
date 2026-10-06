# Project roadmap

The post-M6 [client authorization design note](plans/client-scoped-authorization.md)
records requirements to review before connecting a vault. [Accepted ADR 0015](decisions/0015-browser-mediated-client-authorization.md)
describes the staged OAuth and revocation design for that rollout.
The [bidirectional vault sync rollout proposal](plans/bidirectional-vault-sync-rollout.md)
and [proposed ADR 0016](decisions/0016-bidirectional-vault-sync.md) describe
a post-M6 product direction. The delivered [M7 specification](milestones/m7-versioned-sync-protocol-and-r2-store.md)
defines the isolated protocol/storage foundation. [ADR 0020](decisions/0020-private-sync-store-delivery-and-activation-gate.md)
closed M7 as **private isolated store delivery** in merged #107, not operational
readiness. [M8 — local Markdown sync demo](milestones/m8-local-markdown-sync-demo.md)
is NEXT after specification PR #110 merged (`2c96711`), under owner-accepted
[ADR 0021](decisions/0021-isolated-local-markdown-sync-demo.md). Only isolated
synthetic local composition is authorized; the
[criterion report and mandatory activation blockers](qualification/m7-delivery-and-activation-gate.md)
retain the production/real-data evidence boundary. It does not change the implemented single-writer support claim,
activate a production writer, or migrate a vault. M7.1/M7.2 are complete;
M7.3's isolated R2 primitives merged in PR #95. M7.4's private journal, feed,
inventory and crash recovery merged in PR #97 at `62696b0`, including the terminal
inventory failure correction; see [local evidence](qualification/m7-private-sync-store-local.md).
Its remote Workers Free CPU/account qualification remains pending under the
[qualification plan](plans/m7-sync-store-qualification.md). The owner has narrowed
local execution to [proportional safety qualification](qualification/m7-proportional-local-scope.md):
retain completed 5,000/10,000 maximal profiles and 5,000 copied cleanup, stop the
20,001-page sparse run as unqualified, and launch no further large stress runs.
Small critical safety cases remain in scope. The real-day expiry task was killed
at Pi shutdown after 13 h 59 min; no approved expiry result exists and no new long
run is authorized.
This is not a reduction of implemented limits or approval of a smaller support claim.
The owner-approved ADR 0020 reconciles delivery and qualification without a 1,000-note
limit: real expiry remains incomplete, and native safety/Workers Free/real R2/account
requirements are mandatory G1–G6 blockers, not passed criteria. M7 COMPLETE is never
permission to activate sync. The test-only local profiling harness merged in PR #99 at `306aa35`;
its [0/1-head baseline evidence](qualification/m7-inventory-profile-harness.md)
does not close scale or remote gates. The subsequent
[1,000-head local profile](qualification/m7-inventory-profile-1000.md) completed in
about 39 min 30 s under an explicitly extended 90-minute process budget, with full
traversal and host-resource observations. Later 5,000/10,000 maximum-encoded
profiles have executed locally; their source-bound results and scope limitations
are recorded in the proportional qualification note, not inferred from the baseline.
The owner authorized synthetic local execution on 2026-10-05, not remote access or deployment.
The [maximum-encoded fixture](qualification/m7-maximum-encoded-heads.md) reaches the
2,048-byte head ceiling; fast regressions do not certify unexecuted scale profiles. No later-milestone production code or
remote deployment is authorized by this profiling work. The focused
[native cleanup contract subset](qualification/m7-native-inventory-cleanup.md)
adds canonical v1/v2 deletion/preservation, owned/competing-slot CAS and
lost DELETE/read-back regressions under an injected clock; the remaining qualification gates stay open after private delivery.

This is the canonical execution roadmap: implemented facts, planned direction and
unresolved choices are distinct. Dates are intentionally not assigned. Engineering
rules live in [AGENTS.md](../AGENTS.md).

## Proposed future target

**Proposed:** `obsidian-ai-bridge` synchronizes local working vaults
on Mac, iPhone, and iPad through an authenticated service backed initially by
private R2. Authorized API/AI/agent clients participate in the same revision
domain. The complete target and migration gates are in [the rollout proposal](plans/bidirectional-vault-sync-rollout.md).
This target supersedes the earlier mirror-only direction; it does not retroactively
change M1–M6 behavior or qualification.

```text
Mac local vault ───┐
iPhone local vault ├── bridge plugin ↔ Worker/API ← REST and MCP clients
iPad local vault ──┘                        |
                                  private R2 sync store
```

- The target replaces iCloud for **vault synchronization**, with local offline
  copies and remote-to-local as well as local-to-remote changes. The current
  deployed release still uses iCloud and its one-writer Markdown mirror.
- Target scope includes Markdown, Canvas and user attachments. Portable Obsidian
  configuration is selective; credentials, the bridge ledger, caches, and
  device-local settings are excluded. Current `.md` and 1 MiB limits remain
  implemented facts until a separately qualified change supersedes them.
- Each device has its own revocable grant. Per-path versions and conditional
  mutations preserve concurrent changes for review; initial absence cannot
  delete remote content. Authorized REST/MCP revisions auto-apply to a device
  only when its local state matches the exact acknowledged base and all
  preconditions pass. A never-seen create requires a fresh complete local
  absence/alias check with no pending intent or observation gap; conflicts and
  unknown effects require review.
- R2 initially owns shared sync state, but is **not an independent backup**.
  The Worker/operator remain trusted with plaintext. A storage port keeps R2
  details out of the protocol so a future NAS backend can be qualified against
  the same semantics; a NAS migration is not yet specified or deployed.
- Mobile sync runs while Obsidian is open or resumed. No suspended-iOS background
  freshness claim is made. Cutover from iCloud requires independent backup,
  disposable-device qualification, and explicit per-device verification.

Outside the proposed target: general filesystem backup, search/indexing,
embeddings/inference, collaborative real-time editing, arbitrary filesystem
access and SaaS multi-tenancy. New infrastructure needs a concrete need and
an [ADR](decisions/README.md).

## Current state

**M3 — Automatic eligible-Markdown remote mirror — COMPLETE.** PR #27 merged at
`63b0599` and made the M3→M4 transition canonical. M1 and M2 remain complete; M2 merged at
`b300726` (PR #7) and its metadata-only inspection remains available. M3 Slices 0–8
compose an experimental connected outward mirror, not a production-ready or
remote-to-local system. Canonical validation passed, the final semantic review's three
MINOR findings were corrected at `e97af36`, and the corrective review returned APPROVE
with no open findings. M4 Slices 1–8 and M5 are COMPLETE; M6 is COMPLETE. M7 — versioned sync protocol and isolated R2 store — is COMPLETE as private delivery. M8 is NEXT after #110's accepted local-demo specification merge; that transition itself implemented no M8 behavior. The separate local API is the first functional delivery; the client/plugin and two-vault demonstration remain pending. M5's support claim is limited to the latest v1.0.2 release and its exact [qualification report](qualification/m5-final.md). M4's reviewed-only authority, preservation, local mutation,
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

A milestone is `NEXT` only while its prerequisites and implementation-ready
specification authorize implementation. M1–M6 retain their completed scope; M7 is
COMPLETE only as private isolated delivery under merged ADR 0020. The owner accepted
M8's synthetic local exception under ADR 0021; **M8 is NEXT after merged #110**.
Delivery 1 is the isolated local API; M8 remains incomplete. No remote qualification or production
activation is implied. Dependencies include the previous delivered milestones,
not acceptance of their still-open operational gates for real-data use.

| ID | Milestone | Status | User-visible outcome | Dependency |
| --- | --- | --- | --- | --- |
| M1 | Worker API foundation and engineering quality | COMPLETE | Authenticated remote Markdown CRUD/listing with R2 and enforced quality gate | None |
| M2 | Obsidian read-only local-vault adapter | COMPLETE | Explicit local inspection without sending or changing notes | M1 |
| M3 | Automatic eligible-Markdown remote mirror | COMPLETE | Whole eligible saved vault mirrors outward, including recoverable removals/renames, with one designated writer | M2 |
| M4 | Remote-to-local reconciliation and conflict resolution | COMPLETE | Review/adopt/resolve remote divergence and richer restoration without silent local data loss | M3 |
| M5 | Operational and security readiness | COMPLETE | Latest-only, bounded v1.0.2 software support with reviewed limits, permissions, runbooks and qualification evidence | M4 |
| M6 | MCP adapter | COMPLETE | Same authorized operations for MCP-capable agents through the M5 authentication and application-service boundary; bounded official-client qualification complete | M5 |
| M7 | Versioned sync protocol and isolated R2 store | COMPLETE (private delivery) | Uncomposed contracts/`SyncStore`/R2 adapter, feed, inventory/evidence and recovery; local 5k/10k evidence retained, **not operational qualification**. All applicable G1–G6 gates block productive exposure and real data | M6 |
| M8 | [Local Markdown sync demo](milestones/m8-local-markdown-sync-demo.md) | NEXT — delivery 1 | Separate loopback Worker/API and experimental plugin; two disposable or simulated vault instances, REST-origin edits and concurrent-version preservation. No production activation | M7 private delivery; ADR 0021 local-only exception |

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

**COMPLETE.** The implementation-ready [M6
specification](milestones/m6-mcp-adapter.md), accepted [ADR
0014](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md), and [final
qualification report](qualification/m6-final.md) record the adapter, tests, canonical
validation, official-client evidence, and residual compatibility limits. The M6
completion PR has merged; later OAuth and sync proposals have separate status.

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
- No MCP-only inference/search/product expansion. M6 remains complete and unchanged;
  M7 is separately scoped to isolated protocol/storage foundations.

## Next functional work and activation boundary

The owner-accepted [M8 specification](milestones/m8-local-markdown-sync-demo.md)
merged in #110 and authorizes three sequential functional deliveries: isolated
local Worker/REST, durable exact-base client reconciliation, then experimental
plugin composition and a two-instance demonstration. The [local API guide](local-sync-demo.md)
and [implementation/evidence ledger](plans/m8-local-sync-api.md) describe delivery 1;
client/plugin implementation and final two-vault evidence remain pending. Tests accompany each new
behavior; do not open PRs solely to expand qualification matrices. Report concrete
demo blockers promptly. Use actual disposable desktop hosts when available;
otherwise label the accepted two-simulated-instance fallback precisely.

Merged #109 supplies [bounded native finalization/release evidence](qualification/m7-native-inventory-finalization.md),
not full G1 acceptance. G1–G6 still block productive/public exposure, real data and
cutover: safety conformance, expiry, real R2, runtime feasibility, workload/account
admission and client/migration readiness. ADR 0021 permits only synthetic loopback
composition and disposable local effects; it closes none of these gates. No
Cloudflare/personal-vault access, deployment, production activation, migration or mobile
qualification is authorized. Current release routes and writer remain unchanged.

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

There are no unresolved product decisions through completed M6. M7's protocol,
namespace, v2 coexistence, fair feed, resumable inventory progress/subrequest bounds,
same-key write pacing, and recovery choices are defined in its
[implementation-ready specification](milestones/m7-versioned-sync-protocol-and-r2-store.md).

The proposed bidirectional sync direction has remaining decisions before later client
enrollment or personal-vault cutover: path equivalence across devices, supported file
limits beyond M7's Markdown foundation, configuration categories, independent backup
retention, and real-host/mobile qualification. The [proposal
plan](plans/bidirectional-vault-sync-rollout.md#decisions-to-close-before-personal-vault-cutover)
tracks their evidence. The owner selected automatic application for authorized
REST/MCP revisions under exact-base safety; this proposed policy does not
change current M4 reviewed effects. These choices do not reopen completed
M1–M6 milestones.

Technical implementation and qualification must satisfy the specifications; milestone
order never permits weakening accepted data-loss/security prerequisites. Keep a
material decision open rather than guessing or treating a planning recommendation as
a support claim.

## Agent onboarding and execution

Read in order: [README](../README.md), [AGENTS](../AGENTS.md),
[architecture](architecture.md), this roadmap, the [M7 specification](milestones/m7-versioned-sync-protocol-and-r2-store.md),
the [proposed sync ADR](decisions/0016-bidirectional-vault-sync.md) and [rollout
plan](plans/bidirectional-vault-sync-rollout.md), then the completed
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
[decisions](plans/m3-design-decisions.md). M1–M6 are COMPLETE; M7 is COMPLETE as
private delivery following merged ADR 0020 (#107). Read the accepted
[M8 specification](milestones/m8-local-markdown-sync-demo.md) and
[ADR 0021](decisions/0021-isolated-local-markdown-sync-demo.md) before local-demo
work; M8 is NEXT only after its specification PR merges. Inspect relevant
source/tests/tooling/CI,
[CONTRIBUTING](../CONTRIBUTING.md) and [SECURITY](../SECURITY.md).
[current-state](current-state.md) is an evidence map, not a substitute for code.

Repository state beats conversation assumptions; current code beats stale docs.
Correct discrepancies explicitly without changing a completed invariant silently.
Before the M8 specification PR merges, no M8 implementation is authorized.
After merge, implement only its bounded functional local-demo deliveries; routine
choices within the accepted scope do not require renewed approval. The M6
completion transition records its accepted design, implementation and qualification;
do not infer production activation or later rollout stages from M8.
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
  The M6 completion PR records final adapter evidence and marks M6 COMPLETE. The original transition made M7 NEXT. ADR 0020's current documentation-only
  transition closes M7 as private delivery; its merge does not approve G1–G6.
- M7 completion must not activate sync or imply a personal-vault cutover. M8 is an
  explicit local-only successor, not permission inferred from M7 COMPLETE. G1–G6
  acceptance and owner activation approval remain mandatory for productive exposure
  and real-data use; no following milestone is authorized by the M8 transition.
