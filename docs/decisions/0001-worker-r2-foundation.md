# ADR 0001 — Worker/R2 foundation and inward boundaries

## Status

Accepted — records the already implemented M1 baseline at merged commit
`22d3ee0`. This handoff records current constraints, not a newly discovered
historical approval or a synchronization decision.

## Context

The bridge needs a remote Markdown boundary without coupling application logic
to Obsidian or Cloudflare. M1 has an authenticated Worker API and R2 persistence;
the local plugin and synchronization are not implemented. A simple object-storage
foundation is sufficient for the current operations.

## Decision

- Keep the intended Obsidian → plugin → Worker → R2 topology. Remote clients use
  the Worker boundary, not direct bucket credentials. Future MCP must adapt the
  authorized bridge rather than bypass it.
- Keep Hono/HTTP and OpenAPI/Scalar in Worker transport, services and repository
  ports in platform-independent core, shared Zod wire contracts in protocol,
  and R2/Obsidian APIs in their respective infrastructure adapters. Handlers
  depend on services, not repositories. Do not add ceremonial layers.
- Use the R2 binding with the adapter-private `vault/` namespace. Current remote
  authorization is one bearer token granting all note operations; it is not
  per-user access control. The Worker/cloud operator can read note text.
- Preserve canonical unpadded base64url item identifiers and shared safe relative
  Markdown path validation. Do not return to hierarchical note URLs that can be
  normalized by URL/Fetch handling before validation. Preserve the 1 MiB UTF-8
  note limit unless an explicit future contract decision changes it.
- Do not introduce a database, coordination service, queue or AI/indexing service
  without a demonstrated requirement and a new decision record.

## Consequences

Core behavior can be tested without either platform, and the HTTP API can evolve
without exposing R2 internals. Clients must encode note identifiers and validate
untrusted paths; a base64 identifier is addressing, not encryption or authorization.

Current writes are unconditional, deletes are destructive, listing aggregates all
R2 pages, and credentials cover the whole namespace. These limitations are not
concurrency, recovery, scale or production-security guarantees. Safe publishing,
reconciliation and operational policies require future decisions in M3–M5.

## Alternatives

Direct bucket access from clients would bypass the established API/authentication
boundary. Platform-dependent core would prevent isolated testing and couple
behavior to hosting. Raw hierarchical item routes would undo the implemented
path-addressing hardening. Additional persistence/coordination infrastructure may
be warranted later, but there is no present requirement justifying it.

These are trade-offs of the current architecture, not claims that every
alternative was formally evaluated in an earlier design meeting.

## Evidence / related documents

- [Architecture](../architecture.md), [current-state audit](../current-state.md),
  [roadmap](../roadmap.md), [security policy](../../SECURITY.md).
- `apps/worker/src/app.ts`, `src/auth/`, `src/infrastructure/r2-vault.repository.ts`.
- `packages/core/src/note-path/`, `src/vault/`; `packages/protocol/src/`.
- PR #1 path hardening and M1 implementation; PR #3 engineering-boundary work;
  PR #4 test-layout/coverage baseline. Current source overrides historical prose.
