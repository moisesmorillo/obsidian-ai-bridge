# M5 — Operational and security readiness

**Status: NEXT — Slices 0–3 complete; Slice 4 is next.** M1–M4 remain COMPLETE and M6 remains PLANNED. Slice 2 implements the credential registry, typed principal, offline lifecycle, and explicit singleton migration checkpoint. Slice 3 implements client-attributed content-free live diagnostics while preserving zero-day retention. Route-level permission enforcement remains unimplemented until Slice 4, and no current release or platform is supported.

## Objective

Establish and qualify a bounded operating envelope for the personal bridge: scoped
and revocable remote clients, explicit operation permissions, abuse/resource limits,
credential and recovery lifecycle, truthful support/release claims, and evidence-based
runbooks. Preserve every M3/M4 data-safety invariant while replacing the single
privileged bearer with a least-privilege client principal model.

M5 completion will mean the repository can support a specifically documented personal
operating envelope. It will not mean security certification, SaaS/multi-tenant scale,
complete-backup guarantees, uninterrupted availability, protection from a fully
privileged host/cloud operator, deployment, or automatic authorization of a real
personal-vault installation.

## Normative Slice 0 foundation

- [Consolidated threat model](../threat-model.md): assets, trust boundaries, threat
  actors, existing mitigations, M5 gaps, residual risk, and slice ownership.
- [ADR 0010](../decisions/0010-scoped-client-credentials-and-permissions.md): bounded
  named opaque bearer credentials, typed client principals, closed permissions,
  digest-only registry, revocation, rotation, and registry-loss lifecycle.
- [Roadmap](../roadmap.md): milestone order and the accepted Slice 1 operating-policy summary.

Repository implementation and completed ADRs remain authoritative for current M1–M4
behavior. Slice 0 changes no Worker route, authentication behavior, plugin manifest,
Cloudflare binding, dependency, test contract, deployment, or credential.

## Scope

- Evidence-based practical supported operating envelope for a personal eligible-
  Markdown vault.
- Bounded named client credential registry, secure provisioning, independent
  revocation, manual overlap rotation, and total-registry-loss response.
- Typed remote client principals and one closed `read`/`write`/`delete` permission
  model, with an exhaustive route-operation authorization table.
- Per-client and/or per-operation abuse/resource controls selected from measured need,
  with explicit failure and retry semantics.
- Client-attributed, content-free operational diagnostics and an accepted retention
  contract.
- Setup, upgrade, rollback, credential incident, writer handoff, backup/recovery, and
  recovery-maintenance procedures consistent with existing effect certainty.
- Explicit supported release/platform window and qualification evidence.
- Complete v1 read retirement before any M5 operational-support claim.
- Documentation and final semantic/security review proving the implemented boundary
  matches the accepted decisions.

## Non-goals

- MCP implementation, MCP tools/resources, MCP hosting, or MCP-specific credentials.
- OAuth, OIDC, JWT, Cloudflare Access, cookies, users, tenants, collaboration, or
  per-note/folder/tag ACLs.
- Automatic multi-writer election, leases, silent writer takeover, or redesign of the
  M3/M4 association and designated-writer model.
- Search, embeddings, inference, attachments, arbitrary files, or Markdown execution.
- Automatic bidirectional sync, silent conflict resolution, weaker conditional writes,
  local delete/move, or bypass of M4 reviewed authority.
- A new database, queue, storage service, Cloudflare Rate Limiting binding, or other
  infrastructure without new workload/incident evidence and, when consequential, a
  successor ADR.
- Deployment, production certification, complete backup, exact physical erasure,
  disaster-recovery guarantee, or unsupported desktop/mobile/background-iOS claim.
- Completing v1 retirement, recovery automation, release tooling, or platform
  qualification inside Slice 0.

## Inherited invariants

- R2 remains private plaintext mirror/API persistence, not the sole source of truth or
  guaranteed complete backup. Remote clients never receive direct R2 credentials.
- One designated plugin writer remains. Association/writer IDs are non-secret
  mutation guards, not client authentication or permissions.
- Authentication, client permission, designated-writer checks, conditional revision/
  receipt policy, and reviewed local authority remain distinct gates.
- Current v2 application revisions, CAS, recovery-first tombstones, retained markers,
  exact receipts, v1 mutation retirement, and stable error sanitization remain intact.
- `write` does not imply `delete`. No transport or future MCP adapter may invent a
  broader permission interpretation.
- Device state remains bounded, content-free, strictly versioned, and fail-closed.
  Unknown effects, active operations, and handoff blockers are preserved rather than
  reset for operational convenience.
- Note/recovery content, paths, persisted metadata, HTTP input, and client input remain
  untrusted. Markdown is data and is never executed as instructions.
- Credentials, authorization headers, token digests, note/recovery bodies, raw
  exceptions, and storage envelopes remain absent from logs, status, handoff, device
  state, committed configuration, and documentation.
- No cancellation, timeout, unload, rate refusal, or deployment rollback proves that a
  previously dispatched mutation did not commit.

## Accepted Slice 0 decisions

### Credential and principal model

- At most 16 active named opaque bearer credentials, each with a unique client ID,
  constrained display name, at least 256 random token bits, and a nonempty exact
  permission set.
- Worker configuration stores only domain-separated cryptographic token digests plus
  non-secret client metadata; raw tokens are shown once and are not recoverable.
- Successful authentication resolves a typed client principal. Independent per-client
  revocation and manual bounded rotation overlap are required.
- There is no credential-management HTTP/admin API, automatic token refresh, raw-token
  recovery, OAuth/JWT/Cloudflare Access, users/tenants, per-note ACL, or MCP-specific
  token shape.

### Permission semantics

| Permission | Accepted semantic scope |
| --- | --- |
| `read` | Authenticated current note/list/state and mirror-description reads; recovery metadata/content reads where applicable |
| `write` | Non-destructive current create/update/recreation; non-destructive recovery seal/repair |
| `delete` | Recovery-first note tombstone and destructive recovery purge |

Permissions are independent. Public routes remain public; retired operations remain
retired. Slice 4, not Slice 0, owns the exhaustive mapping from every implemented route
operation to one permission and the exact forbidden-response behavior.

### Lifecycle

Provisioning uses a secure random source, digest-only bounded registry, one-time raw
secret display, explicit client installation, and deployed verification. Rotation
provisions and verifies a distinct replacement before old-client revocation whenever a
safe overlap slot exists. Lost tokens are replaced, never recovered. Total registry
loss fails closed, preserves data/evidence, issues all-new credentials, and reconciles
in-flight effects before resuming. A rollback that restores a revoked digest is
prohibited.

## Accepted Slice 1 operational decisions

[ADR 0011](../decisions/0011-m5-operational-envelope.md) owns the evidence,
alternatives, uncertainty, and policy detail. Its synthetic measurements select a
future qualification target; they do not establish current real-host, deployment, or
production support.

| Decision | Accepted policy | Remaining implementation or qualification gate |
| --- | --- | --- |
| Practical supported note-count target | 10,000 eligible notes is the initial M5 qualification target and eventual maximum support claim; 50,000 remains only a hard safety ceiling | Slice 6 must qualify 10,000 on a real supported desktop host or lower/withhold the claim |
| Cloudflare Rate Limiting binding | No binding or replacement infrastructure | Reopen only from deployed workload, incident, or cost evidence with a complete limiter contract |
| Read/write/delete quotas | No application numeric quotas and no new 429 contract; retain existing hard bounds, independent delete permission, client revocation, and platform/account controls | Later slices test hard bounds and permission/revocation behavior, not invented request rates |
| Plugin platform support | Keep `isDesktopOnly: false`; initial writer support is limited to Obsidian desktop 1.13.0+ on Apple-silicon macOS; mobile, Intel macOS, Windows, and Linux writers remain unsupported | Slice 6 must name and exercise the exact Obsidian/macOS versions before support is claimed |
| Recovery maintenance | Existing API plus a manual one-page/one-mutation-at-a-time runbook; no command or scheduler | Slice 5 refines and exercises the runbook while preserving 30-day and CAS semantics |
| Release support | No current supported release; after M5, latest M5-ready release only, upgrade forward, rollback only through an exact qualified compatibility path | Synchronized root/plugin/staged artifact versions and compatibility evidence are release gates |
| Logging retention | Zero-day application-log retention: live diagnostics only, no Workers Logs/Logpush/durable sink or audit claim | Client-attributed content-free events remain useful live; forbidden data remains absent |
| Complete v1 retirement | Remove every registered v1 route and its OpenAPI compatibility before M5 support; v1 mutations stay retired until removal and are never restored | Slice 4 migrates clients, removes routes, and preserves authenticated unknown-descendant behavior |

Slice 1 changed documentation and gathered disposable local evidence only. It added no
production code, dependency, binding, manifest, route, credential, generated vault,
benchmark artifact, or deployment.

## Revised slice plan

The boundaries are semantic and dependency-oriented. Production estimates are planning
gates, exclude tests/docs/tooling, and must be rechecked before each implementation
slice. Crossing either AGENTS.md limit requires explicit authorization. Decisions that
selected no limiter, no numeric quotas, manual recovery, zero-day logs, and latest-only
support remove work rather than creating replacement scope.

### Slice 0 — Threat and credential foundation — COMPLETE

- Added this milestone skeleton, the consolidated threat model, and ADR 0010.
- Separated accepted credential/permission/lifecycle decisions from operational
  evidence decisions.
- Changed no production behavior.

**Production estimate/outcome:** 0 files / 0 LOC.

### Slice 1 — Qualification evidence and decision closure — COMPLETE IN THIS PR

- Ran bounded disposable in-memory qualification at 1,000, 5,000, and 10,000 eligible
  notes through current inventory, validation, codec, and migration paths.
- Accepted the eight policies in ADR 0011 and synchronized this specification,
  roadmap, decision index, and affected threat-model references.
- Removed unsupported limiter/quota, recovery-command, mobile-writer, durable-log, and
  multi-release work from later slices.

**Dependency:** Slice 0.

**Production estimate/outcome:** 0 files / 0 LOC.

**Independently mergeable outcome:** implementable operating decisions without runtime
or infrastructure change.

### Slice 2 — Credential registry, principal, and lifecycle tooling — COMPLETE IN THIS PR

- Implement the bounded digest-only registry, typed principal resolution, constant-
  work token verification, strict configuration validation, and fail-closed startup.
- Add offline create/provision, rotate, revoke, and total-loss replacement tooling
  with one-time raw-token handling and no HTTP management API.
- Define and test the bounded migration checkpoint from the current privileged bearer;
  do not enforce route permissions or remove compatibility routes in this slice.
- Committed Worker configuration selects registry authority. The explicitly named
  singleton migration mode and registry mode are mutually exclusive, with no
  per-request fallback; Slice 4 removes the temporary mode after migration.

**Dependency:** Slices 0–1.

**Production estimate:** 10 files / approximately 950–1,200 net new LOC.

**Production outcome:** 10 changed/new files / 459 net new LOC.

**Independently mergeable outcome:** authenticated requests resolve a bounded typed
principal and lifecycle tooling safely produces digest-only configuration, while
current route authority remains behind one explicit temporary migration checkpoint.

### Slice 3 — Client-attributed live diagnostics — COMPLETE

- Added canonical client ID only for authenticated requests plus closed authentication,
  route-derived operation, HTTP status, and stable API-error attribution to the
  existing content-free completed-request event.
- Reused the v2 route-policy owner for operation categories without adding a permission
  table or authorization decision. Retained v1/public projections are bounded until
  Slice 4 removes compatibility routes; unknown routes emit only `unknown`.
- Preserved zero-day retention: no Workers Logs configuration, export, sink, binding,
  quota counter, 429 response, token/digest/name/body/path/raw-error field, or audit-log
  claim was added.
- Focused tests cover repeated authenticated reads by two principals, destructive and
  oversized attempts, revoked and malformed credentials, application failure,
  recovery identity, public traffic, unknown routes, exact stable outcomes, leakage
  negatives, and unchanged storage effects.

**Dependency:** Slice 2.

**Expected production scope:** 3–5 files / 150–350 net new LOC.

**Production outcome:** 4 changed production files / 270 net new LOC.

**Independently mergeable outcome:** live diagnostics identify the principal and
operation without changing authorization, request admission, infrastructure, or
retention.

### Slice 4 — Permission enforcement, client migration, and v1 retirement — NEXT

- Create one exhaustive route-operation permission table for public, authenticated
  v2/recovery, unknown-descendant, and preflight behavior.
- Enforce exact `read`/`write`/`delete` checks from the typed principal before storage
  or mutation dispatch while preserving separate writer/association/application
  guards.
- Complete authorized-client migration through the verified credential lifecycle,
  remove the temporary singleton migration mode, and remove every registered v1 route and
  OpenAPI contract. Never resurrect retired mutations.
- Document future MCP mapping only as reuse of these operation permissions.

**Dependency:** Slices 1–3.

**Expected production scope:** 8–10 files / 700–1,200 net new LOC.

**Independently mergeable outcome:** every remaining API operation has one tested
permission owner, the privileged fallback is gone, delete is independent, current
clients use scoped v2 credentials, and v1 is fully retired.

### Slice 5 — Operational, recovery, release, and incident runbooks — PLANNED

- Refine and exercise the bounded manual recovery procedure; add no plugin command,
  scheduler, or automatic purge.
- Finalize setup, client rotation/revocation, writer handoff, total registry loss,
  credential compromise, external backup/restore, forward upgrade, rollback refusal,
  v1 removal, and unsupported-environment procedures.
- Define release/artifact version synchronization and latest-only support intake.
  Preserve `isDesktopOnly: false`; do not claim the selected Apple-silicon macOS
  desktop platform before Slice 6.

**Dependency:** Slices 1–4.

**Expected production scope:** 0 files / 0 LOC. Release/tool configuration or docs may
change, but no production TypeScript or runtime behavior is planned.

**Independently mergeable outcome:** reviewed runbooks and release gates match the
implemented credential/API boundary without automation or support overclaim.

### Slice 6 — Integrated desktop qualification and completion gates — PLANNED

- Qualify 1,000/5,000/10,000-note representative behavior, hard bounds, credential
  leakage negatives, permission matrix, revocation/rotation, upgrade/rollback refusal,
  manual recovery, packaged plugin, and the exact Apple-silicon macOS/Obsidian
  desktop versions intended for the supported release.
- Run canonical automation and final semantic/security review; correct every finding.
- Synchronize README, architecture, current-state, API/OpenAPI, security, operations,
  ADRs, and roadmap with implemented evidence.
- Only after every gate passes may M5 become COMPLETE and M6 become NEXT. If real-host
  10,000-note evidence fails, lower or withhold the support claim rather than changing
  the 50,000 safety ceiling or hiding uncertainty.

**Dependency:** Slices 1–5.

**Expected production scope:** 0 files / 0 LOC planned. A discovered production defect
requires a separately estimated corrective slice before completion, not hidden
qualification-slice implementation.

**Independently mergeable outcome:** final evidence and documentation establish the
bounded latest-release Apple-silicon macOS desktop support claim and transition,
without deployment or M6.

## Preliminary acceptance and exit criteria

- **A1 — Threat coverage:** every threat-model row is implemented, explicitly bounded,
  or retained as a named residual with an owner; no trust boundary is silently widened.
- **A2 — Credential safety:** the active registry is bounded to 16, stores no raw
  token, validates strict metadata/permissions, resolves typed principals, and fails
  closed on invalid/missing configuration.
- **A3 — Lifecycle:** create/provision, one-time display, verified overlap rotation,
  independent revoke, lost-token replacement, old-token rejection, and total-registry-
  loss procedures pass focused tests and runbook exercises.
- **A4 — Permission completeness:** one exhaustive operation table covers every
  authenticated route/action. `read`, `write`, and `delete` retain the accepted
  semantics; writer/association/application guards remain separate.
- **A5 — Migration:** the current privileged bearer is removed through an explicit
  staged migration with no indefinite fallback, raw-token persistence, silent client
  promotion, or unsafe rollback.
- **A6 — Bounded operation:** the 10,000-note envelope and existing payload/page/state/
  scheduler/retry bounds are measured, documented, and tested; no application quota,
  429 contract, or Rate Limiting binding is implied.
- **A7 — Diagnostics/privacy:** client-attributed live events are sufficient for the
  accepted incident/runbook needs and exclude all forbidden secret/content/path/raw-
  error data; zero-day retention and the absence of an audit-log claim match ADR 0011.
- **A8 — Recovery and rollback:** maintenance, credential loss, device-state failure,
  backup/restore, upgrade, and rollback procedures preserve evidence and exact effect
  certainty. R2 is never described as a complete backup.
- **A9 — Platform/release truth:** unchanged loadability flags, the actually qualified
  desktop writer environment, latest-only release window, complete v1 retirement,
  synchronized artifacts, and scale claims match evidence. Unsupported mobile and
  rollback environments are named without implying hidden support.
- **A10 — Architecture:** core remains platform-independent; clients and future MCP
  use Worker/application policy rather than R2; no unaccepted service/dependency or
  credential administration API appears.
- **A11 — Validation:** canonical checks, focused security/abuse/lifecycle tests,
  generated-artifact leakage checks, Markdown links/headings, exact-one-`NEXT`, diff
  hygiene, and editor diagnostics pass.
- **A12 — Review and transition:** final `/skill:code-review` finds no unresolved
  blocking issue. Completion evidence is recorded before changing M5 from NEXT or M6
  from PLANNED.

## Slice 0 acceptance evidence

- The threat model enumerates all requested assets, trust boundaries, threat actors,
  abuse/failure cases, implemented mitigations, M5 gaps, residual risks, and future
  slice owners.
- ADR 0010 accepts the bounded credential/principal model, exact permission semantics,
  separate writer guards, and full lifecycle contract without implementing them.
- Slice 0 deliberately left all eight operating decisions open for Slice 1 and made no
  production/support claim.
- The Slice 0 change was documentation-only: zero production files, zero production
  lines, no dependency/binding/route/auth/manifest/test/deployment change, and no
  credentials.

## Slice 1 acceptance evidence

- ADR 0011 records repository/platform evidence, realistic alternatives, explicit
  uncertainty, and the disposition of all eight decisions.
- Disposable current-code measurements cover local and paged remote inventory, v4
  validation/encode/decode, and v2→v3→v4 migration at 1,000, 5,000, and 10,000 settled
  live paths. The harness/data were not committed and do not claim real-host behavior.
- The decision selects 10,000 as a later qualification target, not a current support
  claim, and keeps 50,000 as a distinct hard safety ceiling.
- No Rate Limiting binding, numeric quota, mobile-writer support, recovery automation,
  durable logs, multi-release support, v1 route change, or replacement work was added.
- The revised remaining slices each identify dependencies, an independently mergeable
  outcome, and an expected production file/LOC range within AGENTS.md gates.
- This Slice 1 change is documentation/evidence-only: zero production files and zero
  production LOC, with no dependency, binding, route, authentication, API behavior,
  manifest, generated benchmark, credential, deployment, release, or M6 change.

## Slice 2 acceptance evidence

- One strict validator owns registry version 1, exact fields, canonical lowercase UUID-v4 IDs, ADR name grammar, closed nonempty permission sets, lowercase 64-hex digests, case-insensitive unique names, unique IDs/digests, and the 16-entry bound. Malformed or unavailable configuration authenticates nobody.
- Tokens use 32 Web Crypto random bytes encoded as canonical unpadded base64url. Verifiers use SHA-256 over the documented domain separator plus UTF-8 token bytes. Authentication computes the supplied digest once, compares it against every active entry without an early successful return, and publishes only `{clientId, name, permissions}`.
- `mise run credentials --` provides offline create, overlap rotation, exact revoke, no-overlap lost-token replacement, and all-new total-registry replacement. It accepts no raw-token argument, refuses non-interactive secret output, keeps confidential registry files outside the repository, writes them atomically with owner-only mode, and makes no network/deployment call.
- The migration selector has only `singleton-migration`, `credential-registry`, and fail-closed invalid outcomes. Each valid mode evaluates one authority path and ignores the other secret. Committed Wrangler configuration requires the registry and selects registry mode; after switching, the old singleton fails even before secret removal. Slice 4 owns source-level removal of the temporary mode.
- Focused tests cover one/many/16/17 entries, all duplicate/malformed/version/unknown-field/permission cases, first/middle/last authentication, complete digest evaluation, principal identity, sanitized failures/leakage negatives, lifecycle failures and capacity, exact revocation/loss replacement, total loss, and migration exclusivity while preserving existing writer/association/effect behavior.
- Permission metadata is deliberately not route-enforced in this slice. Full writer credentials use all three values to preserve current M3/M4 behavior; Slice 4 remains the sole owner of the exhaustive operation-to-permission table.

## Slice 3 acceptance evidence

- One structured event owner emits event kind, registered route template or bounded
  `unknown`, method, duration, status, stable API error code when present, closed
  authentication result, closed operation category, and canonical client ID only for
  authenticated requests.
- V2 diagnostic categories are attached to the existing named route-policy operations
  and cannot admit or authorize a request. Public and retained v1 projections remain
  transport-local; Slice 4 still exclusively owns permission enforcement and v1
  removal.
- Focused integration tests prove distinct client attribution, repeated reads,
  destructive and oversized failures, revoked and malformed credentials, application
  failure, recovery and unknown routes, exact API outcomes, and no storage mutation in
  refused scenarios.
- Leakage assertions exclude raw tokens/digests, names, authorization/header data,
  request bodies, raw and encoded note paths, recovery and operation IDs, revisions,
  content-hash text, receipts, raw exceptions, and concrete unknown paths.
- ADR 0011's zero-day contract is unchanged: no persistent logging configuration,
  service, binding, dependency, quota/rate limit, 429 behavior, audit claim, deployment,
  or M6 capability was added.

## M6 boundary

M6 may expose selected authorized operations through MCP only after M5 establishes the
implemented client principal and route-operation policy. M6 must define tool/resource,
transport, hosting, confirmation, prompt/content, and permission mapping separately.
It may not access R2 directly, execute note instructions, reuse writer IDs as auth, or
create a broader MCP-specific credential.
