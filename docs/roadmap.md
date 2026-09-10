# Project roadmap

This is the canonical execution roadmap. It distinguishes implemented facts from
planned product direction. Dates are intentionally not assigned. Engineering
rules live in [AGENTS.md](../AGENTS.md), not in a parallel rule set here.

## Project end state

`obsidian-ai-bridge` lets an Obsidian user deliberately expose selected Markdown
notes to trusted remote AI/agent clients, while retaining control of the local
vault. The useful product is:

```text
Obsidian → Obsidian plugin → Cloudflare Worker → Cloudflare R2
                                  ↑
                         Remote API clients
                         Future MCP adapter
```

- Users can choose eligible content, initiate a bounded synchronization workflow,
  see progress/failures/divergence, and retry safely from Obsidian.
- R2 holds a remote mirror of selected Markdown text and only the metadata needed
  for safe reconciliation. It is not a copy of the entire vault, its credentials,
  Obsidian configuration, attachments or arbitrary files.
- Trusted clients can list/read remote notes and perform explicitly authorized
  changes through stable, validated APIs. Remote edits must not silently overwrite
  local edits. Whether they are imported through explicit review or a bounded
  bidirectional workflow is an M4 decision, not a present guarantee.
- Synchronization is opt-in and observable. Divergence preserves both versions
  until resolved; absence is not automatically interpreted as permission to
  delete. Deletion propagation requires explicit semantics and a recovery policy.
- The Worker is the remote authentication boundary; the plugin is the local-vault
  access boundary. Secrets and note content never enter diagnostic logs. The
  baseline trusts the Worker/cloud operator with note text; end-to-end encryption
  and multi-tenant hosting are not implied.
- MCP eventually adapts these established operations for agents. It does not
  create a second persistence path, bypass permissions or execute vault content
  as instructions.

Out of scope for this roadmap: replacing Obsidian Sync, general file backup,
attachments, search/indexing, embeddings, hosted AI inference, collaboration,
arbitrary filesystem access, and SaaS multi-tenancy. No additional database or
Cloudflare service is assumed. New infrastructure needs a concrete requirement
and a [decision record](decisions/README.md).

## Current state

**M1 — Worker API foundation and engineering quality — COMPLETE.** The
experimental authenticated HTTP API stores Markdown in R2; the plugin remains a
type-only scaffold. Completion means the bounded M1 foundation, not production
readiness or a functioning Obsidian bridge.

See [verified current state](current-state.md) for source evidence, limitations,
105-test baseline, coverage thresholds, tooling and CI; [architecture](architecture.md)
for boundaries; [API](api.md) for exact endpoints. This planning handoff implements
no M2 behavior and asserts no deployment or installed Obsidian environment.

## Milestone table

Exactly one milestone is `NEXT`. `PLANNED` rows are direction, not authorization to
start production code. Dependencies include all earlier milestones unless noted.

| ID | Milestone | Status | User-visible outcome | Dependency |
| --- | --- | --- | --- | --- |
| M1 | Worker API foundation and engineering quality | COMPLETE | Authenticated remote Markdown CRUD/listing with R2 and an enforced quality gate | None |
| M2 | Obsidian read-only local-vault adapter | NEXT | Load the plugin and explicitly inspect eligible local notes without modifying or sending them | M1 |
| M3 | Remote bridge client and explicit publishing | PLANNED | Deliberately publish selected notes and inspect remote state with clear, safe failure behavior | M2 |
| M4 | Safe reconciliation, conflicts and deletions | PLANNED | Reconcile local/remote changes without silent data loss; review divergent and deleted notes | M3 |
| M5 | Operational and security readiness | PLANNED | Operate and recover a bounded personal bridge with documented limits and trust assumptions | M4 |
| M6 | MCP adapter | PLANNED | Use the same authorized bridge operations from MCP-capable agents | M5 |

### M1 — Worker API foundation and engineering quality

- **Objective/scope:** Versioned Hono HTTP transport, single-token authentication,
  canonical path validation, 1 MiB text limit, typed core service/repository port,
  R2 adapter, Zod/OpenAPI/Scalar, sanitized errors and LogTape; strict tooling,
  dedicated unit/integration tests and coverage-enforced CI.
- **Non-goals:** Plugin runtime, synchronization, concurrency protection,
  permissions beyond the token, recovery and production readiness.
- **Risks retained:** Unconditional remote replacement/deletion, single-token
  blast radius, whole-list scaling, runtime/OpenAPI permissiveness gap. These
  limitations do not become safe sync semantics merely because M1 is complete.
- **Exit criteria met:** Implemented route/path/payload/storage/auth behavior is
  covered by the existing suite; canonical `mise run check` validates formatting,
  semantic lint, types, coverage and both bundles. Manual semantic review and API/
  architecture docs accompany the merged engineering work.

### M2 — Obsidian read-only local-vault adapter

- **Objective/scope:** Replace the scaffold with a loadable plugin, a read-only
  local port/application service and official Obsidian adapter. Explicit commands
  inspect eligible note paths and read the active saved note, showing metadata
  only. Add plugin tests, loadable build packaging and development instructions.
- **Non-goals:** Network calls, token/settings persistence, mirror selection UX,
  watchers/schedulers, local writes/deletes, remote client, sync or MCP.
- **Risks:** Confusing local literal paths with URL decoding, changed files during
  reads, sensitive UI/log output, untested host packaging and accidental mutation.
- **Exit criteria:** Every checklist item in the
  [implementation-ready specification](milestones/m2-obsidian-read-only-local-adapter.md)
  is met, local-only/read-only guarantees are tested, plugin tests run in the
  canonical gate, bundle compatibility is verified, and handoff docs are updated.
- **Decisions deferred:** Eligibility for local inspection is **not** consent to
  mirror. Remote selection/settings begin in M3; conflict/import policy in M4.

### M3 — Remote bridge client and explicit publishing

- **Objective/scope:** A typed remote adapter over the existing REST boundary;
  opt-in connection settings, response validation, selected local-to-remote
  publishing and remote inspection. Display per-operation outcomes and divergence.
- **Non-goals:** Automatic bidirectional sync, local note mutation, delete
  propagation, background queues, MCP or new infrastructure by default.
- **Decisions before implementation:** Selection/default exclusion policy;
  Worker URL/HTTPS and credential storage UX; initial mirror association and
  existing-remote-content policy; explicit triggering; timeouts, cancellation and
  bounded retry; minimum remote revision/precondition contract. Reconcile the M1
  runtime/OpenAPI gap and validate returned paths beyond string schemas.
- **Safety gate/risks:** M1 GET-then-PUT cannot prevent a race. Before publishing
  to an existing or apparently absent path, specify and test server-enforced
  conditional mutation or another demonstrated safe approach. Do not implement
  a naive overwrite loop and defer safety to M4. If the required protocol change
  materially expands scope, revise this milestone before coding.
- **Exit criteria:** A user explicitly selects and publishes notes to a configured
  bridge; existing/concurrent remote changes cannot be silently lost; no local
  writes/deletes occur; auth/network/malformed-response/partial-failure paths are
  visible and tested; protocol/OpenAPI compatibility and secret handling are
  documented; detailed M3 acceptance checklist and canonical gate pass.
- **Deferred concerns:** Full reconciliation history, remote edit import, rename/
  delete handling and durable offline work belong to M4. M5 handles operating
  scale and auth evolution, not prerequisites to safe first use.

### M4 — Safe reconciliation, conflicts and deletions

- **Objective/scope:** Build on safe publishing to track change baselines,
  detect divergence, preserve conflicting versions, and provide explicit recovery/
  resolution flows. Define remote-to-local import, renames and deletion semantics
  before enabling them.
- **Non-goals:** Silent last-writer-wins, blanket remote authority over a vault,
  collaborative real-time editing, attachments or a general sync replacement.
- **Decisions before implementation:** Primary sync direction and source authority;
  reviewed import versus bounded bidirectionality; revision/baseline metadata;
  conflict representation and resolution UX; delete/tombstone retention and
  recovery; renames; offline queue persistence, retries and interrupted-run
  reconciliation; automatic triggers (if any). Record durable decisions as ADRs.
- **Risks:** Data loss, resurrection of deleted notes, stale local reads, concurrent
  clients, partial writes, crash recovery and unbounded retained metadata.
- **Exit criteria:** Documented state transitions and deterministic scenario tests
  cover concurrent edits, missing notes, deletes/renames, offline/restart and
  partial failure; all permitted local writes are guarded and visible; conflicts
  preserve recoverable content; absence alone causes no deletion; implemented
  recovery can be exercised with fakes; protocol/docs and canonical gate pass.
- **Deferred concerns:** Fleet/user identity and operating envelope remain M5;
  MCP remains M6. Do not choose D1/queues/coordination services without a concrete
  correctness need that existing Worker/R2 primitives cannot satisfy.

### M5 — Operational and security readiness

- **Objective/scope:** Define and validate the supported operating envelope for a
  personal bridge: setup/upgrade/rollback/recovery runbooks, bounded resource use,
  safe diagnostics, credential lifecycle and a reviewed threat model.
- **Non-goals:** Claiming security certification, guaranteed scale, multi-tenant
  SaaS or adding services merely for hypothetical future load.
- **Decisions before implementation:** Single-token sufficiency versus scoped
  read/write/delete clients or device identities; rotation/revocation/migration;
  list pagination/rate/size limits and abuse handling; backup/recovery guarantees;
  supported platforms/releases; log retention/redaction and public documentation
  exposure. Earlier milestones must pull forward any prerequisite security fix.
- **Risks:** Token compromise, operator error, misleading readiness claims,
  unbounded lists/retries/storage and credential leakage in diagnostics.
- **Exit criteria:** Limits and permissions match implementation; recovery and
  credential lifecycle are tested/documented; supported setup/upgrade workflows
  and residual risks are explicit; security review, canonical gate and semantic
  review pass. Deployment is a separately authorized operator action, not a task
  implied by milestone completion.
- **Deferred concerns:** Agent-facing transport is M6; capabilities outside the
  personal-bridge scope require a new roadmap decision.

### M6 — MCP adapter

- **Objective/scope:** Expose the established authorized note operations through
  a thin MCP adapter over the bridge, with discoverable tool contracts and safe
  error mapping. Reuse application/protocol policy, not R2 access shortcuts.
- **Non-goals:** A separate sync engine, unrestricted filesystem tools, executing
  instructions found in notes, AI inference, search or bypassing permissions.
- **Decisions before implementation:** Hosting/transport location, client auth
  mapping, tool/resource surface, mutation confirmation and content-size limits.
- **Risks:** Excessive agent privileges, prompt injection through note content,
  divergence from REST contracts and accidental sensitive tool/log output.
- **Exit criteria:** Supported MCP clients can exercise the documented permitted
  operations; auth and mutation boundaries hold; content remains untrusted data;
  contract/error/security tests and canonical gate pass; setup and capabilities
  are documented without claiming untested client compatibility.
- **Deferred concerns:** Any new product capability beyond adapting the existing
  bridge needs an explicit roadmap revision, not an extra MCP-only feature.

## Unresolved product decisions

These are open questions, not implicit requirements. Resolve them at the earliest
listed milestone, before the affected code. A materially ambiguous decision needs
maintainer clarification or a documented proposal, not an agent's silent guess.

| Decision required | Earliest milestone | Boundary until resolved |
| --- | --- | --- |
| Which notes/folders are mirrored, opt-in defaults, exclusions and selection UX | M3 | M2 inspection never authorizes uploading anything |
| Endpoint configuration, HTTPS/local-dev exceptions, token entry/storage UX | M3 | No connection settings or secrets in M2 |
| Initial sync/remote association, safe existing-content handling and conditional writes | M3 | No automatic upload or unconditional overwrite loop |
| Manual trigger UX, cancellation, bounded network timeouts/retries | M3 | M2 commands are local only; no scheduler |
| Primary synchronization direction and remote-to-local import authority | M4 | M3 publishes outward only; no local writes |
| Conflict state, resolution UX and revision/baseline persistence | M4 | M3 detects/refuses unsafe replacement; does not merge |
| Remote/local deletes, tombstones, retention/recovery and renames | M4 | No absence-driven propagation; existing API DELETE remains destructive |
| Durable offline queue, restart behavior, automatic sync triggers | M4 | No hidden backlog or automatic background mutation |
| Per-client permissions, token evolution and credential lifecycle | M5 | Single bearer grants the entire remote API; never describe it as scoped access |
| Supported scale, public pagination, abuse controls, release/backup/operations policy | M5 | Experimental foundation, not production guarantees |
| MCP hosting, transport, tools/resources and permission mapping | M6 | No MCP dependencies or contracts yet |

Milestone ordering never justifies deferring a known data-loss or security blocker.
Move the needed decision forward explicitly and update the spec/roadmap before
implementing it. Future rows are intentionally not implementation-level specs.

## Agent onboarding and execution

Read in order:

1. [README.md](../README.md)
2. [AGENTS.md](../AGENTS.md)
3. [docs/architecture.md](architecture.md)
4. [docs/roadmap.md](roadmap.md) (this file)
5. The specification linked by the `NEXT` milestone, currently
   [M2](milestones/m2-obsidian-read-only-local-adapter.md).

Then inspect the relevant source, tests, `.mise.toml`, coverage and CI, plus
[CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md). Use
[current-state.md](current-state.md) as an evidence map, not a substitute for reads.
Repository state beats chat assumptions; current code beats stale descriptions.
Report discrepancies and correct docs rather than quietly changing completed
behavior to fit a remembered conversation.

Implement only `NEXT`. If its spec is absent or not implementation-ready, write/
refine it first and surface material unresolved decisions. Follow
[ADR guidance](decisions/README.md) for durable architectural choices.

### Validation and milestone transition

- Install with `mise install` and `mise run install`; use focused mise tasks while
  working and run `mise run check` before completion. Never deploy as validation.
- Add behavioral tests, keep coverage inclusion/thresholds intact, check editor
  diagnostics, and perform the semantic/security review in `AGENTS.md` after the
  automated gate succeeds. Link evidence and any justified deferrals in the PR.
- Check the active spec's entire acceptance checklist. Green CI alone is not
  milestone completion; unresolved exit criteria keep the milestone active.
- In the completion PR, update the spec with status and validation evidence, this
  roadmap, current-state/architecture/API docs as affected, ADRs and operational
  instructions. Preserve completed milestone invariants.
- Only after that completion evidence exists, mark the completed row `COMPLETE`
  and the immediately following eligible row `NEXT` (exactly one). Draft/refine
  the following milestone's detailed spec before any production implementation;
  link it here and update README's active-spec link. A `NEXT` row without a ready
  spec authorizes planning only. The transition becomes canonical when merged.
- Do not begin the following milestone in the same implementation PR. After M6,
  there is no automatic M7: document an explicit new objective with the maintainer.

A future session can start with:

> Continue according to the repository roadmap. Read AGENTS.md and the active
> milestone spec first. Implement only NEXT, validate it completely, update the
> roadmap/docs, and open a PR. Do not deploy.
