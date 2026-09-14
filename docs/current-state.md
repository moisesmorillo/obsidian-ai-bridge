# Verified current state

This snapshot records the completed M2 local-inspection implementation, M1
foundation, and implemented M3 Worker Slice 2 subset. M2 source/tooling through
`2e74b23` passed independent semantic review;
the completion PR records final validation and makes the transition canonical
when merged. M2 is now merged at `b300726` (PR #7). M3 has completed [Slice 0 platform qualification](qualification/m3-slice-0-platform-primitives.md),
Slice 1's modern plugin baseline/shared typed contracts, and Worker Slice 2A–2C's
private storage/application transitions plus public safe v2 HTTP/OpenAPI/CORS. There
is still no remote plugin client or connected mirror. Its [accepted design decisions](plans/m3-design-decisions.md)
and [sequential plan](plans/m3-remote-bridge-client-and-publishing.md) remain broader
than the implemented subset. The approved product is an automatic whole eligible
Markdown mirror with recoverable runtime deletion/rename, per-path state and one
designated writer—not selected/manual publishing. M3 Slice 1 sets the plugin manifest baseline to Obsidian 1.13.0 for future native
SecretStorage/declarative settings; it adds neither settings nor credentials.
M1's historical foundation was audited at `22d3ee0` (PR #4); current Worker
compatibility behavior additionally decodes format-2 reads and retires v1 mutations.
This is not a claim about a deployed environment or installed Obsidian host.
[Roadmap](roadmap.md) owns milestone status; [architecture](architecture.md) owns
boundaries; [API](api.md) describes the HTTP contract.

## Implemented capabilities and evidence

| Area | Verified behavior | Primary evidence |
| --- | --- | --- |
| Worker | Typed Hono/OpenAPI app assembled once per isolate; request middleware resolves the note service and bearer secret from bindings. Handlers call application services, not repositories. | `apps/worker/src/{index,app,app.types}.ts`, `src/http/` |
| M3 Worker | Private tagged live/tombstone/recovery codecs; create-only and exact-observed-generation R2 CAS; core current/recovery policy; authenticated public v2 mirror/current/recovery routes; strict IDs/conditions/media/stream bounds; application ETags; separate recovery metadata/content; method-specific CORS; envelope-aware v1 reads and 410 v1 mutation retirement. | `packages/core/src/mirror/`, `apps/worker/src/{composition,http,infrastructure}/`, focused storage/service/HTTP/composed tests |
| Routes | Public health/OpenAPI/Scalar; authenticated envelope-aware v1 GET/list plus retired PUT/DELETE; authenticated paginated v2 mirror/current/state/recovery metadata/content and POST maintenance routes. Both API prefixes and unknown descendants are protected; registered v2 OPTIONS is storage-free. | `apps/worker/src/app.ts`, `src/http/{v2.handlers,v2-cors.middleware,openapi.routes}.ts` |
| Authentication | One `OBSIDIAN_BRIDGE_TOKEN`; missing/empty configuration fails closed. Bearer scheme is case-insensitive; malformed, missing, unsupported or wrong credentials yield sanitized 401 with `WWW-Authenticate: Bearer`. Comparison hashes both tokens with SHA-256 and compares fixed-length digests without early exit. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts` |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. V2 listing exposes bounded 50-object pages with opaque cursors; retained v1 aggregates at most 1,000 such pages. Both filter unsafe/non-Markdown/oversized untagged legacy/out-of-namespace keys; tagged malformed or oversized objects fail sanitized. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | Legacy/live reads return decoded text; tombstones are hidden. V2 create/update/recreate/tombstone and recovery maintenance use application service policy plus conditional R2 PUT only. Persisted malformed/oversized objects fail sanitized. V1 PUT/DELETE return 410 without mutation. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. Worker bounds actual streamed bytes independently of the declared length, rejects invalid UTF-8, accepts empty content, and accepts Markdown/plain-text media types case-insensitively with parameters. V2 PUT requires an explicit supported content type even for an omitted or zero-byte body. Core rechecks UTF-8 byte length before writes. | `packages/core/src/vault/`, `apps/worker/src/http/note-body.ts`, `note-content-type.ts` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar reference. It documents actual v2 security, IDs/conditions, optional empty PUT body with required explicit media type, pagination/state/recovery routes and statuses, plus v1 retirement. | `apps/worker/src/http/openapi.routes.ts`, semantic HTTP integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. Authenticated JSON/content/error responses use `Cache-Control: no-store`; registered v2 route/method responses and errors add narrow CORS. Revisioned generations expose strong application ETags, never R2 validators. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `v2.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed-request events include operation, method, registered route template (or `unknown`), status and duration in milliseconds. No request IDs, per-client audit trail or error-code field yet. Application events do not include tokens, bodies, concrete note paths or raw exceptions. | `apps/worker/src/logging/`, logging and Worker tests |
| Plugin | Default `AiBridgePlugin` registers exactly two explicit commands. List displays sorted saved-note metadata/skip counts without body reads; active inspection captures the saved path, reads once and displays only UTF-8 bytes/path with saved-file guidance. Plugin-instance serialization survives unload/re-enable until pending work settles, while enable-lifetime identity suppresses stale UI. Sanitized failures are tested. No enabling scan/read, network, settings/persistence, logging, editor save or vault mutation. Manifest remains `ai-bridge`, minimum `1.13.0`, non-desktop-only. | `apps/obsidian-plugin/src/{main.ts,inspection/,infrastructure/}`, dedicated plugin unit/integration suites |
| Local safety | Shared literal `.md` path and 1 MiB policy; dot-prefixed/configuration-directory exclusions; pre-read metadata and post-read UTF-8 bound; exact lookup and pre/post object/path/mtime/size checks. No path repair/URI decoding, content UI or atomic snapshot claim. | `packages/core/src/local-vault/`, plugin adapter tests |
| Plugin artifact | Browser-target CommonJS exposes `module.exports.default`, only `obsidian` external; stages unchanged manifest. Artifact suite checks actual generated files, inert load, commands and lifecycle in an isolated host-double realm without Node globals. No real desktop/mobile host was tested. | `.mise.toml`, `apps/obsidian-plugin/tests/artifact/`, [API/version and installation evidence](plugin-development.md) |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. M3 adds platform-independent UUID-v4 IDs, ETags, digests, closed current/recovery/intent/effect contracts, generation-bound conditional ports, current-generation orchestration and recovery lifecycle policy with an injected clock. No Obsidian, Hono, Cloudflare, HTTP, filesystem or protocol dependency. Separate public `ReadOnlyLocalVault`, `LocalInspectionService`, closed local results and eligibility policy support M2 without platform imports or mutation methods. | `packages/core/src/`, package exports |
| Protocol | Zod schemas and inferred DTOs for health, errors, retained v1 responses, and strict bounded M3 identity, NotePath, precondition, receipt, current-state, recovery, intent, capability/result and pagination contracts. V2 handlers/OpenAPI consume these sources; the reserved version `0.1` envelope remains unused rather than being silently repurposed. | `packages/protocol/src/` |

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
- Vitest **5**: **31 source test files / 362 tests**, plus **1 artifact file /
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
- Root Vitest projects include shared packages, Worker and plugin. Slice 2C source
  coverage is statements **95.79%**, branches **92.49%**, functions **98.03%**, lines
  **95.94%**; thresholds and production inclusion remain enforced. Artifact tests are separate
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
Safe conditional v2 routes now exist and unsafe v1 mutations are retired, but there
are no remote-to-local writes, automatic saved-event processing, plugin credential/
state owner, per-path ledger, retries, handoff or initial-sync behavior. Never infer
a connected mirror merely from the server surface.

There is no search, MCP, AI inference, attachment mirroring or remote plugin client.
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
native secret references and explicit writer handoff. The Worker storage/application/
transport subset exists; plugin configuration, transport client and automatic
behavior do not.
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
