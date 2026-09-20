# M5 — Operational and security readiness

**Status: NEXT — Slice 0 planning foundation accepted; no M5 production behavior is
implemented.** M1–M4 remain COMPLETE and M6 remains PLANNED. This specification is a
planning skeleton: it makes the accepted Slice 0 security model and Slice 1 decision
gates explicit, but later slices require their own refined acceptance evidence before
production implementation.

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
- [Roadmap](../roadmap.md): milestone order and the Slice 1 open-decision register.

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
- Complete v1 compatibility/retirement policy chosen before changing current routes.
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
  infrastructure without an explicit accepted Slice 1 decision and, when
  consequential, a successor ADR.
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

## Decisions deliberately open for Slice 1

Slice 0 does not accept recommendations for the following. Slice 1 must gather the
listed evidence, compare alternatives, record a decision, and synchronize this
specification before dependent production work.

| Open decision | Evidence required before acceptance | Boundary until decided | Dependent slices |
| --- | --- | --- | --- |
| Practical supported note-count target | Measured current inventory/list/state/device-state/runtime behavior at representative personal-vault sizes and explicit cost/latency/failure observations | Existing hard bounds are implementation limits, not a support claim; **10,000 notes is not canonical or presumed** | 3, 5, 6 |
| Cloudflare Rate Limiting binding | Threat/cost model, local application-control alternatives, failure mode, development/test behavior, and infrastructure/operational burden | No binding or service is selected or added | 3 |
| Exact read/write/delete quota numbers | Measured normal M3/M4/plugin/API operation patterns, burst needs, recovery behavior, principal keying, windows, status/retry contract, and destructive-operation safety | No new quota claim or magic number | 3, 4 |
| Desktop-only plugin manifest setting | Actual qualified desktop/mobile/native-secret/iCloud/background constraints and product support intent | Current non-desktop-only manifest remains unchanged; no mobile support claim | 5, 6 |
| Recovery maintenance command versus bounded manual runbook | Prepared/sealed/expired/purged inventory evidence, operator error analysis, safety of automation, and bounded workload | Existing explicit API/manual semantics remain; no scheduler/command is added | 5 |
| Release support window | Upgrade/downgrade compatibility, security response capability, artifact/versioning evidence, and maintainer commitment | No supported production release claim | 5, 6 |
| Logging retention duration | Required incident/operation evidence, metadata privacy, platform capability, deletion/configuration semantics, and cost | Existing content-free logging remains; no retention guarantee | 3, 5 |
| Complete v1 retirement policy | Observed compatibility need, current authenticated v1 read use, migration path, OpenAPI/client impact, and rollback risk | V1 reads remain; v1 PUT/DELETE remain retired; no route change | 4, 5 |

Slice 1 must not bundle implementation. If evidence cannot justify a safe choice, the
decision remains open and dependent slices stay blocked.

## Preliminary slice plan

The boundaries below are semantic and dependency-oriented. Estimated filenames or
lines of code are deliberately non-normative. Each implementation slice must refine
its own tests, migration, rollback, documentation, and acceptance evidence before
production changes.

### Slice 0 — Threat and credential foundation — PLANNING COMPLETE IN THIS PR

- Add this milestone skeleton, the consolidated threat model, and ADR 0010.
- Separate accepted credential/permission/lifecycle decisions from Slice 1 open
  operational decisions.
- Keep M5 `NEXT`, M6 `PLANNED`, and current runtime behavior unchanged.

### Slice 1 — Qualification evidence and decision closure — PLANNED

- Run bounded synthetic qualification needed for the eight open decisions.
- Record alternatives, measurements, failure modes, and accepted decisions in ADRs or
  the roadmap/spec as appropriate.
- Do not introduce production behavior, infrastructure, manifest changes, route
  changes, or credentials merely to gather evidence.

**Dependency:** Slice 0.

**Exit:** every open row above is accepted or explicitly retained as a blocker; later
slices have implementable numeric/platform/operational contracts.

### Slice 2 — Credential registry, principal, and lifecycle tooling — PLANNED

- Implement the bounded digest-only registry, typed principal resolution, constant-
  work token verification, strict configuration validation, and fail-closed startup.
- Add offline create/provision, rotate, revoke, and total-loss replacement tooling
  with one-time raw-token handling and no HTTP management API.
- Define and test the migration checkpoint from the current privileged bearer without
  an indefinite fallback. Do not yet broaden route permission policy beyond the
  narrow compatibility gate required for staged migration.

**Dependency:** Slices 0–1.

**Exit:** credential lifecycle and principal identity are independently testable,
bounded, secret-safe, and operationally reversible only through fresh credentials.

### Slice 3 — Abuse controls and client-attributed diagnostics — PLANNED

- Implement the Slice 1 accepted read/write/delete limits and limiter mechanism.
- Preserve effect certainty, bounded retries, stable sanitized failures, privacy, and
  content-free logging while adding client ID/operation attribution needed by
  runbooks.
- Implement accepted logging retention configuration/documentation without exposing
  token, digest, body, concrete path, or raw error data.

**Dependency:** Slices 1–2.

**Exit:** measured normal workloads pass; excessive requests fail predictably without
false success, hidden mutation, unbounded scanning, or diagnostic leakage.

### Slice 4 — Permission enforcement and compatibility migration — PLANNED

- Create one exhaustive route-operation permission table for public, authenticated
  v1/v2, recovery, unknown-descendant, and preflight behavior.
- Enforce exact `read`/`write`/`delete` checks from the typed principal before storage
  or mutation dispatch, while preserving separate writer/association/application
  guards.
- Migrate plugin and authorized clients through the verified credential lifecycle.
  Apply the accepted complete v1 policy; do not resurrect retired mutations.
- Document future MCP mapping only as reuse of these operation permissions.

**Dependency:** Slices 1–3.

**Exit:** every route operation has one tested permission owner; delete is never
implied by write; the privileged fallback is removed according to the accepted
migration contract.

### Slice 5 — Operational, recovery, release, and incident runbooks — PLANNED

- Implement the accepted recovery-maintenance choice, if any, without weakening
  conditional state/recovery semantics.
- Finalize setup, client rotation/revocation, writer handoff, total registry loss,
  credential compromise, backup/restore, forward upgrade, rollback refusal, v1
  transition, and unsupported-environment procedures.
- Apply the accepted release support window and platform/manifest decision only with
  synchronized artifacts and operator guidance.

**Dependency:** Slices 1–4.

**Exit:** runbooks are tested against representative failure paths and never prescribe
state deletion, stale registry restore, unsafe takeover, destructive probes, or R2-as-
backup claims.

### Slice 6 — Integrated qualification and completion gates — PLANNED

- Qualify the accepted note-count envelope, limits, credential leakage negatives,
  permission matrix, revocation/rotation, rollback, recovery, packaged plugin, and
  supported platforms/releases.
- Run canonical automation and final semantic/security review; correct every finding.
- Synchronize README, architecture, current-state, API/OpenAPI, security, operations,
  ADRs, and roadmap with implemented evidence.
- Only after all exit criteria pass may M5 become COMPLETE and M6 become NEXT.

**Dependency:** Slices 1–5.

**Exit:** evidence supports the bounded claims below without deployment or security-
certification overstatement.

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
- **A6 — Bounded operation:** supported note count, request limits, limiter behavior,
  payload/page/state bounds, and retry semantics are measured, documented, and tested.
- **A7 — Diagnostics/privacy:** client-attributed events are sufficient for the
  accepted incident/runbook needs and exclude all forbidden secret/content/path/raw-
  error data; retention matches the accepted Slice 1 decision.
- **A8 — Recovery and rollback:** maintenance, credential loss, device-state failure,
  backup/restore, upgrade, and rollback procedures preserve evidence and exact effect
  certainty. R2 is never described as a complete backup.
- **A9 — Platform/release truth:** manifest flags, supported environments, release
  window, v1 policy, and qualification claims match actual evidence. Unsupported
  environments are named without implying hidden support.
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
- The eight operational decisions remain explicitly open for Slice 1; no 10,000-note
  support claim, Rate Limiting binding, quota, manifest flag, maintenance command,
  release window, log retention, or complete v1 policy is selected.
- This Slice 0 change is documentation-only: zero production files, zero production
  lines, no dependency/binding/route/auth/manifest/test/deployment change, and no
  credentials.

## M6 boundary

M6 may expose selected authorized operations through MCP only after M5 establishes the
implemented client principal and route-operation policy. M6 must define tool/resource,
transport, hosting, confirmation, prompt/content, and permission mapping separately.
It may not access R2 directly, execute note instructions, reuse writer IDs as auth, or
create a broader MCP-specific credential.
