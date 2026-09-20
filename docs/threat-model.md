# Consolidated threat model

## Status and scope

This document consolidates the implemented M1–M4 trust and safety evidence and the
planned M5 security boundary. It is a design and prioritization artifact, not a
security certification, penetration-test report, deployment claim, or production-
readiness statement.

The modeled system is one personal eligible-Markdown mirror: an Obsidian vault and
designated writer plugin communicate with an authenticated Cloudflare Worker that
stores plaintext mirror and recovery generations in private R2. iCloud continues to
synchronize the working vault between devices. Reviewed M4 reconciliation may write
validated plaintext into the local vault. Future MCP is only a consumer of the same
authorized application operations; it is not implemented and receives no authority
from this document.

## Security objectives

- Keep plaintext note and recovery content available only to the trusted host/operator
  boundary and explicitly authorized clients.
- Make client authentication least-privilege, independently revocable, and auditable
  enough for a bounded personal bridge.
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
| Future MCP adapter | Future transport boundary only. It must map tools to the existing typed client principal and application operations, never access R2 directly or execute note instructions. M6 owns its hosting/tool contract. |

Public health/OpenAPI/documentation routes cross the Worker boundary without note
authority. Authenticated API routes cross authentication first. M5 then resolves a
typed client principal; permission checks remain separate from designated-writer,
association, conditional revision, preservation, and recovery checks.

## Threat actors and failure sources

- **Unauthenticated internet caller:** probes public/API paths, malformed input, auth
  parsing, route mismatches, payload bounds, and resource exhaustion.
- **Holder of a leaked client credential:** replays the bearer from another device and
  uses every permission granted to that client until verified revocation.
- **Malicious or buggy authorized client:** sends valid but excessive, stale,
  destructive, conflicting, or semantically surprising requests within or beyond its
  intended permissions.
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

Each row distinguishes implemented mitigation from planned work. “Accepted/deferred”
means a bounded residual or a later-milestone owner, not that the threat is harmless.
Slice numbers refer to the [M5 specification](milestones/m5-operational-and-security-readiness.md).

| Threat / abuse or failure case | Assets and boundary | Existing mitigation | Remaining M5 gap | Accepted or deferred risk | Owning future M5 slice |
| --- | --- | --- | --- | --- | --- |
| Unauthorized plaintext reads | Notes, recovery content; internet/client → Worker → R2 | API descendants require the current bearer; private R2 has no client credentials; canonical paths, bounded bodies, sanitized errors, and `no-store` responses apply. | One leaked bearer currently reads the whole namespace. Implement scoped client principals, `read` authorization, migration, and revocation. | Worker/Cloudflare/host operators and a correctly authorized read client remain trusted with plaintext; no application E2E encryption is planned. | Slice 2 credentials, then Slice 4 route authorization |
| Unauthorized mutation or deletion | Current/recovery state; client → Worker | Authentication, designated association/writer UUID checks, exact conditional revisions/receipts, recovery-first tombstones, retired v1 mutations, preservation, and typed application policy fail closed. | The current bearer has every operation; permissions are not enforced per client. | A client intentionally granted `write` or `delete` can exercise that authority; application invariants limit effects but cannot infer operator intent. | Slice 4 permission table and enforcement |
| Credential replay after disclosure | Client credentials; any network location → Worker | HTTPS is required outside exact loopback development; tokens are kept in Worker secrets/native SecretStorage and excluded from logs/state/docs. | Current token has no client identity or independent revocation. Add digest-only bounded registry, client-attributed principal, rotation, and revocation procedures. | Bearer credentials remain replayable until verified revocation; M5 adds no proof-of-possession or hardware binding. | Slice 2 credential registry/lifecycle |
| Excessive reads or scans | R2 availability/cost, plaintext exposure, logs; client → Worker/R2 | Payloads and v2 pages are bounded; cursors are opaque/bounded; v1 aggregation has a finite 50,000-object scan ceiling. | Choose evidence-based supported note count, read/list quotas, limiter mechanism, and failure semantics. | Exact quota numbers and a Cloudflare Rate Limiting binding are open; no SaaS-scale or denial-of-service guarantee is claimed. | Slice 1 decision closure, then Slice 3 abuse controls |
| Excessive destructive requests | Current/recovery integrity and cost; authorized client → Worker/R2 | CAS, operation IDs, association continuity, recovery-before-tombstone, permanent tombstones/markers, and idempotent exact replay constrain each operation. | Select destructive quotas and enforce per-principal operation limits without weakening recovery or unknown-effect semantics. | A fully authorized delete client can deliberately consume its accepted quota; platform-level volumetric attacks remain partly a hosting concern. | Slice 1 decision closure, then Slice 3 abuse controls |
| Secret or sensitive log leakage | Credentials, note/recovery bodies, paths, metadata; all runtime/log boundaries | Structured logs omit raw authorization, bodies, concrete note paths, raw exceptions, and storage envelopes; plugin state/status/handoff omit tokens and bodies; artifact tests include leakage negatives. | Add client-attributed audit fields without tokens/bodies, decide retention, and qualify platform/config redaction. | Platform/operator metadata visibility remains inside the trust boundary; arbitrary host/runtime compromise can observe transient plaintext. | Slice 1 retention decision, then Slice 3 telemetry controls |
| Stale writer takeover or delayed old requests | Association/writer identity, R2 state, device state; stale device/plugin → Worker | One explicit writer, pause/drain/handoff, static writer guard, local alignment, conditional generations, and isolated reset procedure; same-realm and schema-version fences fail closed. | Scoped revocation must be coordinated with writer handoff; exact route permissions must not treat writer IDs as authority. | There is still no election, lease, or automatic takeover. A lost writer/ledger requires isolated reset or preserved operator recovery. | Slice 4 authorization/migration and Slice 5 handoff runbook |
| Unsafe code/config/credential rollback | Device state, revoked credentials, format-2 state; operator/deployment boundary | Strict v2→v3→v4 migration, incompatible runtime refusal, no reverse migration, v1 mutation retirement, and forward-only operator guidance. | Prevent/qualify restoration of a credential registry containing revoked digests; define supported release window and complete v1 retirement policy. | Platform rollback controls are operator responsibilities; no claim that every stale but valid snapshot is detectable. | Slice 1 decisions, then Slice 5 upgrade/rollback runbook |
| Corrupted or rolled-back host-local device state | ACKs, effects, reviews, association; host storage → plugin | Strict bounded codecs and cross-field validation, canonical save/read-back migration, content-free state, durable unknown effects, global persistence fences, and fail-closed startup. | Qualify backup/recovery procedures and supported platforms; document evidence-preserving response rather than reset. | Host storage is not transactional/fsync-guaranteed, and a structurally valid historical snapshot may be indistinguishable from current state. | Slice 5 operations and Slice 6 qualification |
| Recovery misuse or premature purge | Recovery plaintext/retention; client → Worker/R2 | Separate metadata/content endpoints, prepared/sealed/expired/purged states, exact ETags, writer IDs, tombstone proof, 30-day semantics, conditional purge to retained marker, and reviewed local-first restore. | Enforce `read` for inspection/content, `write` for non-destructive seal repair, and independent `delete` for purge; choose command versus bounded manual maintenance. | Retention is not physical erasure, recovery is not a full backup, and an authorized delete client can purge eligible content. | Slice 1 maintenance decision, Slice 4 permissions, Slice 5 runbook/tooling |
| Untrusted Markdown interpreted as instructions or active content | Note/recovery plaintext; remote/client → plugin/human/future agent | M4 previews use literal text controls, never Markdown/HTML rendering or command execution; paths/content are validated and bounded; docs state note text is untrusted. | Preserve the content/instruction separation in client contracts and the permission table; include adversarial qualification. | Other trusted host plugins or humans may interpret imported content. Future MCP prompt/tool isolation remains M6 work and receives no pre-authorized shortcut. | Slice 4 boundary contract and Slice 6 qualification |
| Accidental claim that R2 is a full backup | User data and recovery expectations; docs/operator decisions | README, roadmap, architecture, security, and operations call R2 a mirror/API layer, retain conflict/recovery limitations, and prohibit silent resets. | Ensure support/runbooks state practical scale, retention, restore qualification, and external backup responsibilities without unsupported guarantees. | Complete-backup, point-in-time recovery, and physical-erasure guarantees remain out of scope unless separately designed and qualified. | Slice 5 operational documentation and Slice 6 final evidence |
| Remote/storage/runtime partial failure | Current/recovery state, receipts, device state; plugin ↔ Worker ↔ R2 | Conditional transitions, persisted intent before effects, exact receipts, finite retry/evidence budgets, unknown-effect states, archive-first preservation, restart reconciliation, and no abort-equals-rollback claim. | Add operational thresholds, client attribution, runbooks, and qualification for chosen supported envelope. | Cross-system atomicity and continuous availability are not claimed; unresolved evidence may require manual attention. | Slice 3 controls, Slice 5 runbooks, Slice 6 qualification |
| Malicious/buggy authorized client bypasses semantic intent | All remote state; client → route/application boundary | Shared route policy, strict schemas/media/path/size checks, application services, CAS, writer guard, recovery state machine, and stable errors. | One exhaustive operation-permission source must cover v1/v2 compatibility and prevent transport or future MCP from creating a second policy owner. | Permissions bound capability, not client correctness. Authorized conflicting writes remain visible divergence handled by revisions/review. | Slice 4 route-operation policy |
| Dependency, build, Worker, Cloudflare account, or host compromise | Credentials, plaintext, artifacts, deployment; supply/platform boundaries | Locked dependencies/toolchains, canonical checks, generated-artifact leakage tests, no client R2 credentials, official host APIs, minimal current services, and private security reporting. | Define release support/qualification, dependency response, platform evidence, and credential-wide incident rotation. | A fully privileged host, build, Worker, Cloudflare account, or operator compromise can expose plaintext and credentials; M5 provides response/containment, not isolation from the trusted platform. | Slice 5 incident runbook and Slice 6 release/platform qualification |

## Abuse-control and authorization invariants for later slices

- Authentication, permission, writer/association designation, and application
  preconditions are distinct gates. Passing one never implies another.
- `delete` is independently granted. `write` never authorizes note tombstone or
  recovery purge.
- Limits must identify their unit, window, principal, operation class, failure status,
  retry guidance, and behavior under platform failure before implementation.
- Limits must not turn a refused/unknown mutation into a reported success, bypass exact
  receipt recovery, or infer that cancellation rolled back storage.
- Logging may identify the typed client ID and operation class but must not include raw
  tokens, token digests, authorization headers, note/recovery bodies, concrete note
  paths, raw exceptions, or storage envelopes.
- No new Cloudflare service or binding is implied by this threat model. Slice 1 must
  explicitly accept any such dependency before implementation.
- Future MCP is another authenticated client/transport adapter. It receives no direct
  R2 access, writer designation, implicit delete authority, prompt trust, or separate
  credential shape.

## Residual-risk statement

Even after M5, the intended claim is a bounded, reviewed personal bridge—not a
certified secure system, multi-tenant service, complete backup, highly available
service, or defense against fully privileged host/cloud compromise. Real supported
platforms, scale, quotas, retention, release window, and operational evidence remain
open until Slice 1 decisions and later qualification are complete.

## Evidence and related decisions

- [M5 milestone specification](milestones/m5-operational-and-security-readiness.md)
- [ADR 0010 — scoped client credentials and permissions](decisions/0010-scoped-client-credentials-and-permissions.md)
- [Architecture](architecture.md)
- [Verified current state](current-state.md)
- [Worker API](api.md)
- [Operator guide](operations.md)
- [Security policy](../SECURITY.md)
- [ADRs 0001–0009](decisions/README.md)
