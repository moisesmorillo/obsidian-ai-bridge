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
        Cloudflare Worker ← authorized REST clients / future MCP adapter
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
  divergence, not permission to overwrite or import. M4 decides reviewed import
  versus bounded bidirectionality and explicit conflict/adoption/restoration flows.
- An observed post-bootstrap Obsidian delete event for an already-associated eligible
  note authorizes recoverable mirror removal, including iCloud/external activity.
  No human-provenance claim or per-delete confirmation. Startup/scan absence never
  authorizes deletion; permanent revisioned heads prevent unsafe resurrection.
- The Worker authenticates remote clients; the plugin accesses local vault data.
  The host/Worker/cloud operator are trusted with plaintext. One bearer remains
  privileged; mirror inclusion and writer IDs are not per-client permissions.
- MCP will adapt established authorized operations, not bypass Worker/application
  policy or access R2 directly. It never executes instructions found in notes.

Outside this roadmap: replacing iCloud/Obsidian Sync, general file backup,
attachments, search/indexing, embeddings/inference, collaboration, arbitrary
filesystem access and SaaS multi-tenancy. No additional database/service is assumed.
New infrastructure requires a concrete need and [ADR](decisions/README.md).

## Current state

**M2 — Obsidian read-only local-vault adapter — COMPLETE**, merged at `b300726`
(PR #7). The plugin preserves explicit metadata-only local inspection. M1's
independent Worker/R2 foundation now also carries M3's safe v2 routes and retired v1
mutations. Slices 0–7 compose an experimental connected outward mirror, not a
production-ready or remote-to-local system. M3 remains NEXT pending Slice 8's final
independent review and completion transition. Slice 0 qualifies the pinned local
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
[operator guide](operations.md); final independent semantic review remains pending.

See [current-state evidence](current-state.md), [architecture](architecture.md),
[implemented API](api.md), [M2 completion](milestones/m2-obsidian-read-only-local-adapter.md#completion-evidence)
and [M2 plan](plans/m2-obsidian-read-only-local-adapter.md). Current test counts
and coverage evidence are recorded in [current-state](current-state.md); no deployed Worker or real Obsidian desktop/mobile
host was exercised. New M3 test requirements are not existing coverage.

## Milestone table

Exactly one milestone is `NEXT`. Later rows are direction, not permission to start
production code. Dependencies include all previous milestones.

| ID | Milestone | Status | User-visible outcome | Dependency |
| --- | --- | --- | --- | --- |
| M1 | Worker API foundation and engineering quality | COMPLETE | Authenticated remote Markdown CRUD/listing with R2 and enforced quality gate | None |
| M2 | Obsidian read-only local-vault adapter | COMPLETE | Explicit local inspection without sending or changing notes | M1 |
| M3 | Automatic eligible-Markdown remote mirror | NEXT | Whole eligible saved vault mirrors outward, including recoverable removals/renames, with one designated writer | M2 |
| M4 | Remote-to-local reconciliation and conflict resolution | PLANNED | Review/adopt/resolve remote divergence and richer restoration without silent local data loss | M3 |
| M5 | Operational and security readiness | PLANNED | Operate a bounded personal bridge with reviewed limits, permissions and runbooks | M4 |
| M6 | MCP adapter | PLANNED | Same authorized operations for MCP-capable agents | M5 |

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

**NEXT — Slices 0–8 implementation and automated/operational gates are present on the completion PR; final independent semantic review and the milestone transition remain. M3 is not complete or deployed.**
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
- **Exit:** detailed A1–A11 checklist, observed automatic full eligible behavior,
  tested deletes/recovery/rename/restart/handoff, bounded typed failures and diagnostics,
  canonical/coverage/artifact/platform gates and post-green semantic review; docs
  reflect actual code. No remaining material M3 decision.
- **Non-goals:** remote-to-local writes, merging/arbitrary adoption, richer restore
  UX, multi-writer coordination, scheduled polling/cleanup, MCP or new infrastructure.

### M4 — Remote-to-local reconciliation and conflict resolution

**PLANNED.** The [refined planning specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
defines the decision and evidence gates required before production implementation;
M3 completion does not pre-authorize M4 code.

- **Scope:** build on M3 baselines/tombstones/recovery to resolve divergence,
  explicitly adopt existing/legacy paths, import remote changes safely and offer
  richer conflict/restoration UX. Complex deferred rename/history reconciliation
  belongs here, not a reason to postpone M3's ordinary local rename handling.
- **Decisions:** reviewed import versus bounded bidirectionality, authority for each
  permitted local mutation, conflict preservation/merge UI, remote deletion import,
  recovery/adoption/reset workflows and any future cross-device expansion. M3's
  outward triggers, ordinary tombstones, 30-day window and single-writer design are
  already decided; do not reopen them implicitly.
- **Risks/exit:** deterministic concurrent edit/delete/rename/offline/restart tests,
  guarded local writes, preserved divergent versions and safe exercised restoration;
  absence alone never silently deletes. Protocol/docs, quality gate and review pass.
- **Non-goals:** silent last-writer-wins, blanket remote authority, collaboration,
  attachments or replacement of working-vault sync. No new coordinator/store unless
  a concrete accepted correctness need requires it.

### M5 — Operational and security readiness

- **Scope:** supported operating envelope, threat model, setup/upgrade/rollback/
  backup/recovery runbooks, abuse limits and credential lifecycle. M3 pulls forward
  conditional safety, v2 pagination and basic recovery required for safe mirroring.
- **Decisions:** scoped read/write/delete clients versus existing privileged bearer;
  revocation/migration, broader quotas/abuse controls, releases/platform support,
  recovery automation/retention operations and logging retention/public docs.
- **Risks/exit:** truthful limits/permissions, tested runbooks/rotation/recovery,
  bounded resources and reviewed secrets/diagnostics. No security certification,
  SaaS scale or full-backup guarantee without concrete evidence.
- Deployment is separately authorized, not implied by validation/completion.

### M6 — MCP adapter

- **Scope:** thin MCP transport over established authorized application operations,
  discoverable contracts and safe errors. No direct R2 shortcut or separate sync engine.
- **Decisions:** hosting/transport, authentication/permission mapping, tool/resource
  surface, confirmation and content limits. Mirror eligibility is not this policy.
- **Risks/exit:** excessive agent privilege, prompt injection and sensitive output;
  contract/auth/mutation tests, quality/semantic gates and actual supported-client
  evidence. Notes remain untrusted data, never executable instructions.
- No MCP-only inference/search/product expansion without a new roadmap decision.

## Unresolved product decisions

**None for M3.** Its accepted choices and primary-source limits are in the
[decision brief](plans/m3-design-decisions.md). Required host/storage qualification
is technical validation, not an excuse to revert to selected/manual publishing.
Future questions remain open and must be resolved before affected code:

| Decision required | Earliest milestone | Boundary until resolved |
| --- | --- | --- |
| Remote-to-local authority, reviewed import versus bidirectionality | M4 | M3 is local→remote; remote divergence is not overwritten/imported |
| Conflict/adoption/restoration UX and complex deferred histories | M4 | M3 preserves baselines/recovery and reports blockers; no merge or arbitrary adoption |
| Any expansion beyond one designated writer | M4 or separately approved revision | No election/leases/shared-file transaction or automatic takeover |
| Scoped API/MCP client permissions and credential evolution | M5 | Bearer remains privileged; device IDs/eligibility are not permissions |
| Operating scale, abuse controls, release/backup/recovery automation | M5 | Experimental bridge; finite M3 bounds and basic recovery do not prove production readiness |
| MCP hosting, transport, tools/resources and auth mapping | M6 | No MCP implementation or direct storage access |

Milestone order never justifies deferring a data-loss/security prerequisite. Move
required decisions forward explicitly; surface material ambiguity rather than guess.

## Agent onboarding and execution

Read in order: [README](../README.md), [AGENTS](../AGENTS.md),
[architecture](architecture.md), this roadmap, the single NEXT
[M3 spec](milestones/m3-remote-bridge-client-and-publishing.md),
[plan](plans/m3-remote-bridge-client-and-publishing.md) and
[decisions](plans/m3-design-decisions.md). Inspect relevant source/tests/tooling/CI,
[CONTRIBUTING](../CONTRIBUTING.md) and [SECURITY](../SECURITY.md).
[current-state](current-state.md) is an evidence map, not a substitute for code.

Repository state beats conversation assumptions; current code beats stale docs.
Correct discrepancies explicitly without changing a completed invariant silently.
Implement only NEXT after an implementation request. A planning PR does not itself
implement/finish a milestone or authorize deployment. If a later spec is not ready,
refine it and surface material decisions first; use [ADRs](decisions/README.md).

### Validation and milestone transition

- `mise install`, `mise run install`, focused mise tasks, then `mise run check`.
  Tests/coverage/build/diagnostics are necessary, not sufficient; no test deployment.
- Perform the code-review semantic/security pass after green checks. Fix and
  re-review all concrete findings; document bounded permitted deferrals explicitly.
- Check all active acceptance items. In the implementation completion PR, update
  spec/status/evidence, roadmap, current-state/architecture/API/ADRs/operations.
- For M3 Slice 8, leave M3 NEXT and M4 PLANNED while the independent final review is
  pending. After APPROVE, one corrective/finalization commit may mark M3 COMPLETE,
  mark M4 NEXT (exactly one NEXT), update active links/PR evidence, and keep M4
  production code out of the completion PR. Transitions become canonical when
  merged; do not merge your own work here.
- After M6 there is no inferred M7; propose an explicit new roadmap objective.
