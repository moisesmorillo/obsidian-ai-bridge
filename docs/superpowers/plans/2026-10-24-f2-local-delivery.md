# F2 Local Delivery Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`. Complete each task and its review before the next task. Track steps with these checkboxes.

**Goal:** Complete OAB-7.2 through OAB-7.6 locally without deployment or later phase work.

**Architecture:** One Worker hosts OAuth, verified Access pages, REST, and MCP. Existing application operations and the SQLite DO remain authoritative. A durable grant registry connects consent, token issue, and owner revocation.

**Tech Stack:** Bun, TypeScript, Hono, Zod, SQLite Durable Objects, R2, Vitest, and workerd. Add pinned OAuth, MCP, and JWT libraries for the contracts below.

**Spec:** `docs/spec.md` sections 2, 6, 8, 9, 10, 12, 13, and 14 F2. OAB-7 and its subtasks define delivery boundaries.

## Scope and approval

- Main matches merged PR #21 at `860e4622bb59de67821c38d23cd22951e2cad9c8`.
- Branch: `feature/oab-7-f2-local`.
- Worktree: `~/.worktrees/obsidian-ai-bridge/feature/oab-7-f2-local`.
- This is the single plan for OAB-7.2 through OAB-7.6.
- The plan review also approves its implementation choices and ordered execution.
- After approval, complete the five tasks without another owner gate between tasks.
- Use one writer at a time. Each worker owns tests, implementation, formatting, checks, and its commit.
- Use one fresh reviewer per task. Use the session model for the final complete branch review.
- Open one human branch review against `main`, then one pull request.
- Stop before OAB-7.7. Ask for explicit deployment authorization after local delivery.
- Do not start OAB-7.8, OAB-8, or later phases.
- Do not access the personal vault or change Cloudflare resources.
- Keep OAB-7 open. Local success does not satisfy the complete F2 exit gate.

## Current implementation

`apps/worker/src/index.ts` always returns no identity. It composes `createWorker` with the real DO and R2 adapters.

`transport/worker.ts` exposes REST only. HTTP fixtures inject test identities, so their success does not prove production authentication.

`application/text-files.ts` owns PUT and DELETE coordination. `application/history.ts` owns append, rename, and restore coordination.

`application/reads.ts` owns bounded metadata traversal. `application/search.ts` owns literal search coordination.

`Vault` delegates to SQLite owners. `SqliteAdmissionAuthority.recordRevocation` persists grant denial, but the production DO exposes no owner operation.

Schema version 6 contains `clients` and `revoked_grants`. It contains no complete grant registry or consent generation fence.

`TextReadRequestSchema` supports revision selection and UTF-16 fragments. MCP must compare the selected current ETag before it returns a fragment.

## Approach and decisions for approval

Use the specified provider in one Worker. A separate authorization Worker adds deployment bindings without a local contract benefit.

Do not replace the provider with custom OAuth or trust bearer text directly. Do not use HTTP fixture identities in F2 acceptance tests.

Pin these dependencies when their task starts:

- OAB-7.2: `@cloudflare/workers-oauth-provider@1.2.4` for OAuth, discovery, registration, consent helpers, and rotation.
- OAB-7.2: `jose@6.1.3` for Access JWT verification and bounded remote key retrieval.
- OAB-7.4: `@modelcontextprotocol/server@2.4.0` for MCP dispatch, schemas, and protocol negotiation.

Record each dependency purpose in its Backlog task. Do not add another dependency without a concrete need.

Use stateless Streamable HTTP. Do not add sessions, resumable events, legacy SSE, or a second server.

The stock MCP HTTP transport buffers JSON output. Do not weaken the existing bounded response contract to use it unchanged.

Use the SDK's supported `Transport` boundary for a per-request HTTP adapter with incremental JSON encoding. Reuse existing response ownership and encoding mechanisms.

The SDK owns MCP message semantics. The adapter owns HTTP validation, byte limits, delivery, cancellation, and cleanup.

Use `structuredContent` for machine-readable tool results. Do not repeat complete note bodies in a second text representation.

Bound list and history results before aggregation. Return a clear bounded error instead of an incomplete success when a result exceeds the budget.

For large lists, tell the caller to narrow `prefix`. Do not add a new pagination argument or silently truncate results.

Use one canonical HTTPS service origin from configuration. The shared OAuth resource is that origin, not its `/mcp` path.

The provider rejects sibling `/v1` routes under a `/mcp` resource. Publish matching discovery and reject requests for an unexpected origin.

Do not derive OAuth issuers, resources, redirects, or vault authority from an untrusted Host header.

Use a configured owner subject and Access application audience. Missing configuration denies access. Synthetic test values do not become deployment values.

Use durable client generations to order consent against revocation. Fresh consent can reconnect a client. An old code or refresh cannot reconnect it.

Add an internal grant registry and client generation table. Upgrade valid schema-6 stores transactionally without changing epoch or existing data.

Reject unsupported or malformed stores without repair. Do not reset a vault to add authentication tables.

## Global constraints

- Preserve exact observed-revision mutation conditions.
- Absence never deletes. Obsolete revisions never overwrite.
- Every collision preserves two visible files or revisions.
- `vault:write` never implies `vault:delete` or `vault:read`.
- Each operation checks scope and revocation in the Worker and the DO.
- Protocol shapes live only in Zod schemas under `packages/protocol`.
- Derive contract types from schemas. Use the existing workspace import rules.
- Keep transport dependencies outside application modules.
- Document named semantic declarations with useful TSDoc.
- Keep API documentation outside transport handlers.
- Inline note limit: 1,000,000 UTF-8 bytes. Blob limit: 25,000,000 bytes.
- Search query: 3–200 Unicode code points. Limit: 1–50, default 20.
- Preserve four shared mutation slots and four shared authoritative read slots.
- Preserve response chunks of at most 65,536 bytes and lazy metadata batches.
- Preserve per-client receipt identity and exact immutable retry payloads.
- Append keys accept opaque strings of 8–128 characters. Receipts last 30 days.
- State explicitly that a retry after receipt retention can duplicate an append.
- Do not claim plugin status, queue preservation, external-client success, or deployed authentication.

## Feasibility evidence and budgets

Read current primary sources on 2026-10-24:

- Provider package declarations and README: `https://github.com/cloudflare/workers-oauth-provider`.
- Provider authorization reference: `https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md`.
- Consent helpers: `https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md`.
- Access verification: `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`.
- Worker limits: `https://developers.cloudflare.com/workers/platform/limits/`.
- Published MCP 2.4.0 declarations expose `McpServer`, `Transport`, and `WebStandardStreamableHTTPServerTransport`.

The provider callback exposes verified `clientId`, `grantId`, requested scopes, and environment bindings. It supports token-specific props and stable refresh identity.

The provider supports S256, DCR, pre-registration, discovery, and refresh rotation. Confidential clients can omit PKCE by default. This service must reject that omission.

Provider consent helpers bind a single-use handle to a browser cookie for ten minutes. Use them instead of a custom consent token.

Access keys come from the configured team domain at `/cdn-cgi/access/certs`. Pin issuer, audience, owner subject, and RS256.

The initial Bun import probe failed because the provider imports `cloudflare:workers`. Runtime probes must use workerd, not Bun alone.

Baseline `bun install --frozen-lockfile && bun run check` passed before product edits. The build used `wrangler deploy --dry-run` only.

The workerd probe passed provider discovery, MCP initialize, and RS256 signing and verification on the current runtime.

Discovery returned only `authorization_code` and `refresh_token`. The probe used local KV and no remote resources.

The first workerd probe rejected the sibling resource paths. Changing the shared resource to the origin resolved that startup failure.

The final workerd probe also passed initialize through the SDK's custom `Transport` boundary. It returned `CUSTOM_TRANSPORT pass`.

Final probe result: four checks passed, zero failed, exit zero. The temporary probe files remain outside the repository.

These probes do not prove complete F2 behavior. No platform capability probe remains unresolved at the plan gate.

Workers Paid is the accepted product plan in section 2. Current published limits include 128 MB per isolate and 30 seconds default HTTP CPU.

Current Paid subrequest default is 10,000. Bound owner cleanup below 50 remote operations anyway. Do not assume a deployed account configuration.

| Boundary | Budget and limit behavior |
| --- | --- |
| MCP envelope | At most 6,100,000 wire bytes. This accommodates worst-case JSON escapes for a 1,000,000-byte note. Reject larger input before JSON parsing. |
| MCP concurrency | One isolate-wide envelope slot before body demand, through response production and cleanup. Another MCP request receives 429 and `Retry-After: 1`. |
| MCP memory | Conservative envelope work: 6.1 MB bytes + 12.2 MB decoded text + 8 MB parsed/result strings + bounded chunks. No complete serialized result. |
| Mixed traffic | MCP operations also use existing read or mutation admission. Test simultaneous MCP, REST bodies, and REST responses. Preserve the 128 MB Worker envelope. |
| Metadata output | At most 256 result rows and 1,000,000 estimated output bytes. Read one bounded batch at a time. Excess returns an explicit error, never partial success. |
| Owner pages | At most 32 clients or grants per page. Escape every untrusted field. Do not collect all KV grants. |
| Owner revocation | One DO transaction closes the client generation and denies registered grants. Provider cleanup handles at most 16 grants per request. A later owner request resumes cleanup. |
| Token callback | One bounded DO call records or verifies a grant before token issue. Refresh does not create duplicate registry rows. |
| Access keys | One endpoint, 65,536 response bytes, 5-second timeout, at most 16 keys, and a 5-minute cache. Unknown keys or fetch failures deny access. Never follow JWT-supplied key URLs. |
| Durable registry | Enforce a finite local registry ceiling before token issue. Use 1,024 clients and 8,192 grant rows per vault. Deny new entries at capacity. Existing reads and revocation continue. |

The selected registry ceilings are local safety defaults, not a deployed capacity claim. The owner can review these defaults at this plan gate.

No local test proves edge Access policy, account tier, remote latency, or external-client behavior. Those remain OAB-7.7 and OAB-7.8 evidence.

## Review focus and test ownership

1. Malicious registered names and redirects must not execute script or forge approval. OAB-7.2 and OAB-7.3 own these tests.
2. A code exchange or refresh races owner revocation. Old consent must never issue usable access afterward. OAB-7.3 owns this matrix.
3. Two fragments span a concurrent note edit. The second result returns the new ETag without content. OAB-7.4 owns this test.
4. A failed or lost response precedes a retry under another client or epoch. OAB-7.5 owns receipt and stale-epoch tests.
5. Slow or cancelled MCP responses overlap REST traffic. Slots stay owned until started work and cleanup settle. OAB-7.6 owns aggregate tests.

## File and interface map

Create focused modules, not empty architectural layers:

- `packages/protocol/src/schemas/auth.ts`: validated configuration, owner, client, grant, and consent contracts.
- `packages/protocol/src/schemas/mcp.ts`: tool input and output schemas, including epoch-bearing errors.
- `packages/protocol/src/index.ts`: public schema and derived-type exports.
- `apps/worker/src/infrastructure/auth/access.ts`: configured Access verifier and key retrieval.
- `apps/worker/src/infrastructure/auth/oauth.ts`: provider configuration, callback, and verified identity mapping.
- `apps/worker/src/infrastructure/sqlite/clients.ts`: client registration, generations, grants, naming, and revocation transactions.
- `apps/worker/src/application/clients.ts`: small owner-operation boundary and revocation ordering.
- `apps/worker/src/transport/authorize.ts`: consent HTTP pages and form handling.
- `apps/worker/src/transport/owner.ts`: protected client pages and state changes.
- `apps/worker/src/transport/mcp-http.ts`: per-request SDK transport and owned streaming responses.
- `apps/worker/src/transport/mcp.ts`: SDK server construction and tool registration.
- `apps/worker/src/application/mcp-notes.ts`: note argument mapping to existing application operations.
- `apps/worker/src/index.ts`: production composition only. Keep the `Vault` export.
- `apps/worker/src/env.ts`, `wrangler.jsonc`: typed bindings and local configuration seams.
- `apps/worker/src/infrastructure/durable-object/vault.ts`: thin RPC methods for the registry owner.
- SQLite schema model, generated schema, and bootstrap: narrow schema-6 upgrade and registry validation.
- `apps/worker/vitest.f2.config.ts`: production-entry workerd tests with local KV, DO, R2, and synthetic configuration.
- `apps/worker/test/fixtures/f2-auth.ts`: synthetic signing keys, HTTP cookies, PKCE, registration, and token helpers.
- `apps/worker/test/f2/*.test.ts`: production-composition authentication and MCP tests.
- `docs/api/f2.md`: implemented public contracts, local commands, error behavior, and evidence limits.

Use existing interfaces where they fit. Add ports only for capabilities that callers actually need.

## Common task cycle

Each task includes these steps:

- [ ] Read its Backlog criteria and this plan section.
- [ ] Mark only the current task In Progress and assign `@pi` through the CLI.
- [ ] Write its failing tests before implementation.
- [ ] Run the focused tests and record the real failing assertions in task notes.
- [ ] Implement the smallest complete change and run the focused tests again.
- [ ] Run `bun run docs:check`, then `bun run check`.
- [ ] Record commands, results, scope, and limits in task notes. Do not create evidence documents.
- [ ] Commit with a Conventional Commit message.
- [ ] Get one fresh code-review subagent result with the TypeScript profile.
- [ ] Address findings with explicit closures and focused checks.
- [ ] Read the finalization guide and close criteria only with test evidence.
- [ ] Continue directly to the next task after acceptance.

Wrap expected failing test commands so the background task records their exit without reporting an infrastructure failure.

## Task 1: OAB-7.2 — Real OAuth and verified Access

**Files:** Auth schemas and adapters, consent transport, production composition, bindings, F2 test configuration, and auth tests.

**Consumes:** Existing `createWorker`, `AuthorizationContextSchema`, and real DO operation interfaces.

**Produces:** `verifyOwnerAccess(request, env): Promise<OwnerIdentity | null>` and provider-backed `AuthorizationContext` mapping.

Only the configured owner subject passes `verifyOwnerAccess`. The result contains verified subject data, not a bearer token.

The provider callback returns token props with the verified provider client and grant identities. Scope context comes from validated token scope, not consent text.

- [ ] Add `oauth.test.ts` and `access.test.ts` under `test/f2`.
- [ ] Assert an unauthenticated production REST request fails before DO or R2 work.
- [ ] Assert DCR and a pre-registered public client complete code plus S256 PKCE.
- [ ] Reject wrong verifier, reused code, unregistered redirect, missing PKCE, plain PKCE, client credentials, and unknown scopes.
- [ ] Assert discovery matches the configured issuer and resource.
- [ ] Assert consent shows escaped client name, full redirect URI, scopes, and a client naming field.
- [ ] Test forged, expired, reused, or foreign-browser consent handles and explicit denial.
- [ ] Verify signed Access JWTs against synthetic JWKS with the real verifier.
- [ ] Reject wrong signature, algorithm, issuer, audience, owner, expiry, future validity, malformed claims, and missing configuration.
- [ ] Reject JWT header key URLs and key endpoint failures. Test key rotation with bounded cache behavior.
- [ ] Implement the provider and Access adapters without a development identity bypass.
- [ ] Enable code and refresh grants only. Disable token exchange, CIMD fetching, and external-token acceptance.
- [ ] Keep DCR and pre-registered clients enabled. Do not add a new remote metadata fetch path.
- [ ] Test rotating refresh, downscoped refresh, malformed tokens, expired tokens, and failed refresh.
- [ ] Preserve the requested scopes exactly. Test that write-only access cannot read or delete.
- [ ] Include the production-entry F2 suite in `bun run check`, separate from injected F1 fixtures.
- [ ] Complete the common task cycle with commit `feat(worker): connect OAuth and verified Access`.

## Task 2: OAB-7.3 — Owner console and durable revocation

**Files:** Client application boundary, SQLite registry, schema bootstrap, DO RPC, owner transport, OAuth callback integration, and owner tests.

**Consumes:** Verified Access identity, provider helpers, and the existing DO revocation checks.

**Produces:** Durable consent generation, grant registration, client listing and naming, and revocation before provider cleanup.

Expose thin DO methods for `beginClientConsent`, `registerClientGrant`, `listClients`, `renameClient`, and `revokeClient`.

Define their request and result shapes in `schemas/auth.ts`. Every owner operation uses the configured owner identity and selected canonical vault.

`beginClientConsent` returns the current client generation and an opaque consent identity. Store these in provider-controlled authorization props.

`registerClientGrant` accepts the provider callback's actual grant identity and consent generation. It rejects an obsolete generation before token issue.

`revokeClient` atomically advances the generation and inserts all known grant IDs into `revoked_grants`. It also invalidates pending consent from that generation.

A callback before revocation registers a grant that revocation denies. A callback after revocation fails its generation check.

Fresh owner consent uses the new generation. It never removes old grant denials.

- [ ] Add registry tests, schema upgrade tests, and `owner.test.ts`.
- [ ] Assert schema-6 upgrade preserves epoch, files, history, receipts, counters, and existing grant denials.
- [ ] Test interrupted upgrade rollback and unsupported-store rejection without replacement.
- [ ] Test paged client listing, owner names, escaped hostile content, and unauthorized callers.
- [ ] Protect state changes with verified Access, same-origin validation, and browser-bound single-use CSRF state.
- [ ] Test code exchange before and after revocation, refresh races, pending consent, and fresh reconnection.
- [ ] Test repeat revocation and all grants for the selected client, including multiple authorizations.
- [ ] Force stale provider KV reads and provider cleanup failure. Assert the next REST request returns `401 revoked`.
- [ ] Assert direct authoritative operations also reject the grant. Task 3 adds MCP denial tests after MCP exists.
- [ ] Assert a committed mutation survives revocation. A reserved but uncommitted mutation must recheck revocation.
- [ ] Keep failed KV cleanup visible and retryable. Do not report complete provider cleanup while it remains pending.
- [ ] Test registry ceilings and bounded provider cleanup without unbounded grant collection.
- [ ] Complete the common task cycle with commit `feat(worker): add owner console and durable revocation`.

## Task 3: OAB-7.4 — MCP discovery and read tools

**Files:** MCP schemas, HTTP transport, server composition, note read mapping, protocol tests, and MCP read tests.

**Consumes:** Provider identity context and existing read, content, history, and search operations.

**Produces:** Authenticated `/mcp`, initialization, discovery, `tools/list`, and four read tools.

`createMcpServer(identity, gateways)` registers tools from canonical schemas. It never reads identity from tool arguments.

Read tools return the current `epoch` with structured results and bounded errors. Authentication failures retain their HTTP 401 challenge.

- [ ] Add schema tests and production-entry `mcp-reads.test.ts` before implementation.
- [ ] Test initialize, initialized notifications, ping, tools/list, unknown methods, malformed messages, and unsupported protocol versions.
- [ ] Test POST content negotiation, optional Origin validation, GET and DELETE behavior, and cancellation in stateless mode.
- [ ] Implement the SDK transport boundary with lazy response encoding. Do not materialize a complete escaped JSON result.
- [ ] Publish RFC 9728 resource metadata and RFC 8414 authorization metadata with matching configured URLs.
- [ ] Include initialize instructions from section 8 and `Agents/Log/YYYY-MM-DD.md` from section 2.
- [ ] Implement `list_notes(prefix?, include_large?)`, `read_note(path, etag?, offset?, length?)`, `search_notes(query, limit?)`, and `get_history(path)`.
- [ ] List live Markdown and Canvas notes. Include large notes only when requested. Preserve exact paths and ETags.
- [ ] Compare `read_note`'s optional ETag with the same selected revision that supplies content. Mismatch returns current ETag without content.
- [ ] Test concurrent edits between fragments, Unicode offsets, tombstones, missing notes, and large-note range bounds.
- [ ] Preserve search semantics, coverage counts, literal punctuation, diacritics, and section 10 limits.
- [ ] Test current epoch, missing scope, and authoritative revocation for every tool. Check policy before tool discovery too.
- [ ] Test oversized metadata results as bounded errors without a partial success or full-vault materialization.
- [ ] Complete the common task cycle with commit `feat(worker): add authenticated MCP read tools`.

## Task 4: OAB-7.5 — Conditional MCP mutation tools

**Files:** MCP mutation schemas, note command mapping, registrations, and `mcp-mutations.test.ts`.

**Consumes:** `executeTextMutation`, `executeFileCommand`, verified identity, and current result/error contracts.

**Produces:** `create_note`, `update_note`, `append_to_note`, `delete_note`, and `restore_note` from section 8.

Keep one authority path. MCP maps arguments into existing commands and does not call SQLite directly or send internal REST requests.

- [ ] Write production-entry tests for every mutation and its denied scope before implementation.
- [ ] Use create-only conditions plus explicit epoch for create. Return existing ETag on an existing path.
- [ ] Require exact update and delete ETags. Never turn update into an unconditional PUT.
- [ ] Require append epoch and idempotency key. Missing append key returns the specified 428 condition.
- [ ] Bind immutable payloads and opaque keys to the existing client-scoped receipt coordinator.
- [ ] Parse both restore ETags. Reject incompatible epochs before mutation. Keep exact current-revision conditions on retry.
- [ ] Preserve restore's in-place `as_conflict_copy` behavior and displaced revision history.
- [ ] Test stale epochs, stale ETags, path collisions, tombstones, UTF-8 size limits, and oversized append results.
- [ ] Test response loss, same-key retry, changed-payload retry, and two clients with the same key.
- [ ] Test revocation during preparation and before commit. No revoked retry may replay a successful receipt.
- [ ] Include authorized conflict content only with read scope. Write-only clients receive metadata without note content.
- [ ] Assert agent client origin, one revision, and one feed entry for each successful operation or exact retry.
- [ ] Return epoch-bearing canonical failures without leaking exception text, tokens, or unrelated note bodies.
- [ ] Complete the common task cycle with commit `feat(worker): add conditional MCP mutation tools`.

## Task 5: OAB-7.6 — Local F2 integration and contracts

**Files:** `test/f2/integration.test.ts`, aggregate budget tests, public API documentation, and any corrections these tests expose.

**Consumes:** The production entry with actual provider, synthetic Access signatures, local KV, real DO, and local R2.

**Produces:** Passing local F2 integration evidence, documented implemented contracts, and explicit remaining phase boundaries.

- [ ] Add the missing end-to-end tests first. Do not use injected F1 identities.
- [ ] Complete registration, consent, token issue, REST read/write, MCP read/write, refresh, and owner revocation through production composition.
- [ ] Repeat with a pre-registered client and independently scoped clients.
- [ ] Prove next-request DO revocation despite stale KV and failed provider cleanup.
- [ ] Add aggregate tests for worst-case escaped note input/output, concurrent REST traffic, slow consumers, cancellation, and cleanup failures.
- [ ] Assert envelope limits before parsing and slot limits before body demand. Assert bounded output chunks.
- [ ] Assert no full serialized note result, no unbounded metadata collection, and no early slot reuse after cancellation.
- [ ] Exercise registry and result limits without changing the data-safety rules to pass tests.
- [ ] Document public routes, scopes, tool arguments, ETags, epochs, errors, owner controls, and local test commands in `docs/api/f2.md`.
- [ ] Document canonical origin, Access issuer/audience/owner settings, and local KV configuration without real secrets or resource IDs.
- [ ] Keep real deployment commands behind the later authorization boundary. Do not run them.
- [ ] Run `bun run docs:check` and `bun run check`. Record actual commands and results in OAB-7.6.
- [ ] Complete task review and commit `test(worker): verify local F2 authentication and transports`.

## Final acceptance and publication

- [ ] Review the complete branch against `main` with the branch-review profile on the session model.
- [ ] Record reviewed revision, documentation scope, structural candidates, validation results, limits, and each finding closure in Backlog notes.
- [ ] Open one Plannotator branch review against `main`. Address every annotation.
- [ ] Run the final branch check after corrections. Do not replace tests with review verdicts.
- [ ] Follow `finishing-a-development-branch`. Push one branch and open one English Conventional Commit pull request.
- [ ] Check actual remote CI. Do not claim remote success from local output.
- [ ] Remove the clean worktree only after publication. Keep the remote branch and never merge locally.
- [ ] Keep OAB-7.7 and OAB-7.8 open. Keep the parent F2 gate open and do not start OAB-8.
- [ ] Ask for OAB-7.7 deployment authorization with explicit environment, resource operations, Access settings, and synthetic test scope.

The final authorization request is outside this local implementation plan. It cannot authorize deployment by implication.
