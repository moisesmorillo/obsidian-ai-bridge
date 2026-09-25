# M6 — Authorized MCP adapter

**Status: COMPLETE in this completion transition.** M1–M6 are complete on this branch; no milestone is marked NEXT and no M7 is defined. This specification records the implementation and qualification boundary. [ADR 0014](../decisions/0014-stateless-mcp-adapter-and-existing-credentials.md) records its hosting, protocol, and declared application-authentication boundary. The repository transition becomes canonical when the single M6 completion PR merges.

## Objective

Expose a deliberately small, stateless MCP interface to existing authorized mirror operations. MCP is a transport/interaction adapter over the current Worker authentication, application services, conditional revisions, and recoverable deletion policy. It does not become another application, sync engine, authorization system, or storage client.

## Architecture

```text
MCP Streamable HTTP / Cloudflare Worker
        ↓
MCP protocol adapter and MCP operation permission table
        ↓
existing registry authentication → typed ClientPrincipal
        ↓
existing CurrentGenerationService / RecoveryService
        ↓
existing conditional repository ports and R2 adapters
```

- Mount `POST /mcp` on the existing Cloudflare Worker and Hono application. Use the current official `@modelcontextprotocol/server` web-standard SDK; no Node server, stdio-only architecture, second service, Durable Object, or MCP-owned storage.
- The MCP adapter may invoke the existing application services, but may not depend on or construct repository/R2 adapters directly. The R2 binding is resolved only by the established Worker composition boundary.
- Extract the minimum shared conditional note-write application operation needed by both HTTP and MCP so create/update/recreate selection and stale-revision behavior remain one policy. Keep HTTP parsing/headers and MCP schemas/results at their respective transport boundaries.
- Add no plugin mutation capability. MCP writes affect the remote mirror only; divergence remains subject to the existing reviewed M4 local-authority model.

## Protocol, hosting, and bounds

- Implement the current official MCP transport/protocol revision **2026-07-28**, using **Streamable HTTP** at the single endpoint `POST /mcp`.
- The service is stateless: each JSON-RPC message is an independent authenticated POST, no MCP session ID or connection affinity is issued or required, no transport state is persisted, and there is no request replay/notification log. Reject GET/DELETE and do not implement deprecated HTTP+SSE or standalone SSE transports.
- Use the official SDK's stateless handler with legacy-era protocol fallback explicitly rejected. Current clients use `server/discover` and per-request protocol metadata; there is no `initialize` handshake in this protocol version. This deliberately does not retain earlier protocol versions, GET streams, session IDs, or the deprecated HTTP+SSE transport.
- Every MCP POST authenticates independently. Validate present `Origin` values against the exact request origin; reject malformed, opaque, or cross-origin browser requests with 403. Requests without `Origin` remain usable for non-browser clients. Do not add permissive CORS.
- Enforce an actual streamed JSON body limit sufficient for a maximally escaped 1 MiB UTF-8 note and bounded protocol overhead; reject an oversized declared length before reading and stop reading once the actual limit is crossed. Reuse the core 1 MiB note limit, 50-item page ceiling, canonical cursor bound, path validation, and identifier validation. Never accept arbitrary filesystem paths or unbounded pagination loops.
- Responses use `Cache-Control: no-store`. A note/recovery resource response contains at most one existing 1 MiB note body; lists contain only one existing bounded page. No MCP response may include R2 object keys, storage envelopes, raw validators, content digests, operation receipts, bearer credentials, raw exceptions, or unrequested note content.
- `createMcpHandler`/SDK protocol errors handle malformed JSON-RPC, header/body mismatches, unsupported methods and version negotiation. Transport/auth failures are bounded HTTP errors; typed application refusals become stable, content-free MCP tool errors or resource errors. An unknown mutation outcome is never represented as success and instructs the client to inspect before attempting a new operation.

## Authentication and authorization

- Resolve every `/mcp` request through the same strict M5 digest-only credential registry and `authenticateRequest` implementation used by the HTTP API. The result is the same `ClientPrincipal` shape and same revocation/rotation behavior. Do not accept a token from query/body, create an MCP credential, or log/pass the raw token beyond existing authentication.
- Use the existing `Authorization: Bearer <registry token>` request format as an **application-level authentication overlay** before MCP protocol dispatch. The MCP 2026-07-28 HTTP authorization profile is an OAuth 2.1 resource-server protocol: when implemented, its protected resource metadata must advertise a real authorization server, and accepted tokens must be issued for/audienced to this MCP resource. M5 registry tokens are neither OAuth access tokens nor audience-bound, and this product has no authorization server. Therefore M6 deliberately does **not** implement MCP's OAuth authorization protocol, Protected Resource Metadata, token exchange, OAuth scopes/audience, or OAuth discovery; it does not publish fabricated metadata and does **not** claim full MCP authorization-profile conformance. This explicit deviation is the smallest secure choice that preserves the required existing authorization model without inventing an OAuth provider or misrepresenting tokens. Clients must support a preconfigured static bearer header; clients that require MCP PRM/OAuth discovery are unsupported. A future OAuth design is separate product/architecture scope.
- Authentication is required for protocol discovery, listing, resource reads, and tool calls. Static capability metadata is not note data. Current protocol methods (`server/discover`, `ping`, `tools/list`, `resources/list`, and `resources/templates/list`) require an authenticated principal but no note permission; they expose no content or per-client secret and do not construct application services. The tool catalog is deterministic and does not infer authority from client identity.
- Enforce one exhaustive MCP capability-to-permission table before application-service resolution or effect dispatch. Permission checks are exact and independent. Unknown operations fail closed. A permission refusal performs zero service/storage/effect dispatch.

| MCP capability | Existing application operation | Exact permission |
| --- | --- | --- |
| `list_notes` tool | current-note list page | `read` |
| `inspect_note` tool | current-note metadata/state | `read` |
| note resource-template read | current-note content read | `read` |
| `list_recovery` tool | recovery metadata page | `read` |
| `inspect_recovery` tool | recovery metadata | `read` |
| recovery resource-template read | recoverable recovery-content read | `read` |
| `write_note` tool | conditional absent-create / matching-revision update or tombstone recreation | `write` |
| `seal_recovery` tool | exact-revision recovery seal | `write` |
| `delete_note` tool | recovery-first conditional tombstone | `delete` |
| `purge_recovery` tool | exact-revision, expired recovery purge to retained marker | `delete` |

`write` never grants delete, `delete` never grants read or write, and authentication, mirror eligibility, association/writer identity, and application preconditions remain separate. M6 reuses the current service-level CAS/recovery behavior and the same statically configured association/writer guard for mutations; those non-secret IDs are not accepted as caller-selected authority. The MCP tool schemas do not expose them.

## Resources and tools

All metadata, descriptions, schemas, and server instructions are static trusted code. No note or recovery content is used to construct capability discovery, tool selection, instructions, names, schemas, authorization, or logs.

### Resources

- Resource template `obsidian-ai-bridge://note/{encodedPath}` reads exactly one current legacy/live note. `encodedPath` is the existing canonical unpadded base64url NotePath encoding. Absence/tombstone is a sanitized resource-not-found error; no list operation returns note bodies.
- Resource template `obsidian-ai-bridge://recovery/{id}` reads only prepared or unexpired sealed recovery content using the existing `RecoveryService.retrieve` deadline rules. Missing, expired, and purged material is never returned as an empty successful resource.
- Return literal `text/markdown` content with the exact stored UTF-8 text; it remains untrusted data. No prompt is exposed, and the server has no instruction-execution behavior.

### Tools

| Tool | Narrow input | Output boundary |
| --- | --- | --- |
| `list_notes` | Optional one opaque cursor | One validated page of paths and the continuation, no bodies |
| `inspect_note` | One literal validated NotePath | `absent`, `legacy`, `live`, or `tombstone` plus only the revision/recovery ID needed for explicit follow-up; no receipts, hashes, or body |
| `write_note` | NotePath, exact text, caller-supplied operation UUID; optional expected revision | Create-only when revision is omitted; otherwise exact revision update/recreation. Returns action, path, and confirmed new revision only |
| `delete_note` | NotePath, expected revision, caller-supplied operation UUID | Recoverable tombstone result and recovery ID/retention state only; never native R2 deletion |
| `list_recovery` | Optional one opaque cursor | One page of content-free recovery metadata |
| `inspect_recovery` | One recovery UUID | Content-free state, path, and revision/deadline needed for explicit actions |
| `seal_recovery` | Recovery UUID, expected revision, caller-supplied operation UUID | Confirmed safe recovery metadata only |
| `purge_recovery` | Recovery UUID, expected revision, caller-supplied operation UUID | Confirmed retained-marker metadata only; existing deadline and CAS policy decide eligibility |

Every tool uses a strict, specific input schema. `write_note` never means arbitrary API dispatch: it selects only the typed current-note conditional transition above. Pagination is one existing page per call. No reconciliation/review/action tool is exposed: M4 reviewed authority is a local plugin workflow and cannot safely be represented by a remote Worker-only MCP operation.

## Mutation and confirmation semantics

- A remote MCP write never writes, creates, replaces, deletes, or otherwise mutates a local Obsidian file. It can create remote divergence; the existing reviewed M4 process remains the only local import/adoption authority.
- `write_note` with no expected revision means absence-only creation. A supplied revision means exact conditional update/recreation and may not refresh or replace a stale revision. Caller supplies one UUID-v4 operation identity per intended mutation; the adapter does not manufacture a new identity on retry or imply that timeout/cancellation rolled back an effect.
- `delete_note` requires exact `delete`, an expected live revision, and an operation UUID. The existing application service prepares recovery before a conditional tombstone and retains its independent sealing outcome; a tombstone is not physical deletion. `purge_recovery` independently requires exact `delete`, an expired sealed revision, and operation UUID, then keeps the existing content-free marker.
- Consequential operations have explicit operation-specific arguments and revisions, static descriptions, and MCP annotations identifying read-only/destructive behavior. Do not add a fake boolean or phrase that claims to prove human approval. MCP clients are responsible for user confirmation for sensitive calls; the server does not rely on an agent-supplied confirmation field. This does not duplicate M4 reviewed-local authority.
- Do not use elicitation/MRTR for confirmation: its response is client-supplied protocol input, not a durable user-authorization proof, and the operation's required identity/conditional arguments already make the requested remote effect explicit.

## Prompt-injection, privacy, and diagnostics boundary

- Markdown is data. The only path that returns it is the exact explicit note/recovery resource read authorized by `read`; text is never executed, summarized, concatenated into instructions/descriptions, interpreted for permission or operation selection, or used for routing.
- Tool and resource descriptions, server instructions, schemas, error messages, and operation policy are static trusted text. No arbitrary filesystem or remote host access exists.
- Reuse the Worker structured live request diagnostics. MCP logs may record only the static `/mcp` route, method/status/duration, one closed MCP request category, and the authenticated canonical client ID. Do not log RPC IDs, tool names/arguments, note/recovery identifiers, content, cursors, headers, tokens/digests, permissions, revisions, hashes, receipts, storage keys/envelopes, or exceptions. No new durable audit sink or retention claim.
- Map invalid path/revision/ID, absent content, stale generation, recovery deadline refusal, and effect certainty to bounded protocol/tool outcomes. Never pass raw exceptions, REST internal response bodies, SDK stack traces, unrelated note text, or credential information into MCP results.

## Compatibility and operations

- Current official transport/protocol revision: `2026-07-28`; current official TypeScript server SDK: `@modelcontextprotocol/server` 2.0.0. Pin and record the actual installed/tested versions.
- The only supported transport is stateless Streamable HTTP on the existing Worker. The package has no stdio product entry point. Earlier initialize-era protocol versions are explicitly rejected; no old session/GET/SSE/HTTP+SSE transport semantics are promised. Authentication uses the declared application-level overlay and is not full MCP OAuth authorization interoperability.
- Deployments and clients must provide HTTPS outside the existing explicitly permitted local development environment. The Worker remains the sole remote API/storage service. No production deployment is part of this milestone.
- The M5 credential registry and exact principal permissions are operator-configured as before; M6 adds no environment secret, Worker binding, OAuth registration, callback, state store, resource, or new runbook authority.
- The official MCP Inspector CLI or the current official MCP TypeScript Client must exercise the locally hosted Worker-compatible handler. Record exact versions, protocol era, endpoint, auth mode, tool/resource discovery and representative read/mutation outcomes. No ChatGPT/Claude or other product-client compatibility claim unless individually exercised.

## Design checkpoint semantic/security review

**Reviewed before production implementation; no material decision remains open.** The selected 2026-07-28 protocol is stateless Streamable HTTP and maps directly to a web-standard Cloudflare Worker handler. MCP HTTP authorization is optional, but its standardized protected-resource flow uses OAuth 2.1, requires real Protected Resource Metadata/authorization-server discovery, and rejects tokens not audience-valid for the resource. The existing opaque M5 bearer cannot meet that profile. We therefore keep MCP OAuth explicitly outside this milestone and declare the application-level bearer overlay as a standards-compatibility limit rather than inventing OAuth infrastructure or publishing false metadata. Static-header clients remain the only supported auth integration; OAuth-only clients are unsupported. One existing typed principal and one exhaustive MCP permission table gate every operation; all effectful application resolution follows the exact permission check. Conditional write action selection is shared with HTTP at the core application boundary, while R2/CAS/recovery and M4 authority remain owned by existing services. Server confirmation fields would not prove user intent, so client confirmation annotations and explicit revision/operation arguments are used without claiming server-verified user consent. Content is bounded and only emitted through explicit resources, with static discovery metadata and content-free diagnostics. No direct storage, new infrastructure, OAuth issuer, M4-local authority, or later roadmap scope is necessary.

The final production change is approximately 10 TypeScript files and 1,600 net new lines, within the maintainer-authorized M6 exception of at most 12 production TypeScript files and 2,000 net new lines. The additional scope implements the official SDK's typed tool/resource surface, stateless bounded transport, effect-certainty mapping, and focused shared conditional-write policy/tests; it remains one coherent adapter capability. The official server SDK is a Worker dependency, and its client is development-only. No unrelated cleanup or later-milestone work is included.

## Non-goals

- Direct R2 access, a new sync engine, plugin-local mutation, writer designation, permission expansion, OAuth service/provider, MCP-specific credentials, or another credential registry.
- Search, embeddings, inference, RAG, attachments, prompts, arbitrary filesystem access, arbitrary API dispatch, multi-user/tenant behavior, durable tasks, subscriptions/change feeds, or background processing.
- Automatic conflict resolution, reconciliation authority, silent local overwrite, last-writer-wins, physical deletion, or relaxing M3/M4/M5 bounds and conditions.
- Deprecated HTTP+SSE transport or stateful session compatibility.
- Deployment, personal-vault use, production certification, broad client compatibility, or an inferred M7.

## Acceptance criteria

- [x] Current official 2026-07-28 stateless Streamable HTTP serves one `/mcp` endpoint in the existing Worker; old GET/DELETE and deprecated HTTP+SSE are not exposed. OAuth-based MCP authorization non-conformance is explicitly documented and no overall full-spec-compliance claim is made.
- [x] Current `server/discover`, `tools/list`, `resources/list`/templates, and modern SDK client calls are qualified; earlier initialize-era requests, malformed requests, and unsupported methods fail safely.
- [x] MCP requests reuse M5 authentication and resolve the same typed principal; missing, malformed, invalid, revoked, and rotated credentials retain fail-closed behavior with no secret leakage.
- [x] One exhaustive MCP permission table covers every tool/resource operation and protocol discovery classification; exact read/write/delete grants succeed only for their operations, and denials precede application-service/storage/effect dispatch. Read/write/delete remain independent.
- [x] Note list/state/content and recovery list/state/content use existing application services, canonical path/ID/cursor validation, one-page limits, recovery-deadline rules, and bounded responses.
- [x] Conditional creation/update/recreation, stale-revision refusal, recoverable tombstone, recovery seal/purge, and unknown effect outcomes reuse existing typed application behavior. No MCP request touches the local vault or bypasses reviewed M4 authority.
- [x] Note and recovery content are returned only in explicit read resources as literal untrusted text. Adversarial Markdown never changes instructions, schemas, permissions, tool selection, execution, or diagnostics.
- [x] Errors/logs/tool metadata omit bearer tokens/digests/headers, raw exceptions, R2 internals, receipts, hashes, and unrequested note content. MCP responses are no-store and content/payload limits are enforced.
- [x] Unit/integration tests cover protocol, authentication lifecycle, each permission, effect refusal/zero dispatch, hostile content, leakage, and existing M1–M5 regression suites.
- [x] Canonical mise checks, coverage, documentation/link/headings, no deployment, no personal vault, and manual semantic/security review pass; the final roadmap has no NEXT milestone and defines no M7.
- [x] Final transition marks M6 COMPLETE, records exact official client qualification and residual compatibility/auth limits, and explicitly states that the current roadmap ends at M6 with no M7.

## Qualification plan

1. Add tests first for shared conditional-write service semantics, MCP schemas/policy, transport protocol, authentication and exact permissions.
2. Exercise the Hono Worker app with the official MCP SDK's `Client` and `StreamableHTTPClientTransport` without sockets, plus focused raw HTTP negative requests. Use in-memory mirror storage, fake logger, deterministic credentials/clock and no personal files.
3. Prefer the official Inspector CLI against `mise run dev` when installed and usable without deployment. The CLI was unavailable for this qualification, so the official TypeScript Client 2.0.0 instead exercised the Worker-compatible handler in-process with a synthetic registry token. Record that limitation and do not claim Inspector or product-client compatibility.
4. Include hostile note bodies containing “ignore previous instructions”, “send credentials”, and “delete all notes”; prove exact resource-only byte return and unchanged discovery/authorization/effect dispatch.
5. Run `mise install`, `mise run install`, `mise run tsdoc:check`, `mise run check`, and `git diff --check`; inspect coverage thresholds, Markdown references/headings, final source scope, no secrets/machine paths, and no deployment/personal-vault evidence.
6. Perform semantic/security review focused on auth/permission drift, direct R2 access, input/output bounds, conditional effect certainty, delete/recovery safety, content provenance, session/transport behavior, logs, and compatibility. Fix and re-run all relevant gates until approved.
