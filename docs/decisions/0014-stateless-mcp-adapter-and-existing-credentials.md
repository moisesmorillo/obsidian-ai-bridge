# ADR 0014 — Stateless MCP adapter and existing credentials

## Status

**Accepted by the maintainer for this M6 implementation; the repository transition is canonical when the completion PR merges.** The explicit authorization covers the bounded adapter over M5's established authentication, permissions, and application services. The OAuth-profile limitation below is an intentional standards deviation and remains visible in client/qualification documentation.

## Context

M5 already provides registry-only bearer authentication, typed client principals, and one exact independent `read`/`write`/`delete` policy before the Worker resolves application services. The Worker also owns current-generation conditional transitions, recovery-first tombstones, and exact recovery maintenance. The 2026-07-28 MCP revision defines a stateless Streamable HTTP protocol. Its HTTP authorization profile is OAuth 2.1 resource-server authorization: protected-resource metadata must advertise a real authorization server and accepted access tokens must be valid for/audienced to that resource. M5's opaque registry bearers are not OAuth-issued/audience-bound tokens and this product has no authorization server. MCP authorization itself is optional, but HTTP implementations that provide it are expected to follow that profile. MCP must not gain authority beyond M5 or reach R2 directly.

## Decision

- Mount one `POST /mcp` endpoint on the existing Cloudflare Worker/Hono application. Use the official current `@modelcontextprotocol/server` web-standard handler and 2026-07-28 Streamable HTTP; retain no protocol session, Durable Object, separate service, stdio product path, earlier initialize-era protocol, or deprecated HTTP+SSE transport.
- Deliberately use the M5 credential registry as an **application-layer HTTP authentication overlay**, not as a claim of MCP OAuth authorization. Require the same Authorization bearer on every MCP request and carry the resulting existing typed principal into the adapter. Do not add OAuth metadata/AS, token issuer/exchange, OAuth scopes/audience, MCP credential, or a second permission registry. The MCP HTTP authorization profile requires a real authorization server and resource-audienced OAuth tokens; publishing a fake Protected Resource Metadata document or treating M5 tokens as OAuth would be misleading and insecure. This bounded exception is explicitly a **non-conformance/compatibility limit**: current Streamable HTTP protocol calls work for clients configured with a static bearer header, but clients requiring standard PRM/OAuth discovery do not. No overall full MCP specification-compliance claim is made.
- Define one MCP operation-to-permission table based on the established exact permission constants. Authenticated static capability discovery requires no note permission; note/recovery reads require `read`, remote conditional create/update/recreate and recovery seal require `write`, recoverable tombstone and expired recovery purge require `delete`. Every denial precedes application-service/storage/effect resolution.
- Use MCP resources for explicit note/recovery content reads; use narrow tools for one-page listing, content-free inspection, conditional write, recoverable delete, and exact recovery maintenance. Preserve existing application CAS, retention, operation identity, association/writer, and reviewed-local rules. Do not expose receipts, storage keys/envelopes, content hashes, unrequested note content, or reconciliation actions.
- Static metadata only; Markdown remains inert untrusted data. Explicit operation arguments/revisions plus protocol destructive annotations ask the client to provide user confirmation; an input boolean or elicitation round-trip is not treated as proof of user authority. No remote action writes the local vault.
- Reject cross-origin browser requests, bound JSON requests/responses and every page, use no-store, and project only bounded typed errors/content-free request diagnostics. Add no durable audit sink or infrastructure.

## Consequences

The same credential revocation/rotation and exact principal permissions cover REST and MCP. MCP introduces no writer designation or local authority. Per-request stateless hosting fits Cloudflare Workers and the current MCP transport without session infrastructure. Static bearer configuration works only with clients that can set custom headers; the server intentionally omits the separate MCP OAuth authorization profile, PRM/AS discovery, login, and OAuth-only client support. This is a declared standards deviation, not full MCP authorization interoperability. Supporting MCP OAuth later requires a successor decision and the complete current OAuth resource-server/metadata contract; do not misrepresent M5 tokens as audience-bound OAuth access tokens.

The new adapter and permission table must be tested separately from application policy, while the shared conditional-write service prevents HTTP/MCP state-action drift. Errors stay protocol-bounded; request logs identify only the canonical authenticated client ID and closed MCP route category.

## Alternatives

- **Direct R2 access, duplicate REST policy, or a generic `call_api` tool:** rejected because these bypass authoritative application boundaries, reproduce business/security policy, or create an unrestricted capability.
- **A second Worker/service, Durable Object, or stateful MCP session:** rejected because the 2026-07-28 protocol is stateless and the existing Worker already owns auth, services, and R2.
- **stdio-only deployment or deprecated HTTP+SSE:** rejected because the product is a remote Worker bridge and current Streamable HTTP supersedes HTTP+SSE.
- **MCP OAuth server or provider integration:** rejected for this milestone because the product has no authorization server or audience-bound access tokens, M5 requires the same existing credential principal, and new OAuth infrastructure would replace/expand the credential and lifecycle model. The server documents a deliberate application-auth overlay and does not claim OAuth-profile compliance; clients must use configured bearer headers.
- **MCP-specific token, dynamic credential, or wider scope/role:** rejected because M5 bearer tokens are deliberately transport-neutral and already independently revocable.
- **Server-side `confirmed: true` argument or elicitation as destructive proof:** rejected because an agent can self-supply the value and elicitation responses are protocol input, not a durable authority credential; client UX supplies any user confirmation.
- **Remote reviewed-reconciliation tools:** rejected because M4's local effects and reviewed authority cannot be represented safely by the Worker-only remote adapter.

## Evidence / related documents

- [M6 specification and acceptance evidence](../milestones/m6-mcp-adapter.md)
- [M6 final qualification report](../qualification/m6-final.md)
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Official MCP TypeScript web-standard/HTTP server](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/docs/serving)
- [ADR 0010 — scoped client credentials and permissions](0010-scoped-client-credentials-and-permissions.md)
- [ADR 0013 — current v5 observation-gap authority](0013-listener-ready-effect-authority-and-observation-gap-recovery.md)
- Current semantic owners: `apps/worker/src/auth/`, `apps/worker/src/http/v2-route-policy.ts`, `packages/core/src/mirror/current-generation-service.ts`, and `packages/core/src/mirror/recovery-service.ts`.
