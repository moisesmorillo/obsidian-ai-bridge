# Verified current state

This snapshot records completed M1–M6 implementation and qualification evidence on the M6 completion branch. M5's bounded support claim is limited to latest M5-ready release v1.0.2 and one designated writer on Obsidian Desktop 1.13.7 / macOS 26.6.2 / Apple M4 Pro, with synthetic active-writer behavior through 10,000 eligible notes. The final report records retained scale, credential-rotation, and Keep-local results; v4→v5 migration/restart evidence; live loopback recovery/diagnostics; exact release identity; residual platform/deployment limits; and one explicitly unqualified pause/resume conflict attempt. No personal vault or production Worker/R2 deployment was used. M1–M6 are COMPLETE in this transition; no milestone is marked NEXT, and no M7 is inferred. The roadmap transition becomes canonical when its completion PR merges.
M2 source/tooling through `2e74b23` passed independent semantic
review and merged at `b300726` (PR #7). M3's completion PR #27 passed canonical
validation and final semantic review; its three MINOR findings were corrected at
`e97af36`, whose corrective review returned APPROVE with no open findings. PR #27
merged at `63b0599`; M3 is COMPLETE and the M3→M4 transition is canonical.
M4, M5, and M6 are COMPLETE in this transition; no milestone is marked NEXT. The completed
[specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[sequential plan](plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
and ADRs 0005–0009 define the reviewed boundary. The compatibility transition uses
strict device state v5 and runtime-owner version 5, frozen v2/v3/v4 decoders, same-key
exact read-back migration, content-free reviewed admission/effects, bounded parent-
owned history steps, step-scoped archives, and orthogonal observation-gap coverage. One owner-scoped scheduler serves M3 and
M4. Synthetic local-effect identity/postconditions and conservative successor event
ranges survive restart. Startup stales orphan reviews; sessions invalidate transient
bodies; bounded recovery selection, two review commands, literal-text modals, and
sanitized M4 status are composed. Worker/API behavior is unchanged. Slice 8 adds the
packaged M4/stale/restore/replacement/leakage qualification and synchronized operations,
security, diagnostics, coverage, links, and semantic-review evidence.
M3 completed [Slice 0 platform qualification](qualification/m3-slice-0-platform-primitives.md),
Slice 1's modern plugin baseline/shared typed contracts, Worker Slice 2A–2C's
private storage/application transitions plus public safe v2 HTTP/OpenAPI/CORS, and
Slice 3's device-local state/configuration owner and staged handoff model, Slice
4's typed bounded Fetch `RemoteBridge` adapter, Slice 5's core-only bootstrap,
coalescing, scheduling, and finite retry/evidence engine, Slice 6's core runtime
deletion/recreation/rename orchestration, and Slice 7's official host/runtime/settings
composition. Slice 8 adds proportional generated-artifact qualification, synchronized
operational/security documentation, and the [operator runbook](operations.md). The
connected outward mirror has a narrow v1.0.2 M5 software-support claim, but remains
undeployed and is not security-certified. Its
[accepted design decisions](plans/m3-design-decisions.md) and
[sequential plan](plans/m3-remote-bridge-client-and-publishing.md) record the completed
implementation and retained limits. The approved product is an automatic whole eligible
Markdown mirror with recoverable runtime deletion/rename, per-path state and one
designated writer—not selected/manual publishing. M3 Slice 1 set the plugin manifest baseline to Obsidian 1.13.0; Slice 7 now uses
native SecretStorage references and modern declarative settings without persisting
bearer values in plugin data.
M1's historical foundation was audited at `22d3ee0` (PR #4); current Worker behavior
decodes legacy/format-2 objects through v2 and has fully retired the v1 HTTP surface.
This is not a claim about a deployed environment or installed Obsidian host.
[Roadmap](roadmap.md) owns milestone status; [architecture](architecture.md) owns
boundaries; [API](api.md) describes the Worker HTTP and MCP contracts.

## Implemented capabilities and evidence

| Area | Verified behavior | Primary evidence |
| --- | --- | --- |
| Worker | Typed Hono/OpenAPI app assembled once per isolate; request middleware resolves the shared bearer principal. HTTP and MCP handlers call application services, not repositories; the MCP endpoint is stateless and has its own exact capability-permission table. | `apps/worker/src/{index,app,app.types}.ts`, `src/http/`, `src/mcp/` |
| M3 Worker | Private tagged live/tombstone/recovery codecs; create-only and exact-observed-generation R2 CAS; core current/recovery policy with existing-generation association continuity; authenticated v2 mirror/current/recovery routes; strict IDs/conditions/media/stream bounds; application ETags; separate recovery metadata/content; method-specific CORS; complete v1 HTTP retirement. | `packages/core/src/mirror/`, `apps/worker/src/{composition,http,infrastructure}/`, focused storage/service/HTTP/composed tests |
| Routes | Public health/OpenAPI/Scalar and authenticated v2 plus stateless `POST /mcp`. The HTTP route policy owns public/v2/preflight/unknown API operations; a separate exhaustive MCP table owns discovery/read/write/delete capability permissions. Every `/api` descendant and MCP request is registry-protected; registered v2 OPTIONS is public and storage-free; v1 is unregistered. MCP discovery is authenticated without resolving mirror services. | `apps/worker/src/app.ts`, `src/http/{v2-route-policy,v2.handlers,v2-cors.middleware,openapi.routes}.ts`, `src/mcp/` |
| Authentication | Strict version-1 registry of at most 16 named digest-only clients; canonical lowercase UUID-v4 IDs, ADR name grammar, nonempty exact permission sets, unique IDs/case-folded names/digests, and unknown-field/version rejection are validated atomically. Tokens use 32 secure-random bytes and canonical unpadded base64url; verifiers use domain-separated SHA-256 and canonical lowercase hex. Every configured digest is compared without an early successful exit. Success publishes only a typed `{clientId, name, permissions}` principal; missing/malformed/wrong/invalid configuration yields sanitized 401. Registry authentication is the sole mode; singleton authority is removed. Exact independent HTTP/MCP permissions are enforced before service/storage dispatch; insufficient permission yields sanitized refusal. MCP reuses the bearer as an application-level overlay, not OAuth/Protected Resource Metadata or audience-bound token validation. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts`, `src/mcp/`, focused auth/registry/integration tests |
| Credential lifecycle | Offline mise tooling creates/provisions fresh credentials, performs bounded overlap rotation, revokes exact client IDs, replaces lost credentials without recovery, and builds all-new registries after total loss. It validates complete updates through the same registry owner, accepts no raw-token argument, requires interactive one-time secret display, writes owner-only registry files outside the repository, and makes no HTTP/deployment call. | `tools/credentials/`, `tools/tests/unit/credential-lifecycle.test.ts`, [operator procedure](operations.md#credential-registry-lifecycle-and-singleton-migration) |
| MCP adapter | Official stateless Streamable HTTP server at `POST /mcp`, protocol revision `2026-07-28`, legacy initialize-era traffic rejected, no sessions/GET/DELETE/HTTP+SSE, exact same-origin checks for present Origin, strict bounded request/response streams, and `no-store`. Static discovery exposes eight narrow tools and note/recovery content resource templates; every operation reuses existing `CurrentGenerationService` or `RecoveryService`, and authorization precedes service resolution. Typed static tool-error codes preserve unknown mutation certainty and tombstone stages. Client-owned confirmation is signaled by instructions/annotations, not asserted as server proof. MCP OAuth/PRM conformance is explicitly not claimed. | `apps/worker/src/mcp/`, official MCP Client and raw Worker integration/security tests, [M6 specification](milestones/m6-mcp-adapter.md), [qualification report](qualification/m6-final.md) |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. V2 listing exposes bounded 50-object pages with opaque cursors and filters unsafe/non-Markdown/oversized untagged legacy/out-of-namespace keys; tagged malformed or oversized objects fail sanitized. V1 route retirement performs no storage migration. MCP has no direct R2 dependency. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | `read` gates mirror/current/recovery reads, `write` gates create/update/recreate and seal, and independent `delete` gates tombstone/purge. Legacy/live v2 reads return decoded text; tombstones are hidden. Mutation and recovery maintenance continue through application policy plus conditional R2 PUT only. Persisted malformed/oversized objects fail sanitized. V1 routes are absent. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. HTTP and MCP bound actual streamed bytes independently of declared length; MCP also bounds chunk count and response size. Core conditional writes and MCP schemas both enforce the 1 MiB UTF-8 limit and reject malformed Unicode without normalizing valid content, including a leading U+FEFF. V2 PUT requires an explicit supported media type; MCP requires JSON. | `packages/core/src/vault/`, `packages/core/src/mirror/current-generation-service.ts`, `apps/worker/src/http/note-body.ts`, `apps/worker/src/mcp/` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar reference. It documents only actual v2 security/permissions, 401/403, IDs/conditions, optional empty PUT body with required explicit media type, pagination/state/recovery routes and statuses. | `apps/worker/src/http/openapi.routes.ts`, semantic HTTP integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. Authenticated JSON/content/error responses use `Cache-Control: no-store`; registered v2 route/method responses and errors add narrow CORS. Revisioned generations expose strong application ETags, never R2 validators. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `v2.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed requests include operation, method, registered route template, closed operation category, authentication outcome/client ID when authenticated, status/error, and duration. MCP uses only the static `/mcp` route and a closed request category; tool names/arguments, RPC IDs, resource identifiers, credentials, content, and application/storage details are excluded. Platform-managed diagnostics retain zero application days and are not an audit trail. | `apps/worker/src/logging/`, `apps/worker/src/mcp/`, focused logging and Worker integration tests |
| Plugin | `AiBridgePlugin` preserves the two M2 inspection commands and composes M3 through one enable-lifetime session attached to a versioned same-App-realm facade. Focused host owners govern listener epochs, configuration/connection admission, reconciliation progress and staged-handoff verification. Official saved Vault events register only after layout readiness. A bounded startup event buffer is durably drained before normal scheduling/UI and persisted-operation resume; before that drain, the bootstrap scheduler runs only current-scan positive paths without unresolved M3 intent or M4 reservations. Every fresh listener epoch fences active M4 operations; dispatch-time listener/configuration lease checks and complete-group gap reviews prevent silence-based settlement or reservation release. Positive scans remain absence-neutral and never grant delete authority. Positive admission refreshes the one-shot scheduler before reporting inventory settles. Staged handoff events advance durable generations and invalidate sampled metadata before atomic align/activate. Modern declarative settings persist only endpoint/loopback consent/native secret reference, display non-secret device/server designation, and require whole-scope/plaintext/deletion trust consent; dispatch retrieves the bearer from SecretStorage. Missing/failing Web Crypto fences mutation and wake scheduling while retaining dirty state for explicit recovery. Sanitized status and check/retry/pause/resume/handoff controls expose no body, token or raw transport error. The corrective ADR 0013 transition strictly loads v5 or migrates validated v2→v3→v4→v5 through one same-key save plus exact read-back before owner publication; frozen v2/v3/v4 codecs remain separate, and runtime registry/owner version 5 refuses older reuse. Reviewed M4 commands, text-only modals, session invalidation, startup orphan staling, shared scheduling, event-first successor fencing, recovery selection and sanitized status are composed. Before publication, a read-only startup transition resolves migrated v3 local effects from durable expected postconditions without redispatch: exact bytes resume as `recovered-v3`, absent/changed bytes stay blocked, ambiguous evidence remains retryable, and failed persistence aborts startup. Incompatible registries fail closed. Local create/replace is reachable only through reviewed operations and exact evidence; there is no editor event, local delete/move/rename, capability fallback, or production deployment. The exact 10,000-note desktop envelope is documented in the [M5 qualification report](qualification/m5-final.md); broader desktop, mobile, iCloud, background-iOS, and deployed Worker/R2 behavior remains unqualified. Manifest remains `ai-bridge`, minimum `1.13.0`, non-desktop-only. | `apps/obsidian-plugin/src/{main.ts,commands/,configuration/,events/,runtime/,status/,remote/,state/}`, dedicated plugin unit/integration/artifact suites and [M5 qualification](qualification/m5-final.md) |
| Local safety | Shared literal `.md` path and 1 MiB policy; dot-prefixed/configuration-directory exclusions plus exact current `ai-bridge-conflicts` and historical `.ai-bridge-conflicts` namespace exclusions; pre-read metadata and post-read UTF-8 bound; exact lookup and pre/post object/path/mtime/size checks. M4's separate reviewed-write adapter supports only official lookup/create/createFolder/read/process operations, fixed generated conflict paths, create-only collision rules, atomic exact-text replacement, and post-effect identity/hash verification. New effects use only the host-visible root; legacy receipts retain exact historical identity and unknown effects are not repaired or redispatched. It is composed only behind admitted reviewed operations. No delete/rename/move, raw filesystem, path repair/URI decoding, Markdown-rendered content UI, or cross-system atomicity claim. | `packages/core/src/local-vault/`, `apps/obsidian-plugin/src/infrastructure/`, focused adapter tests |
| Plugin artifact | Browser-target CommonJS exposes `module.exports.default`, keeps only `obsidian` external, and stages the source manifest. Generated-artifact tests retain M2/M3 packaging/runtime checks, model physical dot-folder creation without Vault-index visibility, and cover literal hostile-text preview, reviewed Keep-local, stale-evidence refusal, local-only pending restore, compatible M4 owner retention, incompatible-registry refusal, and credential/body/Node/raw-filesystem/private-key/machine-path leakage negatives. M5 additionally qualifies the source-built v1.0.2 artifact identity/reproducibility and the exact disposable desktop active-writer/migration envelope; see [final evidence](qualification/m5-final.md). No release binary assets, production deployment, personal vault, mobile host, or broad platform claim is implied. | `.mise.toml`, `apps/obsidian-plugin/tests/artifact/main.test.ts`, [qualification and operating evidence](plugin-development.md), [M5 report](qualification/m5-final.md) |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. M3 adds platform-independent UUID-v4 IDs, ETags, digests, closed current/recovery/intent/effect contracts, generation-bound conditional ports, current-generation/recovery orchestration, Slice 3's closed device/per-path ledger and serialized state owner, and Slice 4's `RemoteBridge`. Slice 5 adds `MirrorSynchronizer`, a fair two-slot/one-path scheduler, bounded reporting inventory, positive observation generations, 750 ms/5 s coalescing, exact-ACK/evidence reconciliation and durable three-attempt/three-evidence budgets. Slice 6 adds durable event-only delete authority, five-second grace/exact absence, recovery-first tombstone execution through the same finite intent/evidence machinery, exact tombstone recreation, destination-first two-path rename with durable/deferred cleanup prerequisites, lexical reservations, and bounded pre-event folder-descendant expansion. M4 uses closed authority/classification/action/review/operation/evidence/preservation contracts, bounded sparse state-v5 collections with observation coverage and gap-group review links, and linear cross-field validation. Its corrected immutable review snapshot captures runtime/configuration/listener identity, per-path local/ACK/remote/M3 evidence, exact remote receipts and recovery metadata. Preservation receipts are checked against evidence-derived side/revision/hash requirements, and `restored-pending-review` reservations durably fence ordinary M3 scheduling until a linked reviewed successor takes ownership. Focused lifecycle planner, deletion executor, rename executor and durable transition owner keep policy out of the facade. Positive work starts fail-closed until a current handshake and one indexed durable bootstrap batch succeed; local/capacity/stale/persistence failures remain inactive. Reporting inventory may remain pending in one shared slot while positive work settles in the other. Lifecycle, global and persistence fences suppress mutation admission and wake deadlines while preserving unresolved evidence. M4 Slice 3 keeps `ReadOnlyLocalVault` unchanged and adds a separate three-command `LocalReconciliationWriter`; focused services authorize exact operation/action/path/phase/reservation/evidence, persist prepared effects or pending preservation receipts before dispatch, post-verify evidence, retain unknown certainty, and allow only exact same-operation recovery. Slices 4–5 compose those primitives inside core for archive-first live resolution, exact adoption and legacy fork, explicit tombstone resolution, and local-first recovery restore. A shared effect executor performs exact barriers, conditional remote settlement, receipt recovery and atomic baseline completion; restored paths remain fenced until a fresh reviewed successor atomically takes ownership. Core still imports no Obsidian, Fetch/HTTP, Hono, Cloudflare, filesystem or protocol dependency. | `packages/core/src/`, package exports |
| Protocol | Strict Zod schemas and inferred DTOs for health, errors, historical v1 response decoding types, and bounded M3 identity, NotePath, precondition, receipt, current-state, recovery, intent, capability/result and pagination contracts. Stable public HTTP methods/statuses and v2 route roots, child segments, query/header names and media types are also owned here and consumed by Worker/OpenAPI/plugin adapters; adapter-private route syntax, response classification and CORS policy remain outside. The reserved version `0.1` envelope remains unused rather than being silently repurposed. | `packages/protocol/src/` |

## Tooling and validation baseline

- `.mise.toml` pins Bun **1.4.2** and Node.js **24.21.0**. Bun owns the workspace
  dependency graph and `bun.lock`; `mise run install` installs it frozen.
- Tasks: `install`, `format`, `biome:check`, `lint`, `typecheck`, `test`, `coverage`,
  `worker:storage-test`, `build`, `worker:build`, `plugin:build`, `plugin:smoke`,
  `dev`, `credentials`, `check`. `credentials` runs bounded offline create/rotate/revoke/loss/replacement tooling and makes no remote call. Use `mise run <task>`.
  `mise install` installs tools, not workspace dependencies. Dev-only
  `@types/node` 24.13.4 supports artifact tests; it adds no plugin runtime module.
- `check` depends on Biome check (formatting, recommended lint and organize-import
  assists), type-aware Oxlint with denied warnings, TypeScript, coverage and both
  builds including artifact smoke. It runs source tests through coverage rather
  than twice. `typecheck` checks the root suite, the production plugin separately
  with only Obsidian ambient types, and the dedicated artifact test tsconfig.
- TypeScript is strict with unchecked-index and exact-optional checks. Shared
  `@core/*`, `@protocol/*`, `@worker/*`, `@obsidian-plugin/*` aliases cover internal
  imports; cross-package consumers use public `@obsidian-ai-bridge/*` exports.
- Oxlint plus `oxlint-tsgolint` enforce deprecated API detection, explicit-`any`
  prohibition, direct-console prohibition and configured documentation rules.
  These checks do **not** prove all architecture/TSDoc requirements in
  [AGENTS.md](../AGENTS.md); manual semantic review remains mandatory.
- Vitest **5**: **83 source test files / 1,402 tests**, plus **1 generated-artifact
  smoke file / 12 tests** and **1 Worker storage-test file / 8 tests**. The unchanged
  M1 baseline had 15 files / 105 tests. M5 adds focused registry, authentication,
  lifecycle, migration, leakage, and CLI-boundary tests; M6 adds official MCP client,
  raw transport, permission, resource, conditional-mutation, recovery, certainty, and
  leakage coverage. Earlier milestone validation is recorded in the relevant
  qualification reports and plans.
- Worker unit tests live under `apps/worker/tests/unit/` (auth, HTTP, R2 adapter,
  logging). `apps/worker/tests/integration/worker.test.ts` composes Hono, the real
  core service and an in-memory repository. Core and protocol tests live under
  their own `tests/unit/`. Plugin unit tests isolate host/UI behavior; its focused
  integration suite composes commands, core service and official adapter over
  in-memory files. Slice 0 additionally runs 8 tests through an ephemeral local
  Miniflare/workerd R2 binding and compiles official host declaration assertions.
  Automated tests do not exercise deployed Cloudflare or an installed Obsidian host;
  the separate bounded M5 disposable-host evidence is in the [qualification report](qualification/m5-final.md).
  These unit/integration suites are not E2E tests.
- V8 provider `@vitest/coverage-v8` **5.0.0**, run under Node through `coverage`.
  Root `vitest.config.ts` includes `apps/*/src/**/*.ts`, `packages/*/src/**/*.ts`, and
  `tools/tsdoc/**/*.ts`, including unimported source; excludes `.d.ts`, `*.types.ts`,
  build/output and Wrangler state. Reports: text, JSON summary, LCOV.
  Global thresholds: **lines 95%, statements 95%, functions 94%, branches 90%**.
  Coverage is a regression signal, not proof of test quality.
- Root Vitest projects include shared packages, Worker, plugin, and tooling. The M6
  completion check reports source coverage of statements **95.01% (8,836/9,300)**,
  branches **90.71% (7,087/7,812)**, functions **98.33% (1,947/1,980)**, and lines
  **96.96% (8,414/8,677)**; thresholds and production inclusion remain enforced. The
  historical M5 report retains its earlier measured baseline. Artifact tests are
  separate from source coverage, run after packaging and never replace behavioral
  coverage.
- The Worker declares Miniflare **5.20260908.0-alpha** directly for its storage
  qualification task, exactly matching Wrangler **4.130.0** and workerd
  **1.20260908.1**. The task runs under Node and is part of `check`; it uses no
  persistent emulator storage, account, bucket or token.
- Worker build uses Node + Wrangler **4.130.0** `deploy --dry-run`; plugin build
  uses Bun browser-target CommonJS with `obsidian` external, stages the manifest
  and runs `plugin:smoke`. `build` does not deploy. `dev` runs the local
  Worker through Node because of the documented Bun/workerd proxy limitation.
- `.github/workflows/ci.yml`: pushes to `main` and pull requests run the
  **Quality checks** job on Ubuntu, installing tools with mise, then
  `mise run install` and `mise run check`. Actions are checkout v7, mise-action v4,
  cache v6. There is no deployment job.
- `.vscode/settings.json` connects the plugin manifest to the committed JSON
  schema. Check editor diagnostics as well as CLI results.

## Explicit limitations and deferred work

The Worker API is a remote storage boundary, **not synchronization**. Named principals
are independently revocable, and one exhaustive operation policy enforces exact
`read`/`write`/`delete` permissions before service/storage dispatch; unsafe v1
mutations and every v1 route are retired. Slice 3 models device-local
configuration/state, activation, and staged handoff. M3 composes bootstrap,
positive-event coalescing, path scheduling, finite retry/evidence policy and runtime
deletion/recreation/rename through official host callbacks, settings, timers and
same-realm ownership. M4 exposes only explicit reviewed local create/replace actions.
M4's strict state-v5 migration/gap authority, preservation/local-write seams,
live/adoption/tombstone/restore/history execution, and plugin runtime/UI composition are
complete. M5 is COMPLETE: runbooks, current release identity,
retained scale/rotation/Keep-local evidence, current v5 migration/restart results, and
final A1–A12 qualification are recorded in the [M5 report](qualification/m5-final.md). M6 is COMPLETE in this transition with its own [final qualification report](qualification/m6-final.md).
The only software-support claim is latest release v1.0.2 on Obsidian Desktop 1.13.7 /
macOS 26.6.2 / Apple M4 Pro through 10,000 eligible notes. This does not imply security
certification, production deployment, complete backup, broad desktop/mobile/iCloud
qualification, or a personal-vault test. The accepted M4 design remains reviewed-only:
exact format-2 revisions may be adopted, competing bytes are preserved before
replacement, remote tombstones require explicit choices without plugin local
delete/move, recovery restore is local-only first, legacy same-path adoption remains
prohibited, the existing v2 API suffices, and one designated writer remains.

MCP is limited to the documented authorized Worker tools and explicit note/recovery resources; it adds no search, inference, attachment mirroring, reconciliation, or remote-to-local plugin client. No D1, Durable Objects, queues, Vectorize, Workers AI or external database is part of the product architecture. Generated local emulator artifacts are not evidence that such services were selected.

R2 contains note text, not application-encrypted ciphertext. The Worker/cloud
operator is within the trust boundary. Configuration names a development bucket;
it does not prove that bucket, a deployment, credentials or a vault installation
exists. Local secret configuration is ignored and must not become project memory.

Generated OpenAPI 3.1 now documents the runtime's canonical identifier and ETag
patterns, closed note formats, exact status/media/header/security surface, required
PUT Content-Type, and the exactly-one precondition rule to the extent OpenAPI header
parameters can express that dependency. Semantic document tests guard this
surface. M3's accepted design includes
safe v2 mutations, paginated reads, 30-day deletion recovery, tombstone/purge markers,
native secret references and explicit writer handoff. The Worker storage/application/transport surface, typed Fetch client and core
reconciliation machinery drive the connected outward plugin runtime, whose narrow M5
software-support envelope is recorded in the [operator guide](operations.md). It covers
setup, one-writer availability, upgrade/handoff/reset, bearer rotation, recovery API
use, iCloud uncertainty, and rollback prohibitions. M5's completed qualification is
not a production deployment or security certification. ADR 0011 deliberately selects
no application quota/limiter, recovery automation, durable logs, mobile writer, or
multi-release support; prerequisites to safe M3/M4 behavior must not be postponed.

## History that still matters

- PR #1 established M1 and canonical base64url addressing to avoid URL path
  normalization bypasses. Older raw-path assumptions must not return.
- PR #3 established the current service/handler separation, LogTape integration,
  semantic checks and Wrangler secret/environment setup.
- PR #4 established dedicated test trees, V8 thresholds and exhaustive typed
  result handling. Its merged code supersedes earlier `src` test layout, direct
  Bun task instructions and the original 40-test count.

History explains the baseline; it does not override current source or authorize
future features. See [decisions](decisions/README.md) for durable decision records.
