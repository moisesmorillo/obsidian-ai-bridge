# M8 local sync API implementation plan

> **For agentic workers:** Use `executing-plans` inline with focused TDD. The owner
> already authorized routine implementation after specification merge; no new
> planning approval is required within this scope.

**Goal:** Authenticated synthetic REST create/read/update/replay/feed over the real
private SyncStore, isolated from release routes and deployment.
**Architecture:** Core owns admitted path/content policy over SyncStore. Strict
protocol schemas own wire contracts. A separate Hono app and Worker entrypoint own
loopback, participant binding, permission checks and local R2 composition.
**Tech stack:** Existing TypeScript, Zod/OpenAPIHono/Scalar, workerd/R2, Vitest, mise.
**Spec:** `docs/milestones/m8-local-markdown-sync-demo.md`, merged in #110 (`2c96711`).

## Constraints and review focus

- Three explicit ASCII Markdown paths maximum; 16 KiB UTF-8 per note; independent
  configured participant origins and read/write grants. No delete or generic resume.
- Replaying an identical `mutate` request resumes its exact journal. An arbitrary
  operation-ID resume would lack an ownership check in the current port; do not
  expose it. Changed bytes/parent/origin keep the store's operation-reuse refusal.
- Only authenticated admitted mutation may create the fresh lab vault marker;
  reads never provision a namespace. Missing/mismatched marker is not empty success.
- Request bytes are bounded even without/with false Content-Length; malformed UTF-8,
  unknown fields, caller-supplied vault/origin, oversize content and foreign paths
  fail closed. Errors omit exceptions/content. Responses are no-store.
- Release entrypoints/config remain unchanged. Experimental listener is loopback
  and local R2 only; explicit arming is mandatory. CORS permits only the official
  Obsidian app origin. No OAuth, MCP, inventory CPU override or new dependency.
- Review risks: arbitrary resume escalation; byte-vs-character limits; marker
  creation on unauthorized requests; forged host/config; premature committed ACK.

## Files and work units

Production forecast: 8 TypeScript files plus 2 executable configurations, roughly
700–1,100 lines; no repository production-size exception. Tests/docs accompany the
functional delivery. If the forecast grows, split by a functioning semantic boundary
before implementing the excess, not into test-only preparation PRs.

### Task 1 — Admitted application service and wire contract

Files: create `packages/core/src/sync/sync-demo-service.ts`, export from core index;
create `packages/protocol/src/sync-demo.constants.ts` and `sync-demo.schemas.ts`,
export from protocol index. Tests: `packages/protocol/tests/unit/sync-demo.test.ts`.

Interfaces: `SyncDemoService` exposes `readCurrent`, `readVersion`, `mutate`,
`readChanges` using existing core input/result types; constructor binds vault,
paths, byte limit and a narrow optional-mutation namespace-preparation capability.
Protocol request is a strict discriminated union of current/version/mutate/changes;
mutation accepts only create/update, never vault/origin/digest from the caller.
Responses validate the actual core live/version/feed/mutation/failure unions.

- [x] Write schema and service tests; execute `mise run test -- sync-demo` RED.
- [x] Implement path/vault/content policy and exact typed contracts without R2/HTTP
  in core; GREEN focused tests. Reads use current/version evidence, never bodies in feed.

### Task 2 — Isolated authenticated Hono adapter and local entrypoint

Files: create `apps/worker/src/demo/demo-configuration.ts`, `demo-app.ts`, `index.ts`,
`apps/worker/wrangler.demo.jsonc`; modify `.mise.toml` for explicit demo dev/build tasks.
Tests: `apps/worker/tests/integration/sync-demo-api.test.ts` and native runtime test
using the bundled actual demo entrypoint with Miniflare.

Interfaces: `createSyncDemoApp` binds strict configuration/registry, service factory
and digest provider. Request permission comes from the operation discriminator;
mutation origin comes exclusively from the authenticated participant mapping.
`index.ts` composes existing R2 store with real server time; marker create-only
read-back uses the existing one-key primitive before admitted first mutation.

- [x] Write unauthorized/foreign origin/path/body/loopback/release-isolation tests;
  run focused test RED before implementing adapter.
- [x] Implement fail-closed admission, bounded parser, one request/one operation,
  no-store responses, generated OpenAPI and local Scalar; GREEN focused tests.
- [x] Native actual-entrypoint scenario: first create, same-request resumptions,
  exact version read, clean REST update, stale update refusal and committed feed;
  preserve a legacy sentinel. Clock injection is test-only and evidence labeled.
- [x] Document local configuration/commands, update M8 delivery evidence (not COMPLETE).
- [x] `mise install`, `mise run check`, local demo dry-run build; manual semantic
  review of permissions, original CAS, payload validation, namespace and release
  isolation.
- [ ] Commit/push functional PR; leave merge to owner. No deployment.

## Execution ledger

- Spec merge verified: #110, `2c96711cb3d9c466a3b6633ba8751dba49a84454`.
- Baseline checks passed at specification head; repeat on functional diff.
- Ruling: resume through identical full mutation replay rather than expose bare
  `resumeOperation` — the existing port has no journal-owner query; costs a body
  resend and retains attention when original bytes are no longer reconstructible.
- Application/protocol and isolated HTTP/entrypoint implemented within the forecast;
  focused fast suite passes 19 tests, typecheck and semantic lint/TSDoc pass.
- Original native run `b3a1201d9` failed only at the missing-marker expectation:
  existing `readCurrent` maps marker unavailability to `storage_unavailable`, not
  `vault_not_found`. Corrected the test, preserving store behavior; reads still do
  not create markers. The corrected native scenario awaits canonical evidence.
- Additional RED/GREEN case rejects lone Unicode surrogates before UTF-8 encoding
  can replace them. Named loopback/CORS policy and isolated persisted lab state are
  confined to existing forecast files; no release entrypoint was modified.
- Canonical check `be7b8b351` ran 2,099 fast tests successfully but failed the
  unchanged 95% statements threshold at 94.97%. Added meaningful immutable/feed
  permission and marker-outage/uncertain-readback/throttle scenarios. Exact lost
  PUT acknowledgement alone is correctly settled by verified readback; uncertainty
  injection also denies that proof, and the original cooldown is retained.
- Focused native run `bddf0f4ed` passed (one actual-entrypoint workerd/local-R2
  REST integration scenario, 1.21 s): create/replay/version/update/stale refusal/feed
  and legacy sentinel preservation. This is not desktop or Workers Free evidence.
- Canonical `ba608e46b` passed: 2,103 fast tests, 53 native tests, 12 plugin artifact
  tests; statements 95.01%, branches 91.47%, functions 98.62%, lines 96.83%.
- Post-green semantic review found missing JSON bodies in OpenAPI's non-400
  transport failures. A RED/GREEN assertion now covers 400/401/403/413/503 schemas.
  Reused the canonical Markdown media type, named negotiated limits and explicitly
  disabled preview URLs without changing the 10-production-file scope.
- A further scope review found valid M7 read results could exceed M8's smaller
  byte cap. RED/GREEN now rejects oversized verified current/version results,
  without changing store semantics or treating refusal as empty success.
- Check `b479a557f` passed before the read-policy correction. Corrected-production
  check `bca2649c1` passed: 2,104 fast tests, 53 native tests, 12 plugin artifact
  tests; statements 95.01%, branches 91.48%, functions 98.62%, lines 96.83%.
- Subsequent test-only cleanup replaces cross-package private aliases with public
  protocol exports; focused 19 tests/typecheck passed. Final full check `b74ab6c01`
  passed on the final source: 2,104 fast, 53 native and 12 plugin artifact tests,
  with unchanged thresholds and the same four coverage percentages above.
  Post-green semantic closure: APPROVE for this bounded self-review, no outstanding
  actionable finding; owner PR review/merge is separate. Documentation link validation
  checked 214 local targets with no missing files; whitespace is clean.
- Operational guide and architecture/current-state/API references are drafted;
  final evidence and post-check semantic closure are recorded. Commit and functional
  PR are the remaining delivery actions.

## Semantic review record

Target: the intentional working-tree delivery against #110's merged `2c96711`;
no hosted CI claim or unrelated baseline audit. Accepted boundary: M8 delivery 1,
ADR 0021, G1–G6 still open. No new dependency or deprecated API.

- `demo-app.ts`: cohesive transport admission/documentation. Arming + loopback,
  registry + participant, bounded strict wire input and independent permission
  precede service resolution. The exhaustive four-operation dispatch binds origin
  and digest server-side. HTTP failure semantics are separate from unchanged store
  certainty; only a committed domain result acknowledges a mutation. Body parsing
  owns transport syntax, never marker or parent policy. Tests cover the admission
  matrix and sanitizer; OpenAPI failure-body finding is fixed, not deferred.
  Oversized-read finding is fixed in application scope policy, with no raw bytes
  exposed outside admission; the store remains the authority for verification.
- `demo/index.ts`: cohesive local composition/marker authority. Reads never prepare;
  admitted writes alone enter absent/exact/divergent/unavailable marker states.
  Conditional one-key evidence owns confirmation, throttle and uncertainty; the
  root preserves its floor and never retries, repairs, refreshes a parent or resumes
  another operation by ID. Deterministic fault tests cover unavailable read and
  denied readback after lost write acknowledgement; native tests use the real root.
- `SyncDemoService`: cohesive configured scope policy over the existing port. Path,
  vault and byte admission precede marker preparation; current/immutable reads also
  enforce the smaller M8 byte scope after verified store evidence; immutable/feed scope checks
  withhold foreign content/checkpoints. Store owns publication, CAS, leases,
  operation identity, feed closure and settlement; no competing transition owner
  or R2/HTTP/host concern is added to core. Full original-request replay preserves
  the origin ownership check and effect certainty.
- Protocol schemas/constants own the closed wire states and semantic limits;
  existing identifier/path/cursor/digest codecs are reused, not reimplemented or
  widened. Useful TSDoc covers introduced helpers, types, schemas and semantic
  values. Private construction contracts remain colocated with their adapters.
- Release Worker, plugin, v2/MCP registration and deployment configuration are
  unchanged; demo output/state are isolated, all validation is offline/local or
  dry-run. No real-host/mobile, CPU/Free, production data or deployment evidence is
  inferred. The native clock is injected solely by its disposable test wrapper.

No remaining actionable semantic finding identified in this bounded self-review;
the corrected-source check passed and owner PR review/merge remains separate.
