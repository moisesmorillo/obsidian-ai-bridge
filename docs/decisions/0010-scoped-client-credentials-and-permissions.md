# ADR 0010 — Scoped client credentials, permissions, and lifecycle

## Status

**Accepted — credential/principal/lifecycle contract implemented by M5 Slice 2; route authorization remains Slice 4.** The Worker now resolves strict bounded named credentials to typed principals and provides offline lifecycle tooling. Permission metadata is present but is not yet enforced per route. The explicitly named singleton migration mode remains only as the accepted temporary checkpoint and is scheduled for removal in Slice 4; committed configuration selects registry authority.

## Context

The implemented Worker has one bearer credential with authority over every
authenticated operation in one mirror namespace. Association and designated-writer
UUIDs reduce accidental mutation by cooperating clients, but a bearer holder can
supply those non-secret values and impersonate the writer. One leaked token therefore
exposes plaintext reads, conditional mutations, tombstones, recovery content, and
recovery purge.

M5 needs least-privilege clients, independent revocation, and an explicit rotation
contract before the bridge can make a bounded operational-readiness claim. It does not
need users, tenants, per-note policy, an online credential administration surface, or
an MCP-specific authentication scheme.

## Decision

### Credential model

M5 Slice 2 replaces the default single privileged runtime credential with **bounded named opaque
bearer credentials**:

- The authenticating secret is an opaque, randomly generated bearer token. It contains
  no client ID, permission, user, tenant, route, or MCP semantics.
- Every credential has one immutable canonical lowercase UUID-v4 client ID, one
  operator-facing name, and a nonempty subset of the closed permissions `read`,
  `write`, and `delete`.
- The authenticating registry contains at most **16 active credentials**. Rotation
  overlap consumes two slots. Provisioning must refuse a seventeenth active
  credential rather than evicting or merging another client.
- Names are 1–64 ASCII characters, match
  `[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?`, and are unique among active
  credentials under ASCII case-insensitive comparison. Names are labels, not
  authentication input. Client IDs are never deliberately reused.
- Raw tokens contain at least 256 bits from a cryptographically secure random source
  and use canonical unpadded base64url for operator transfer. User-chosen passwords,
  UUIDs, timestamps, device IDs, and deterministic derivation are forbidden.
- The provisioned Worker registry contains only a versioned cryptographic digest of
  each active token plus non-secret client metadata. It never contains recoverable raw
  tokens. SHA-256 is sufficient for these uniformly random 256-bit secrets; the
  implementation must domain-separate its token digest input, reject duplicate
  digests, and compare every candidate digest without an early-match timing shortcut.
- The registry is supplied as compact JSON through the operator-managed
  `OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY` Worker secret/configuration boundary. Version
  1 is `{version: 1, credentials: [...]}`; entries contain only `clientId`, `name`,
  `permissions`, and `tokenDigest`. Unknown fields are rejected at both levels.
  `tokenDigest` is exactly 64 lowercase hexadecimal SHA-256 characters derived from
  UTF-8 bytes of `obsidian-ai-bridge:client-credential:v1\0` followed by the raw
  token bytes. No D1, KV, Durable Object, R2 credential record, or other service is
  accepted, and raw tokens are never part of this representation.
- A successful request resolves to a typed client principal containing the client ID,
  display name, and exact permission set. Handlers and application composition receive
  that principal rather than an unscoped authenticated boolean.
- Authentication failure remains a sanitized `401`. An authenticated principal that
  lacks the operation's permission is denied without dispatching storage or mutation;
  Slice 4 will define the exact transport response and exhaustive route-operation
  permission table.

Token digests are verifier material and remain confidential configuration even though
they are not raw credentials. They must not appear in API responses, OpenAPI examples,
logs, plugin state, screenshots, handoff records, or committed documentation.

### Closed permission semantics

Permissions are independent capabilities. None implies another, and in particular
`write` **does not imply** `delete`.

| Permission | Intended authority | Excluded authority |
| --- | --- | --- |
| `read` | Authenticated mirror description and current note/list/state reads; recovery metadata and recovery-content reads where applicable | Create, update, tombstone, seal/repair, purge, or any local-vault authority |
| `write` | Non-destructive remote create/update/recreation operations; recovery seal/repair because sealing preserves recovery content and repairs its retention metadata | Note tombstone, recovery purge, local note mutation, writer designation, or credential administration |
| `delete` | Recovery-first note tombstone operations and destructive recovery purge to the retained marker | Ordinary create/update, reads, writer designation, or credential administration |

A client may receive any nonempty combination. A designated writer plugin is expected
to require all three permissions for its current complete M3/M4 remote behavior, but
that expectation does not make the permissions imply one another. A read-only client
needs only `read`. Public health/OpenAPI/documentation routes do not resolve a client
principal. Retired v1 mutations remain retired regardless of permission.

This table defines operation semantics, not exact route mapping. M5 Slice 4 owns one
exhaustive route-operation permission table derived from the implemented API and must
cover compatibility routes, unknown descendants, preflight behavior, and every
mutation. No route may infer `delete` from an HTTP method alone without the table's
reviewed operation semantics.

### Separate writer and association guards

Client authorization and mirror mutation authority remain separate checks:

1. authenticate the bearer and resolve the client principal;
2. authorize the named operation against the principal's exact permissions;
3. for designated-writer mutations, validate the existing association, writer, and
   operation identities;
4. apply current application preconditions, revisions, receipts, preservation, and
   recovery policy.

Permissions do not designate a plugin writer, transfer an association, bypass
conditional revisions, or convert writer IDs into secrets. Conversely, matching
association/writer IDs do not grant a client permission. This preserves ADR 0003's
cooperating-writer guard while removing its dependence on one globally privileged
bearer.

### Credential lifecycle contract

#### Provision

1. Choose an allowed unique client name and the least permissions needed.
2. Generate a new client ID and at least 256 random token bits on a trusted operator
   machine. Generation must fail closed if the secure random source is unavailable.
3. Derive the domain-separated digest and construct a registry entry. Validate the
   complete registry, including version, unique IDs/names/digests, permission values,
   and the 16-active-credential bound, before replacing active configuration.
4. Display the raw token exactly once to the operator through the provisioning tool.
   Do not write it to repository files, command arguments, shell history, logs,
   clipboard history under tool control, generated reports, or registry output.
5. Install the token in the intended client's approved secret store and apply the
   digest-only registry through the authorized Worker secret/configuration process.
6. Verify the deployed registry version and the new client before granting operational
   reliance. Provisioning is not complete merely because local registry generation
   succeeded.

There is no credential-management HTTP/admin API in M5. Provision, rotate, revoke, and
recover use `mise run credentials -- ...`, which accepts metadata and an outside-repo
registry path, refuses raw-token arguments and redirected secret output, atomically
writes owner-only digest configuration, and displays a generated raw token once in an
interactive terminal. Applying that registry through the hosting platform remains a
separate explicit operator action; the tool makes no HTTP administration or deployment
call.

#### Rotate with bounded overlap

Rotation creates a distinct replacement credential with a new client ID and token; it
does not mutate or reveal the old token.

1. Preserve and, for a mutation client, pause or settle relevant in-flight work under
   the existing M3/M4 operational rules.
2. Provision the replacement with the intended least permissions while the old client
   remains active. Refuse the operation if the 16-entry bound leaves no overlap slot;
   the operator must explicitly revoke another credential or choose a controlled
   no-overlap outage.
3. Install the replacement token in the client and verify that requests authenticate
   as the new principal and that the intended non-destructive permission checks pass.
   Slice 4/5 runbooks must define verification without using destructive data as a
   probe.
4. Switch the client to the replacement and confirm old in-flight work is settled or
   conservatively recoverable.
5. Revoke the old credential independently by removing its digest from the active
   registry, apply and verify the new registry version, then prove that the old token
   is rejected.

Overlap is manual, bounded, and temporary. M5 introduces no automatic grace period,
expiry scheduler, refresh token, dual-token alias, or background rotation service.
Rolling back to a registry snapshot containing a revoked digest re-enables that
credential and is therefore prohibited.

#### Revoke and replace a lost token

Each client can be revoked without changing other clients. Revocation removes that
client's digest from the active registry and becomes effective only after the new
registry is applied and verified. A raw token cannot be recovered from its digest and
there is no token-recovery endpoint.

Treat a lost token as potentially disclosed. Provision a fresh replacement, move the
client, and revoke the old credential; if compromise is plausible, minimize or skip
overlap and accept a controlled client outage rather than leave the old token active.
Inspect affected client-identified operational evidence according to the Slice 5
incident runbook. Do not rename a surviving credential and pretend that the lost token
changed.

#### Recover from total registry loss

If the registry is unavailable or cannot be trusted:

1. fail authentication closed and pause clients/writer mutation admission;
2. preserve R2 data, device state, receipts, unresolved operations, and platform audit
   evidence—registry loss is not authority to reset or delete them;
3. do not attempt to reconstruct raw tokens from digests, client settings, logs, or
   documentation;
4. create a complete replacement registry with fresh client IDs and tokens, reinstall
   each client deliberately, and revoke the lost registry by replacing the active
   configuration;
5. verify every required principal and permission, then reconcile possibly committed
   in-flight effects through existing exact receipt/state procedures before resuming.

A known-good digest-only registry backup may be restored only under the versioned
rollback/runbook rules established in Slice 5. An arbitrary stale snapshot must not
restore revoked authority.

### Explicit exclusions

M5 credentials do not add OAuth, JWT, Cloudflare Access, cookies, users, tenants,
roles beyond the three permissions, per-note/folder ACLs, or online credential
administration. They do not encode an MCP tool or client type. Future MCP may map its
tools to the same operation permissions, but M6 cannot bypass the typed principal,
route-operation policy, writer guard, or application services.

## Consequences

A leaked read-only token no longer grants mutation or recovery purge, and one client
can be revoked without rotating every other client. A full writer credential remains
high impact because it needs read/write/delete, so secure client storage, bounded
rotation overlap, logs, and incident procedures still matter. Opaque tokens cannot be
recovered; operator discipline and fresh replacement are intentional costs.

Digest-only configuration reduces the consequence of registry disclosure but does not
make verifier material public or protect plaintext from a compromised Worker/runtime,
Cloudflare operator, authorized client, or trusted Obsidian host. The 16-client bound
fits the intended personal bridge and keeps authentication work deterministic; it is
not a SaaS tenant limit or an accepted request quota.

Slice 2 implements the deliberate checkpoint with the exact
`OBSIDIAN_BRIDGE_AUTH_MODE` values `singleton-migration` and `credential-registry`.
Only the selected authority is evaluated: a staged registry is ignored in singleton
mode, and a still-present old singleton secret is ignored in registry mode. Missing or
unknown mode and malformed registry configuration fail closed. Committed Wrangler
configuration selects registry mode, so the old singleton no longer authenticates at
the Slice 2 endpoint. Slice 4 must remove the temporary singleton mode after client
migration while adding route-level permission enforcement; it may not normalize this
checkpoint into a permanent fallback.

## Alternatives

- **Keep one privileged bearer:** simplest, but prevents least privilege and
  independent revocation; rejected for M5 readiness.
- **OAuth/OIDC, JWT, or Cloudflare Access:** useful for multi-user or federated systems,
  but disproportionate to a personal bridge and introduces issuer/session/key policy
  not required here; rejected for M5.
- **Per-note or per-folder ACLs:** conflates mirror scope with authorization and adds a
  policy model unsupported by current product semantics; rejected.
- **MCP-specific tokens:** would duplicate authorization and let transport shape
  authority; rejected. M6 maps tools to established permissions.
- **Raw-token server registry:** enables recovery but turns registry disclosure into
  immediate credential disclosure; rejected.
- **New database/service for credentials:** no demonstrated need at the bounded scale;
  rejected unless a successor ADR establishes one.

## Evidence / related documents

- [M5 specification](../milestones/m5-operational-and-security-readiness.md)
- [Consolidated threat model](../threat-model.md)
- [Roadmap](../roadmap.md)
- [Security policy](../../SECURITY.md)
- [ADR 0003](0003-publishing-association-and-local-state.md)
- Current implementation: `apps/worker/src/auth/`,
  `apps/worker/src/http/authentication.middleware.ts`,
  `apps/worker/src/http/v2-route-policy.ts`, and `apps/worker/src/env/env.types.ts`
