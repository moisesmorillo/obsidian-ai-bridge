# Consolidated threat model

## Status and scope

This document records the implemented M1–M6 trust and safety boundary on the M6
completion branch. M5's final report closes A1–A12 for the latest v1.0.2 release
within one exact Obsidian/macOS desktop profile and a 10,000-note synthetic
active-writer ceiling. This is software qualification, not security certification,
penetration-test evidence, production deployment, or complete-backup assurance. M6
adds no MCP OAuth authorization profile or deployment claim; its bounded official
client evidence is recorded in the [M6 qualification report](qualification/m6-final.md).

The modeled system is one personal eligible-Markdown mirror: an Obsidian vault and
designated writer plugin communicate with an authenticated Cloudflare Worker that
stores plaintext mirror and recovery generations in private R2. iCloud continues to
synchronize the working vault between devices. Reviewed M4 reconciliation may write
validated plaintext into the local vault. M6 MCP is a remote consumer of the same
registry-authenticated principal and authorized application operations. It cannot
access R2 directly, mutate the local vault, or gain authority from note content.

## Security objectives

- Keep plaintext note and recovery content available only to the trusted host/operator
  boundary and explicitly authorized clients.
- Make client authentication least-privilege, independently revocable, and live-
  diagnosable enough for a bounded personal bridge without claiming an audit trail.
- Prevent unauthenticated, unauthorized, stale, or conflicting requests from silently
  creating, replacing, tombstoning, purging, or importing content.
- Preserve exact recovery, conflict, receipt, and device-state evidence across partial
  failure instead of claiming rollback or success.
- Bound request, scan, registry, state, payload, retry, and recovery work.
- Keep credentials and note bodies out of logs, committed files, device state, status,
  and handoff metadata.
- Treat Markdown and recovery text as untrusted data, never privileged instructions.
- Describe R2 truthfully as a private mirror/API persistence layer, not a guaranteed
  complete backup or sole authority.

## Assets

| Asset | Security concern |
| --- | --- |
| Plaintext Markdown note content | Confidential personal content; integrity and availability must survive conflicts and partial effects. |
| Recovery content | Plaintext historical/deleted content with separate retention and purge semantics; misuse can disclose or destroy recovery material. |
| Bearer/client credentials | Authenticating secrets whose compromise grants the credential's remote permissions. Token digests are confidential verifier material even though they are not raw tokens. |
| R2 mirror state | Current live/tombstone generations, revisions, receipts, recovery objects, markers, and legacy objects whose consistency protects conditional operations. |
| Host-local device state | Activation, ACKs, unresolved effects, review operations, evidence, and handoff state; corruption or rollback can remove safety context. |
| Association and writer identity | Non-secret lineage/designation evidence that prevents accidental cooperating-writer mutation but is not authentication. |
| Conflict-preservation artifacts | Sensitive plaintext copies under excluded local paths; essential evidence during reviewed resolution but not a full backup. |
| Operational and log metadata | Client IDs, operation kinds, timings, status, revisions/hashes, paths where deliberately exposed by UI, and platform audit records; useful for diagnosis but privacy-sensitive. |

## Trust boundaries

| Boundary | Trust and data crossing it |
| --- | --- |
| Obsidian host/device | Trusted with vault plaintext and plugin execution. Other privileged plugins, host compromise, backups, and local malware are inside or can defeat this trust boundary; native SecretStorage is not claimed as an OS keychain. |
| Designated writer plugin | One explicitly designated plugin owner may originate ordinary mirror mutations and reviewed M4 effects. Its local state and callbacks are fallible; designation is not remote-client permission. |
| iCloud working-vault sync | External device-to-device synchronization with no transactional event log or global ordering exposed to the plugin. Positive saved events are evidence; startup/listener-gap absence is not deletion authority. |
| Cloudflare Worker | Internet-facing authentication, authorization, transport validation, application-service composition, and sanitized response/log boundary. A compromised runtime can observe request tokens and plaintext. |
| R2 | Private object persistence reached only through the Worker binding. R2 contains plaintext current/recovery data and conditional generations; private access is not end-to-end encryption or backup completeness. |
| Authenticated HTTP clients | Outside the host boundary and trusted only for the exact resolved client permissions. Client input, paths, bodies, identities, conditions, and replay are untrusted. |
| Cloudflare/platform operator | Trusted with Worker configuration, verifier material, runtime visibility, R2 plaintext, deployment history, and platform logs. M5 does not protect against a malicious fully privileged operator. |
| MCP clients | Outside the Worker boundary and authenticated independently on every stateless POST through the M5 registry. They receive only exact tool/resource permissions; they cannot select writer identity, call arbitrary application operations, or confer authority on note content. |

Public health/OpenAPI/documentation routes cross the Worker boundary without note
authority. Authenticated API and MCP routes cross authentication first. M5 resolves
the same typed client principal for both; HTTP route policy and the exhaustive MCP
capability table keep permission checks separate from designated-writer, association,
conditional revision, preservation, and recovery checks. MCP authentication is an
application-level bearer overlay, not OAuth or audience-bound token validation.

## Threat actors and failure sources

- **Unauthenticated internet caller:** probes public/API paths, malformed input, auth
  parsing, route mismatches, payload bounds, and resource exhaustion.
- **Holder of a leaked client credential:** replays the bearer from another device and
  uses every permission granted to that client until verified revocation.
- **Malicious or buggy authorized client/MCP caller:** sends valid but excessive,
  stale, destructive, conflicting, or semantically surprising requests within or
  beyond its intended permissions, or attempts unsupported protocol/session behavior.
- **Malicious note/recovery content:** contains prompt injection, links, HTML,
  frontmatter, commands, or misleading instructions intended for a human, plugin,
  future agent, or MCP adapter.
- **Stale or compromised local device:** retains credentials/designation or rolled-back
  device state, emits delayed requests, or attempts unsafe writer takeover.
- **Operator error:** mis-scopes credentials, restores stale config/state, leaks a
  token, rolls back incompatible code, purges recovery, misstates backup guarantees,
  or enables unsupported environments.
- **Remote/storage/runtime failure:** timeout, partial commit, lost response, R2/Worker
  unavailability, state persistence failure, quota exhaustion, or process replacement.
- **Dependency or platform compromise:** malicious/update-compromised dependency,
  build/deployment chain, Obsidian plugin/host, Worker runtime, Cloudflare account, or
  operator workstation. This is considered where existing isolation or pinning
  meaningfully reduces risk; M5 does not claim to withstand fully privileged platform
  compromise.

## Threat register

Each row distinguishes implemented controls from completed M5 evidence and the
completed M6 qualification evidence. The M5 report links the corresponding A1–A12
evidence; M6 evidence is in its dedicated qualification report.

| Threat / abuse or failure case | Assets and boundary | Implemented mitigation | M5 qualification evidence | Accepted residual risk / owner |
| --- | --- | --- | --- | --- |
| Unauthorized plaintext reads | Notes, recovery content; client → Worker → R2 | Strict registry auth; exact HTTP/MCP permission policies; explicit MCP resource-only content reads; private R2; canonical paths; bounded bodies; sanitized errors; and `no-store` responses. | [A4/A7](qualification/m5-final.md#a4--permission-completeness) live permission/log checks and Worker tests; M6 MCP integration tests cover exact grants and resource reads. | Worker/Cloudflare/host operators and correctly authorized readers remain trusted with plaintext; no application E2E encryption. MCP OAuth/Protected Resource Metadata interoperability is intentionally unsupported. Owner: service operator and trusted-platform providers. |
| Unauthorized mutation or deletion | Current/recovery state; client → Worker | Independent `write`/`delete`, exact writer/association guards, conditional revisions/receipts, recovery-first tombstones, and typed application policy. MCP's exhaustive permission table runs before service resolution and exposes no local-vault or arbitrary-dispatch tool. | [A4/A8](qualification/m5-final.md#a8--recovery-and-rollback) exact refusals and retained recovery; M6 tests prove denied calls perform zero service resolution/effect dispatch. | Authorized writers can exercise granted authority; application rules cannot infer operator intent. Owner: credential-granting operator. |
| Credential replay after disclosure | Client credentials; network → Worker | HTTPS outside exact loopback development, approved secret stores, bounded digest-only registry, independent revoke/rotation/loss replacement, and authenticated-client attribution. | [A3](qualification/m5-final.md#a3--credential-lifecycle) retained post-rotation 10k mirror evidence plus current lifecycle tests. | A disclosed bearer remains replayable until verified revocation; no proof-of-possession/hardware binding, and sampled logs can be missed. Owner: credential administrator. |
| Excessive reads or scans | R2 availability/cost and plaintext exposure; client → Worker/R2 | Bounded payloads/pages/cursors, retired v1 aggregation, exact `read` permission, bounded MCP request/response streams, one page per call, and independent client revocation. | [A6](qualification/m5-final.md#a6--bounded-operation) M5 scale evidence; M6 boundary tests cover MCP byte limits and bounded results. | Authorized volumetric abuse and platform/account exhaustion remain possible; no quota/limiter is configured and no SaaS-scale or DoS guarantee is made. Owner: bridge operator and Cloudflare account owner. |
| Excessive destructive requests | Current/recovery integrity and cost; client → Worker/R2 | Independent `delete`, CAS, operation IDs, association continuity, recovery-first tombstones, retained markers, exact replay, and revocation. | [A4/A8](qualification/m5-final.md#a4--permission-completeness) loopback verifies 403 refusal and premature purge 409 with content retained. | A fully authorized delete client can issue many valid operations until revocation/platform controls take effect. Owner: credential administrator. |
| Secret or sensitive log leakage | Credentials, note/recovery bodies, paths and metadata; runtime/log boundaries | Structured live diagnostics exclude names, secrets/digests, headers, bodies, concrete/encoded identifiers, revisions, hashes, receipts, storage envelopes and raw exceptions. MCP logs use only the static route and closed request category; zero-day application retention remains. | [A7](qualification/m5-final.md#a7--diagnostics-and-privacy) M5 loopback evidence; M6 leakage tests inspect MCP responses/log entries. | Live sampling/missed sessions leave no history; privileged runtime/platform compromise can observe transient plaintext. Owner: service operator and platform providers. |
| Stale writer takeover or delayed old requests | Association/writer identity, R2 and device state; stale plugin → Worker | One explicit writer, pause/drain/handoff, static non-secret writer guard, local alignment, conditional generations, isolated reset, and fail-closed same-realm/schema fences. | [A8](qualification/m5-final.md#a8--recovery-and-rollback) handoff runbook and retained rotation/restart evidence. | No election, lease, or automatic takeover; a lost writer/ledger requires operator recovery or isolated reset. Owner: designated-writer operator. |
| Unsafe code/config/credential rollback | Device state, revoked credentials, format-2 state; operator boundary | Strict v2→v3→v4→v5 migration, frozen historical codecs, incompatible-runtime refusal, v1 retirement, and forward-only instructions. | [A8/A9](qualification/m5-final.md#a8--recovery-and-rollback) v4→v5 host migration and old-codec refusal tests; v1.0.2 identity check. | No general rollback path is qualified; a structurally valid stale snapshot may be indistinguishable from current state. Owner: release/device operator. |
| Missed local events across listener gaps | Note state, M3/M4 reservations/effects; Obsidian → plugin | Layout-ready listeners, bounded startup buffering, durable gap fences, dispatch leases, fresh complete-group review/transfer; scan absence never authorizes deletion. | [A6/A8](qualification/m5-final.md#a8--recovery-and-rollback) current v5 migration/restart matrix and retained detached-edit host scenario. | Host events are not a transaction log; iCloud ordering is not qualified and unresolved evidence may retain reservations. Owner: vault/device operator. |
| Corrupted or rolled-back host-local device state | ACKs, effects, reviews, association; host storage → plugin | Strict bounded codecs/cross-field validation, canonical save/read-back migration, content-free state, unknown-effect retention, global persistence fences, fail-closed startup. | [A8](qualification/m5-final.md#a8--recovery-and-rollback) v4→v5 migration and migration/downgrade regression tests. | Host storage is not an fsync/transaction guarantee; stale but structurally valid snapshots may pass validation. Owner: device operator; preserve an independent vault backup. |
| Recovery misuse or premature purge | Recovery plaintext/retention; client → Worker/R2 | Separate metadata/content endpoints, exact permissions/ETags, writer IDs, tombstone proof, 30-day semantics, conditional purge to retained marker, reviewed local-first restore. | [A8](qualification/m5-final.md#a8--recovery-and-rollback) one-page live inspection/export, exact seal replay, refused early purge with content preserved; fake-clock expiry tests. | Retention is not physical erasure; recovery is not a complete backup; an authorized delete client can purge eligible content. Owner: credential administrator and vault owner. |
| Untrusted Markdown interpreted as instructions or active content | Note/recovery text; remote → plugin/human/MCP client | MCP returns plaintext only through exact explicit resource reads; note text never changes server instructions, schemas, permissions, capability discovery, execution, or diagnostics. Existing local review controls and no Markdown/HTML rendering remain. | [A8/A10](qualification/m5-final.md#a10--architecture) M5 artifact/loopback tests; M6 hostile-text resource tests verify literal return and unchanged discovery/dispatch. | Other trusted plugins, MCP clients, or humans may interpret retrieved content; Markdown remains untrusted data. Owner: host operator and client implementers. |
| Accidental claim that R2 is a full backup | User data and recovery expectations; docs/operator decisions | README, roadmap, architecture, security and operations define R2 as a mirror/API layer and prohibit silent reset or physical-erasure claims. | [A8](qualification/m5-final.md#a8--recovery-and-rollback) documents exact export/recovery exercise and backup limitations. | No complete backup, point-in-time restore, or physical-erasure guarantee; no external backup provider was selected or qualified. Owner: vault owner selects and verifies an independent backup. |
| Remote/storage/runtime partial failure | Current/recovery state, receipts, device state; plugin ↔ Worker ↔ R2 | Conditional transitions, persisted intent, exact receipts, finite retry/evidence budgets, unknown-effect states, preservation-first ordering, and restart reconciliation. | [A8/A11](qualification/m5-final.md#a11--validation) canonical and focused failure-path tests plus loopback maintenance/recovery exercise. | No cross-system atomicity or continuous availability; unresolved evidence can require manual attention. Owner: bridge operator. |
| Malicious/buggy authorized client bypasses semantic intent | All remote state; client → application boundary | Exhaustive operation policy, retired v1, strict schemas/media/path/size checks, CAS, writer guard, recovery state machine, and stable errors. | [A4/A5](qualification/m5-final.md#a5--migration) exhaustive permission matrix and live 403/409 checks. | Permissions bound capability, not client correctness; conflicting writes remain visible divergence for reviewed resolution. Owner: credential-granting operator. |
| Dependency, build, Worker, Cloudflare account, or host compromise | Credentials, plaintext, artifacts, deployment; supply/platform boundaries | Locked dependencies/toolchains, canonical checks, generated-artifact leakage tests, official host APIs, no client R2 credentials, and private reporting. | [A9/A11](qualification/m5-final.md#a9--platform-and-release-truth) reproducible v1.0.2 artifact and current canonical validation. | Fully privileged host/build/Worker/cloud compromise can expose plaintext and credentials; M5 does not isolate against trusted-platform compromise. Owner: platform/build maintainers and operator. |

## Abuse-control and authorization invariants for later slices

- Authentication, permission, writer/association designation, and application
  preconditions are distinct gates. Passing one never implies another.
- `delete` is independently granted. `write` never authorizes note tombstone or
  recovery purge.
- ADR 0011 selects no application request quota or limiter for M5. Any successor must
  identify its unit, window, principal, operation class, failure status, retry guidance,
  locality, and behavior under platform failure before implementation.
- Existing hard bounds, and any future limit, must not turn a refused/unknown mutation
  into reported success, bypass exact receipt recovery, or infer that cancellation
  rolled back storage.
- Logging may identify the typed client ID and operation class but must not include raw
  tokens, token digests, authorization headers, note/recovery bodies, concrete note
  paths, raw exceptions, or storage envelopes.
- No new Cloudflare service or binding is selected. Reopening that decision requires
  workload/incident evidence and a successor ADR before implementation.
- M6 MCP is another authenticated client/transport adapter. It reuses the existing
  typed principal but has its own exhaustive capability-to-permission table. It
  receives no direct R2 access, writer designation, implicit delete authority, prompt
  trust, or separate credential shape. Its static bearer overlay is not MCP OAuth,
  Protected Resource Metadata, or audience-bound authorization.

## Residual-risk statement

M5's limited software-support claim is latest release v1.0.2 on Obsidian Desktop
1.13.7 / macOS 26.6.2 / Apple M4 Pro, with one active writer and up to 10,000 eligible
notes. It is not a certified secure system, multi-tenant or highly available service,
complete backup, production deployment, or defense against fully privileged host/cloud
compromise. Other platforms/event traces remain unqualified. MCP clients must use a
preconfigured bearer header; the application-level overlay is not OAuth, Protected
Resource Metadata, or audience-bound token validation, and OAuth-discovery-only
clients are unsupported. ADR 0011's no-quota, zero-day-log, manual-recovery,
latest-only, and v1-retirement choices remain binding; see the [final M5 report](qualification/m5-final.md)
for measured evidence and limits.

## Evidence and related decisions

- [M5 milestone specification](milestones/m5-operational-and-security-readiness.md)
- [M5 final qualification report](qualification/m5-final.md)
- [M6 MCP adapter specification](milestones/m6-mcp-adapter.md)
- [M6 final qualification report](qualification/m6-final.md)
- [ADR 0014 — stateless MCP adapter and existing credentials](decisions/0014-stateless-mcp-adapter-and-existing-credentials.md)
- [ADR 0010 — scoped client credentials and permissions](decisions/0010-scoped-client-credentials-and-permissions.md)
- [ADR 0011 — operational envelope and support policy](decisions/0011-m5-operational-envelope.md)
- [Architecture](architecture.md)
- [Verified current state](current-state.md)
- [Worker API](api.md)
- [Operator guide](operations.md)
- [Security policy](../SECURITY.md)
- [ADRs 0001–0009](decisions/README.md)
