# Verified current state

This snapshot records the completed M2 local-inspection implementation and M1
foundation. M2 source/tooling through `2e74b23` passed independent semantic review;
the completion PR records final validation and makes the transition canonical
when merged. M2 is now merged at `b300726` (PR #7). M3 has completed [Slice 0 platform qualification](qualification/m3-slice-0-platform-primitives.md),
Slice 1's modern plugin baseline/shared typed contracts, and Worker Slice 2A/2B's
private storage plus application transition checkpoints. There is still no remote
plugin client or v2 route. Its [accepted design decisions](plans/m3-design-decisions.md)
and [sequential plan](plans/m3-remote-bridge-client-and-publishing.md) remain broader
than the implemented subset. The approved product is an automatic whole eligible
Markdown mirror with recoverable runtime deletion/rename, per-path state and one
designated writer—not selected/manual publishing. M3 Slice 1 sets the plugin manifest baseline to Obsidian 1.13.0 for future native
SecretStorage/declarative settings; it adds neither settings nor credentials.
M1 behavior is unchanged from the baseline audited at `22d3ee0` (PR #4).
This is not a claim about a deployed environment or installed Obsidian host.
[Roadmap](roadmap.md) owns milestone status; [architecture](architecture.md) owns
boundaries; [API](api.md) describes the HTTP contract.

## Implemented capabilities and evidence

| Area | Verified behavior | Primary evidence |
| --- | --- | --- |
| Worker | Typed Hono/OpenAPI app assembled once per isolate; request middleware resolves the note service and bearer secret from bindings. Handlers call application services, not repositories. | `apps/worker/src/{index,app,app.types}.ts`, `src/http/` |
| M3 Worker internals | Private tagged live/tombstone/recovery codecs; create-only and exact-observed-generation R2 CAS; core create/update/recreate/tombstone services with exact receipts; recovery-first deletion, tombstone-upload-derived sealing, metadata inspection, prepared/unexpired content retrieval, expiry withholding, bounded listing and expired sealed CAS purge to retained content-free markers. These capabilities are not routed yet. | `packages/core/src/mirror/`, `apps/worker/src/infrastructure/{current-object.codec,r2-conditional-current-note.repository,recovery-object.codec,r2-recovery-snapshot.repository}.ts`, focused storage/service tests |
| Routes | Public `GET /health`, `GET /openapi.json`, `GET /docs`; authenticated `GET /api/v1/notes` and `GET`, `PUT`, `DELETE /api/v1/notes/:path`. `/api/v1` and descendants are protected, including unknown API routes. | `apps/worker/src/app.ts`, `src/http/openapi.routes.ts` |
| Authentication | One `OBSIDIAN_BRIDGE_TOKEN`; missing/empty configuration fails closed. Bearer scheme is case-insensitive; malformed, missing, unsupported or wrong credentials yield sanitized 401 with `WWW-Authenticate: Bearer`. Comparison hashes both tokens with SHA-256 and compares fixed-length digests without early exit. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts` |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. Listing follows all R2 cursors, filters unsafe/non-Markdown/oversized/out-of-namespace keys, deduplicates; core sorts the result. No public pagination. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | Read returns text or 404. Persisted objects above 1 MiB are rejected before reading their text (sanitized 500). Write checks existence then performs an unconditional put: 201 for observed absence, otherwise 200. Delete is immediate and idempotent (204), with no tombstone or recovery. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. Worker bounds actual streamed bytes independently of the declared length, rejects invalid UTF-8, accepts empty content, and accepts Markdown/plain-text media types case-insensitively with parameters. Missing/empty content type is also accepted at runtime. Core rechecks UTF-8 byte length before writes. | `packages/core/src/vault/`, `apps/worker/src/http/note-body.ts`, `note-content-type.ts` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar HTML reference. Runtime path and byte validation is stricter than the broad OpenAPI string schemas. The PUT document requires a body and names supported media types, while runtime also accepts no body/header. | `apps/worker/src/http/openapi.routes.ts`, HTTP unit/integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. JSON API/health/error and Markdown content responses use `Cache-Control: no-store`; this is not a claim about Scalar/OpenAPI or the bodyless DELETE response. Unsupported methods on valid note identifiers return 404, not 405. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `note.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed-request events include operation, method, registered route template (or `unknown`), status and duration in milliseconds. No request IDs, per-client audit trail or error-code field yet. Application events do not include tokens, bodies, concrete note paths or raw exceptions. | `apps/worker/src/logging/`, logging and Worker tests |
| Plugin | Default `AiBridgePlugin` registers exactly two explicit commands. List displays sorted saved-note metadata/skip counts without body reads; active inspection captures the saved path, reads once and displays only UTF-8 bytes/path with saved-file guidance. Plugin-instance serialization survives unload/re-enable until pending work settles, while enable-lifetime identity suppresses stale UI. Sanitized failures are tested. No enabling scan/read, network, settings/persistence, logging, editor save or vault mutation. Manifest remains `ai-bridge`, minimum `1.13.0`, non-desktop-only. | `apps/obsidian-plugin/src/{main.ts,inspection/,infrastructure/}`, dedicated plugin unit/integration suites |
| Local safety | Shared literal `.md` path and 1 MiB policy; dot-prefixed/configuration-directory exclusions; pre-read metadata and post-read UTF-8 bound; exact lookup and pre/post object/path/mtime/size checks. No path repair/URI decoding, content UI or atomic snapshot claim. | `packages/core/src/local-vault/`, plugin adapter tests |
| Plugin artifact | Browser-target CommonJS exposes `module.exports.default`, only `obsidian` external; stages unchanged manifest. Artifact suite checks actual generated files, inert load, commands and lifecycle in an isolated host-double realm without Node globals. No real desktop/mobile host was tested. | `.mise.toml`, `apps/obsidian-plugin/tests/artifact/`, [API/version and installation evidence](plugin-development.md) |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. M3 adds platform-independent UUID-v4 IDs, ETags, digests, closed current/recovery/intent/effect contracts, generation-bound conditional ports, current-generation orchestration and recovery lifecycle policy with an injected clock. No Obsidian, Hono, Cloudflare, HTTP, filesystem or protocol dependency. Separate public `ReadOnlyLocalVault`, `LocalInspectionService`, closed local results and eligibility policy support M2 without platform imports or mutation methods. | `packages/core/src/`, package exports |
| Protocol | Zod schemas and inferred DTOs for M1 health, note lists, write acknowledgments, errors, and a reserved version `0.1` metadata envelope. Slice 1 adds strict bounded M3 identity, NotePath, precondition, receipt, current-state, recovery, intent, effect and pagination DTO schemas using public core predicates. No v2 route consumes these schemas yet; the reserved envelope is not wrapped around current REST responses and is not a sync protocol. | `packages/protocol/src/` |

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
- Vitest **5**: **29 source test files / 325 tests**, plus **1 artifact file /
  3 smoke tests** in the dedicated build task. The unchanged M1 baseline had
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
- Root Vitest projects include shared packages, Worker and plugin. Source coverage
  is statements **95.53%**, branches **92.10%**, functions **97.43%**, lines
  **95.90%**; plugin behavior has 100% across all four. Artifact tests are separate
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

M1 is a remote storage API, **not synchronization**. A token holder can read,
replace and permanently delete any accepted note in this one namespace. There
are no per-user/device permissions, public conditional routes, remote-to-local
writes, automatic saved-event processing, per-path ledger, retries or initial-sync
state. The new conditional/recovery services are internal and do not make M1's
existence-check plus unconditional PUT or hard DELETE safe. Never use M1 mutations
for a future sync client.

There is no search, MCP, AI inference, attachment mirroring or remote plugin client.
No D1, Durable Objects, queues, Vectorize, Workers AI or external database is part
of the product architecture. Generated local emulator artifacts are not evidence
that such services were selected.

R2 contains note text, not application-encrypted ciphertext. The Worker/cloud
operator is within the trust boundary. Configuration names a development bucket;
it does not prove that bucket, a deployment, credentials or a vault installation
exists. Local secret configuration is ignored and must not become project memory.

The runtime/OpenAPI PUT permissiveness difference is a known contract gap, not a
new implementation in this handoff. Resolve and test the documented client-facing
contract in M3 before relying on generated clients. M3's accepted design includes
safe v2 mutations, paginated reads, 30-day deletion recovery, tombstone/purge markers,
native secret references and explicit writer handoff. Only the internal storage and
application transition subset exists; transport and plugin capabilities do not.
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
