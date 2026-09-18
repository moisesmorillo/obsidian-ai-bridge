# Verified current state

This snapshot records the completed M1 foundation, M2 local-inspection adapter, and
M3 Slices 0–8. M2 source/tooling through `2e74b23` passed independent semantic
review and merged at `b300726` (PR #7). M3's completion PR #27 passed canonical
validation and final semantic review; its three MINOR findings were corrected at
`e97af36`, whose corrective review returned APPROVE with no open findings. PR #27
merged at `63b0599`; M3 is COMPLETE and the M3→M4 transition is canonical.
M4 is the single NEXT milestone. Its [implementation-ready specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[sequential plan](plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
and ADRs 0005–0008 resolve the design. Slice 1 now implements closed content-free M4
contracts, sparse device-state v3, strict semantic validation, frozen v2 decoding,
deterministic same-key migration/read-back, downgrade fencing, and runtime registry
version 3. Slice 2 now adds a core-only bounded read-only review/classification and
admission engine with ephemeral snapshots, stale observation fencing, and content-free
serialized operation admission. It adds no UI, local or remote mutation, conflict
handling, restore, history execution, timer, Fetch, or Worker/API behavior.
M3 completed [Slice 0 platform qualification](qualification/m3-slice-0-platform-primitives.md),
Slice 1's modern plugin baseline/shared typed contracts, Worker Slice 2A–2C's
private storage/application transitions plus public safe v2 HTTP/OpenAPI/CORS, and
Slice 3's device-local state/configuration owner and staged handoff model, Slice
4's typed bounded Fetch `RemoteBridge` adapter, Slice 5's core-only bootstrap,
coalescing, scheduling, and finite retry/evidence engine, Slice 6's core runtime
deletion/recreation/rename orchestration, and Slice 7's official host/runtime/settings
composition. Slice 8 adds proportional generated-artifact qualification, synchronized
operational/security documentation, and the [operator runbook](operations.md). The
connected outward mirror remains experimental and undeployed. Its
[accepted design decisions](plans/m3-design-decisions.md) and
[sequential plan](plans/m3-remote-bridge-client-and-publishing.md) record the completed
implementation and retained limits. The approved product is an automatic whole eligible
Markdown mirror with recoverable runtime deletion/rename, per-path state and one
designated writer—not selected/manual publishing. M3 Slice 1 set the plugin manifest baseline to Obsidian 1.13.0; Slice 7 now uses
native SecretStorage references and modern declarative settings without persisting
bearer values in plugin data.
M1's historical foundation was audited at `22d3ee0` (PR #4); current Worker
compatibility behavior additionally decodes format-2 reads and retires v1 mutations.
This is not a claim about a deployed environment or installed Obsidian host.
[Roadmap](roadmap.md) owns milestone status; [architecture](architecture.md) owns
boundaries; [API](api.md) describes the HTTP contract.

## Implemented capabilities and evidence

| Area | Verified behavior | Primary evidence |
| --- | --- | --- |
| Worker | Typed Hono/OpenAPI app assembled once per isolate; request middleware resolves the note service and bearer secret from bindings. Handlers call application services, not repositories. | `apps/worker/src/{index,app,app.types}.ts`, `src/http/` |
| M3 Worker | Private tagged live/tombstone/recovery codecs; create-only and exact-observed-generation R2 CAS; core current/recovery policy with existing-generation association continuity; authenticated public v2 mirror/current/recovery routes; strict IDs/conditions/media/stream bounds; application ETags; separate recovery metadata/content; method-specific CORS; envelope-aware v1 reads and 410 v1 mutation retirement. | `packages/core/src/mirror/`, `apps/worker/src/{composition,http,infrastructure}/`, focused storage/service/HTTP/composed tests |
| Routes | Public health/OpenAPI/Scalar; authenticated envelope-aware v1 GET/list plus retired PUT/DELETE; authenticated paginated v2 mirror/current/state/recovery metadata/content and POST maintenance routes. One named policy owns v2 paths and operation methods for Hono registration, CORS and OpenAPI. Both API prefixes and unknown descendants are protected; registered v2 OPTIONS is storage-free. | `apps/worker/src/app.ts`, `src/http/{v2-route-policy,v2.handlers,v2-cors.middleware,openapi.routes}.ts` |
| Authentication | One `OBSIDIAN_BRIDGE_TOKEN`; missing/empty configuration fails closed. Bearer scheme is case-insensitive; malformed, missing, unsupported or wrong credentials yield sanitized 401 with `WWW-Authenticate: Bearer`. Comparison hashes both tokens with SHA-256 and compares fixed-length digests without early exit. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts` |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. V2 listing exposes bounded 50-object pages with opaque cursors; retained v1 aggregates at most 1,000 such pages. Both filter unsafe/non-Markdown/oversized untagged legacy/out-of-namespace keys; tagged malformed or oversized objects fail sanitized. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | Legacy/live reads return decoded text; tombstones are hidden. V2 create/update/recreate/tombstone and recovery maintenance use application service policy plus conditional R2 PUT only. Persisted malformed/oversized objects fail sanitized. V1 PUT/DELETE return 410 without mutation. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. Worker bounds actual streamed bytes independently of the declared length, rejects invalid UTF-8, accepts empty content, and accepts Markdown/plain-text media types case-insensitively with parameters. V2 PUT requires an explicit supported content type even for an omitted or zero-byte body. Core rechecks UTF-8 byte length before writes. | `packages/core/src/vault/`, `apps/worker/src/http/note-body.ts`, `note-content-type.ts` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar reference. It documents actual v2 security, IDs/conditions, optional empty PUT body with required explicit media type, pagination/state/recovery routes and statuses, plus v1 retirement. | `apps/worker/src/http/openapi.routes.ts`, semantic HTTP integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. Authenticated JSON/content/error responses use `Cache-Control: no-store`; registered v2 route/method responses and errors add narrow CORS. Revisioned generations expose strong application ETags, never R2 validators. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `v2.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed-request events include operation, method, registered route template (or `unknown`), status and duration in milliseconds. No request IDs, per-client audit trail or error-code field yet. Application events do not include tokens, bodies, concrete note paths or raw exceptions. | `apps/worker/src/logging/`, logging and Worker tests |
| Plugin | `AiBridgePlugin` preserves the two M2 inspection commands and composes M3 through one enable-lifetime session attached to a versioned same-App-realm facade. Focused host owners govern listener epochs, configuration/connection admission, reconciliation progress and staged-handoff verification. Official saved Vault events register before layout readiness; every replacement listener gap gets a fresh positive-only scan while retained reservations/settlement survive and scan absence grants no delete authority. Positive admission refreshes the one-shot scheduler before reporting inventory settles. Staged handoff events advance durable generations and invalidate sampled metadata before atomic align/activate. Modern declarative settings persist only endpoint/loopback consent/native secret reference, display non-secret device/server designation, and require whole-scope/plaintext/deletion trust consent; dispatch retrieves the bearer from SecretStorage. Missing/failing Web Crypto fences mutation and wake scheduling while retaining dirty state for explicit recovery. Sanitized status and check/retry/pause/resume/handoff controls expose no body, token or raw transport error. M4 Slice 1 strictly loads v3 or migrates validated v2 through one same-key save plus exact read-back before owner publication; runtime registry/owner version 3 refuses M3 reuse. Incompatible registries fail closed. No editor event, local vault mutation, remote-to-local write, capability fallback, deployment or real-host qualification. Manifest remains `ai-bridge`, minimum `1.13.0`, non-desktop-only. | `apps/obsidian-plugin/src/{main.ts,commands/,configuration/,events/,runtime/,status/,remote/,state/}`, dedicated plugin unit/integration/artifact suites |
| Local safety | Shared literal `.md` path and 1 MiB policy; dot-prefixed/configuration-directory exclusions; pre-read metadata and post-read UTF-8 bound; exact lookup and pre/post object/path/mtime/size checks. No path repair/URI decoding, content UI or atomic snapshot claim. | `packages/core/src/local-vault/`, plugin adapter tests |
| Plugin artifact | Browser-target CommonJS exposes `module.exports.default`, keeps only `obsidian` external, and stages the unchanged manifest. Six generated-artifact tests exercise modern declarative SecretStorage settings, official saved Vault event/layout-ready wiring, a real packaged event→core→Fetch v2 conditional PUT with canonical path/identity/operation headers, same-realm in-flight owner reuse across fresh bundle evaluation, incompatible-registry fail-closed behavior, M2 lifecycle continuity, and Node/fixture/secret/machine-path leakage negatives. No real desktop/mobile host was tested. | `.mise.toml`, `apps/obsidian-plugin/tests/artifact/main.test.ts`, [qualification and operating evidence](plugin-development.md) |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. M3 adds platform-independent UUID-v4 IDs, ETags, digests, closed current/recovery/intent/effect contracts, generation-bound conditional ports, current-generation/recovery orchestration, Slice 3's closed device/per-path ledger and serialized state owner, and Slice 4's `RemoteBridge`. Slice 5 adds `MirrorSynchronizer`, a fair two-slot/one-path scheduler, bounded reporting inventory, positive observation generations, 750 ms/5 s coalescing, exact-ACK/evidence reconciliation and durable three-attempt/three-evidence budgets. Slice 6 adds durable event-only delete authority, five-second grace/exact absence, recovery-first tombstone execution through the same finite intent/evidence machinery, exact tombstone recreation, destination-first two-path rename with durable/deferred cleanup prerequisites, lexical reservations, and bounded pre-event folder-descendant expansion. M4 Slice 1 adds closed authority/classification/action/review/operation/evidence/preservation contracts, bounded sparse state-v3 collections, and linear cross-field validation without adding an effect capability. Its corrected immutable review snapshot captures runtime/configuration/listener identity, per-path local/ACK/remote/M3 evidence, exact remote receipts and recovery metadata. Preservation receipts are checked against evidence-derived side/revision/hash requirements, and `restored-pending-review` reservations durably fence ordinary M3 scheduling until a linked reviewed successor takes ownership. Focused lifecycle planner, deletion executor, rename executor and durable transition owner keep policy out of the facade. Positive work starts fail-closed until a current handshake and one indexed durable bootstrap batch succeed; local/capacity/stale/persistence failures remain inactive. Reporting inventory may remain pending in one shared slot while positive work settles in the other. Lifecycle, global and persistence fences suppress mutation admission and wake deadlines while preserving unresolved evidence. Core still imports no Obsidian, Fetch/HTTP, Hono, Cloudflare, filesystem or protocol dependency. Separate public `ReadOnlyLocalVault`, `LocalInspectionService`, closed local results and eligibility policy support M2 without platform imports or mutation methods. | `packages/core/src/`, package exports |
| Protocol | Strict Zod schemas and inferred DTOs for health, errors, retained v1 responses, and bounded M3 identity, NotePath, precondition, receipt, current-state, recovery, intent, capability/result and pagination contracts. Stable public HTTP methods/statuses and v2 route roots, child segments, query/header names and media types are also owned here and consumed by Worker/OpenAPI/plugin adapters; adapter-private route syntax, response classification and CORS policy remain outside. The reserved version `0.1` envelope remains unused rather than being silently repurposed. | `packages/protocol/src/` |

## Tooling and validation baseline

- `.mise.toml` pins Bun **1.4.2** and Node.js **24.21.0**. Bun owns the workspace
  dependency graph and `bun.lock`; `mise run install` installs it frozen.
- Tasks: `install`, `format`, `biome:check`, `lint`, `typecheck`, `test`, `coverage`,
  `worker:storage-test`, `build`, `worker:build`, `plugin:build`, `plugin:smoke`,
  `dev`, `check`. Use `mise run <task>`.
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
- Vitest **5**: **64 source test files / 880 tests**, plus **1 generated-artifact
  file / 6 tests** executed by the build task. The unchanged M1 baseline had
  15 files / 105 tests. Exact slice validation is recorded in the
  [implementation plan](plans/m2-obsidian-read-only-local-adapter.md).
- Worker unit tests live under `apps/worker/tests/unit/` (auth, HTTP, R2 adapter,
  logging). `apps/worker/tests/integration/worker.test.ts` composes Hono, the real
  core service and an in-memory repository. Core and protocol tests live under
  their own `tests/unit/`. Plugin unit tests isolate host/UI behavior; its focused
  integration suite composes commands, core service and official adapter over
  in-memory files. Slice 0 additionally runs 8 tests through an ephemeral local
  Miniflare/workerd R2 binding and compiles official host declaration assertions.
  No test exercises deployed Cloudflare or an installed Obsidian host. These are
  not E2E tests.
- V8 provider `@vitest/coverage-v8` **5.0.0**, run under Node through `coverage`.
  Root `vitest.config.ts` includes `apps/*/src/**/*.ts` and
  `packages/*/src/**/*.ts`, including unimported source; excludes `.d.ts`,
  `*.types.ts`, build/output and Wrangler state. Reports: text, JSON summary, LCOV.
  Global thresholds: **lines 95%, statements 95%, functions 94%, branches 90%**.
  Coverage is a regression signal, not proof of test quality.
- Root Vitest projects include shared packages, Worker and plugin. M4 Slice 1 source
  coverage is statements **95.00%**, branches **91.35%**, functions **98.47%**, lines
  **96.98%**; thresholds and production inclusion remain enforced. Artifact tests are separate
  from source coverage, run after packaging and never replace behavioral coverage.
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

The Worker API is a remote storage boundary, **not synchronization**. A token holder
remains privileged for this one namespace; static IDs are not scoped permissions.
Safe conditional v2 routes now exist and unsafe v1 mutations are retired. Slice 3
models and persists device-local configuration/state, activation and staged handoff,
including atomic indexed alignment batches. Slices 5–6 implement core bootstrap,
positive-event coalescing, path scheduling, finite retry/evidence policy and runtime
deletion/recreation/rename orchestration; Slice 7 composes them with the Fetch client
through official host callbacks, settings, timers and same-realm ownership. There are
no remote-to-local writes. Slice 8's artifact, operational, validation and semantic
review gates passed; the corrective review of `e97af36` returned APPROVE. PR #27
merged at `63b0599`; M3 is COMPLETE and the transition is canonical. M4 is NEXT with
Slices 1–2's contract/state/migration and core read-only review/admission seams
implemented. No M4 UI, remote-to-local mutation, or local-mutation behavior exists;
later read, preservation,
resolution, restore, history, and UI slices remain unimplemented. The accepted M4 design is reviewed-only: exact format-2 revisions
may be adopted, competing bytes must be preserved before replacement, remote
tombstones require explicit choices without plugin local delete/move, recovery restore
is local-only first, legacy same-path adoption remains prohibited, valid state v2
migrates fail-closed to v3, the existing v2 API suffices, and one designated writer
remains. Only the state/migration fence is implemented; the later behavior remains
an accepted design contract, not current operator functionality.

There is no search, MCP, AI inference, attachment mirroring or remote-to-local plugin client.
No D1, Durable Objects, queues, Vectorize, Workers AI or external database is part
of the product architecture. Generated local emulator artifacts are not evidence
that such services were selected.

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
reconciliation machinery drive the experimental connected outward plugin runtime.
The [operator guide](operations.md) records setup, one-writer availability,
upgrade/handoff/reset, bearer rotation, recovery API use, iCloud uncertainty, and
rollback prohibitions. M3 completion is an implementation/evidence milestone; it is
not production readiness, deployment, or real-host qualification.
Broader operating limits/recovery automation and scoped authentication remain M5;
prerequisites to safe M3/M4 behavior must not be postponed there.

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
