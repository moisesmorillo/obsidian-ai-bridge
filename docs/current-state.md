# Verified current state

This snapshot records completed M1–M4 repository implementation and M5 Slices 2–3's credential and live-diagnostics checkpoints.
M2 source/tooling through `2e74b23` passed independent semantic
review and merged at `b300726` (PR #7). M3's completion PR #27 passed canonical
validation and final semantic review; its three MINOR findings were corrected at
`e97af36`, whose corrective review returned APPROVE with no open findings. PR #27
merged at `63b0599`; M3 is COMPLETE and the M3→M4 transition is canonical.
M4 Slices 1–8 are COMPLETE and M5 is the single NEXT milestone. M5 Slices 0–3 are complete and Slice 4 is next. The completed
[specification](milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[sequential plan](plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
and ADRs 0005–0009 define the reviewed boundary. The compatibility transition uses
strict device state v4 and runtime-owner version 4, frozen v2/v3 decoders, same-key
exact read-back migration, content-free reviewed admission/effects, bounded parent-
owned history steps and step-scoped archives. One owner-scoped scheduler serves M3 and
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
| Authentication | Strict version-1 registry of at most 16 named digest-only clients; canonical lowercase UUID-v4 IDs, ADR name grammar, nonempty exact permission sets, unique IDs/case-folded names/digests, and unknown-field/version rejection are validated atomically. Tokens use 32 secure-random bytes and canonical unpadded base64url; verifiers use domain-separated SHA-256 and canonical lowercase hex. Every configured digest is compared without an early successful exit. Success publishes only a typed `{clientId, name, permissions}` principal; missing/malformed/wrong/invalid configuration yields sanitized 401. Explicit singleton migration and registry modes never fall through to each other; committed configuration selects registry mode. Route permission enforcement remains Slice 4. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts`, focused auth/registry/integration tests |
| Credential lifecycle | Offline mise tooling creates/provisions fresh credentials, performs bounded overlap rotation, revokes exact client IDs, replaces lost credentials without recovery, and builds all-new registries after total loss. It validates complete updates through the same registry owner, accepts no raw-token argument, requires interactive one-time secret display, writes owner-only registry files outside the repository, and makes no HTTP/deployment call. | `tools/credentials/`, `tools/tests/unit/credential-lifecycle.test.ts`, [operator procedure](operations.md#credential-registry-lifecycle-and-singleton-migration) |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. V2 listing exposes bounded 50-object pages with opaque cursors; retained v1 aggregates at most 1,000 such pages. Both filter unsafe/non-Markdown/oversized untagged legacy/out-of-namespace keys; tagged malformed or oversized objects fail sanitized. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | Legacy/live reads return decoded text; tombstones are hidden. V2 create/update/recreate/tombstone and recovery maintenance use application service policy plus conditional R2 PUT only. Persisted malformed/oversized objects fail sanitized. V1 PUT/DELETE return 410 without mutation. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. Worker bounds actual streamed bytes independently of the declared length, rejects invalid UTF-8, accepts empty content, and accepts Markdown/plain-text media types case-insensitively with parameters. V2 PUT requires an explicit supported content type even for an omitted or zero-byte body. Core rechecks UTF-8 byte length before writes. | `packages/core/src/vault/`, `apps/worker/src/http/note-body.ts`, `note-content-type.ts` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar reference. It documents actual v2 security, IDs/conditions, optional empty PUT body with required explicit media type, pagination/state/recovery routes and statuses, plus v1 retirement. | `apps/worker/src/http/openapi.routes.ts`, semantic HTTP integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. Authenticated JSON/content/error responses use `Cache-Control: no-store`; registered v2 route/method responses and errors add narrow CORS. Revisioned generations expose strong application ETags, never R2 validators. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `v2.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed-request events include event operation, method, registered route template (or `unknown`), closed operation category, closed authentication result, canonical client ID only when authenticated, HTTP status, stable API error code when present, and duration in milliseconds. Application events exclude client names, tokens/digests, permission metadata, authorization headers, bodies, concrete or encoded note/recovery identifiers, revisions, hashes, receipts, storage envelopes, and raw exceptions. Platform-managed live diagnostics retain zero application days and are not a durable audit trail. | `apps/worker/src/logging/`, v2 route policy, focused logging and Worker integration tests |
| Plugin | `AiBridgePlugin` preserves the two M2 inspection commands and composes M3 through one enable-lifetime session attached to a versioned same-App-realm facade. Focused host owners govern listener epochs, configuration/connection admission, reconciliation progress and staged-handoff verification. Official saved Vault events register before layout readiness; every replacement listener gap gets a fresh positive-only scan while retained reservations/settlement survive and scan absence grants no delete authority. Positive admission refreshes the one-shot scheduler before reporting inventory settles. Staged handoff events advance durable generations and invalidate sampled metadata before atomic align/activate. Modern declarative settings persist only endpoint/loopback consent/native secret reference, display non-secret device/server designation, and require whole-scope/plaintext/deletion trust consent; dispatch retrieves the bearer from SecretStorage. Missing/failing Web Crypto fences mutation and wake scheduling while retaining dirty state for explicit recovery. Sanitized status and check/retry/pause/resume/handoff controls expose no body, token or raw transport error. M4 Slices 6–7 strictly load v4 or migrate validated v2→v3→v4 through one same-key save plus exact read-back before owner publication; runtime registry/owner version 4 refuses older reuse. Reviewed M4 commands, text-only modals, session invalidation, startup orphan staling, shared scheduling, event-first successor fencing, recovery selection and sanitized status are composed. Before publication, a read-only startup transition resolves migrated v3 local effects from durable expected postconditions without redispatch: exact bytes resume as `recovered-v3`, absent/changed bytes stay blocked, ambiguous evidence remains retryable, and failed persistence aborts startup. Incompatible registries fail closed. Local create/replace is reachable only through reviewed operations and exact evidence; there is no editor event, local delete/move/rename, capability fallback, deployment or real-host qualification. Manifest remains `ai-bridge`, minimum `1.13.0`, non-desktop-only. | `apps/obsidian-plugin/src/{main.ts,commands/,configuration/,events/,runtime/,status/,remote/,state/}`, dedicated plugin unit/integration/artifact suites |
| Local safety | Shared literal `.md` path and 1 MiB policy; dot-prefixed/configuration-directory exclusions; pre-read metadata and post-read UTF-8 bound; exact lookup and pre/post object/path/mtime/size checks. M4's separate reviewed-write adapter supports only official lookup/create/createFolder/read/process operations, fixed generated conflict paths, create-only collision rules, atomic exact-text replacement, and post-effect identity/hash verification. It is composed only behind admitted reviewed operations. No delete/rename/move, raw filesystem, path repair/URI decoding, Markdown-rendered content UI, or cross-system atomicity claim. | `packages/core/src/local-vault/`, `apps/obsidian-plugin/src/infrastructure/`, focused adapter tests |
| Plugin artifact | Browser-target CommonJS exposes `module.exports.default`, keeps only `obsidian` external, and stages the unchanged manifest. Eleven generated-artifact tests retain the M2/M3 packaging/runtime checks and add literal hostile-text preview, one packaged review→preservation→conditional v2 Keep local path with exact identity/revision semantics, stale session/local-event/remote-revision refusal, local-only pending restore, compatible M4 owner retention, incompatible-registry refusal, and credential/body/Node/raw-filesystem/private-key/machine-path leakage negatives. No real desktop/mobile host was tested. | `.mise.toml`, `apps/obsidian-plugin/tests/artifact/main.test.ts`, [qualification and operating evidence](plugin-development.md) |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. M3 adds platform-independent UUID-v4 IDs, ETags, digests, closed current/recovery/intent/effect contracts, generation-bound conditional ports, current-generation/recovery orchestration, Slice 3's closed device/per-path ledger and serialized state owner, and Slice 4's `RemoteBridge`. Slice 5 adds `MirrorSynchronizer`, a fair two-slot/one-path scheduler, bounded reporting inventory, positive observation generations, 750 ms/5 s coalescing, exact-ACK/evidence reconciliation and durable three-attempt/three-evidence budgets. Slice 6 adds durable event-only delete authority, five-second grace/exact absence, recovery-first tombstone execution through the same finite intent/evidence machinery, exact tombstone recreation, destination-first two-path rename with durable/deferred cleanup prerequisites, lexical reservations, and bounded pre-event folder-descendant expansion. M4 uses closed authority/classification/action/review/operation/evidence/preservation contracts, bounded sparse state-v4 collections, and linear cross-field validation. Its corrected immutable review snapshot captures runtime/configuration/listener identity, per-path local/ACK/remote/M3 evidence, exact remote receipts and recovery metadata. Preservation receipts are checked against evidence-derived side/revision/hash requirements, and `restored-pending-review` reservations durably fence ordinary M3 scheduling until a linked reviewed successor takes ownership. Focused lifecycle planner, deletion executor, rename executor and durable transition owner keep policy out of the facade. Positive work starts fail-closed until a current handshake and one indexed durable bootstrap batch succeed; local/capacity/stale/persistence failures remain inactive. Reporting inventory may remain pending in one shared slot while positive work settles in the other. Lifecycle, global and persistence fences suppress mutation admission and wake deadlines while preserving unresolved evidence. M4 Slice 3 keeps `ReadOnlyLocalVault` unchanged and adds a separate three-command `LocalReconciliationWriter`; focused services authorize exact operation/action/path/phase/reservation/evidence, persist prepared effects or pending preservation receipts before dispatch, post-verify evidence, retain unknown certainty, and allow only exact same-operation recovery. Slices 4–5 compose those primitives inside core for archive-first live resolution, exact adoption and legacy fork, explicit tombstone resolution, and local-first recovery restore. A shared effect executor performs exact barriers, conditional remote settlement, receipt recovery and atomic baseline completion; restored paths remain fenced until a fresh reviewed successor atomically takes ownership. Core still imports no Obsidian, Fetch/HTTP, Hono, Cloudflare, filesystem or protocol dependency. | `packages/core/src/`, package exports |
| Protocol | Strict Zod schemas and inferred DTOs for health, errors, retained v1 responses, and bounded M3 identity, NotePath, precondition, receipt, current-state, recovery, intent, capability/result and pagination contracts. Stable public HTTP methods/statuses and v2 route roots, child segments, query/header names and media types are also owned here and consumed by Worker/OpenAPI/plugin adapters; adapter-private route syntax, response classification and CORS policy remain outside. The reserved version `0.1` envelope remains unused rather than being silently repurposed. | `packages/protocol/src/` |

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
- Vitest **5**: **78 source test files / 1,241 tests**, plus **1 generated-artifact
  file / 11 tests** executed by the build task. The unchanged M1 baseline had
  15 files / 105 tests. M5 Slice 2 adds focused registry, authentication, lifecycle,
  migration, leakage, and CLI-boundary tests; Slice 3 adds focused client/operation/
  outcome attribution, hard-bound, failure, and leakage tests. Exact earlier slice validation is recorded in the
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
- Root Vitest projects include shared packages, Worker and plugin. M5 Slice 3 source
  coverage is statements **95.08% (7,448/7,833)**, branches **90.71%
  (5,942/6,550)**, functions **98.15% (1,645/1,676)**, and lines **96.99%
  (7,078/7,297)**; thresholds and production inclusion remain enforced. Artifact tests
  are separate from source coverage, run after packaging and never replace behavioral
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
are independently revocable, but Slices 2–3 have not applied their permission metadata
to routes; every authenticated client therefore retains the current namespace route
authority. Static IDs are not scoped permissions.
Safe conditional v2 routes now exist and unsafe v1 mutations are retired. Slice 3
models and persists device-local configuration/state, activation and staged handoff,
including atomic indexed alignment batches. Slices 5–6 implement core bootstrap,
positive-event coalescing, path scheduling, finite retry/evidence policy and runtime
deletion/recreation/rename orchestration; Slice 7 composes them with the Fetch client
through official host callbacks, settings, timers and same-realm ownership. M3 has
no remote-to-local writes; M4 Slices 6–7 expose only explicit reviewed local
create/replace actions. M3 Slice 8's artifact, operational, validation, and semantic
review gates passed; the corrective review of `e97af36` returned APPROVE. PR #27
merged at `63b0599`; M3 is COMPLETE and its transition is canonical. M4 is COMPLETE
in this completion PR with reviewed contracts, strict state-v4
migration, preservation/local-write seams, live/adoption/tombstone/restore/history
execution, plugin runtime/UI composition, and Slice 8 qualification. M5 is NEXT;
Slices 0–3 are complete, with no current support claim. Credential principals/lifecycle
and client-attributed content-free live diagnostics exist, but route-level permission
enforcement, v1 retirement, and final qualification remain later M5 slices. The accepted M4 design remains
reviewed-only: exact format-2 revisions may be adopted, competing bytes are preserved
before replacement, remote tombstones require explicit choices without plugin local
delete/move, recovery restore is local-only first, legacy same-path adoption remains
prohibited, the existing v2 API suffices, and one designated writer remains.

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
Route permission enforcement, complete v1 retirement, final runbooks, and real-desktop
qualification remain M5. ADR 0011 deliberately
selects no application quota/limiter, recovery automation, durable logs, mobile writer,
or multi-release support; prerequisites to safe M3/M4 behavior must not be postponed.

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
