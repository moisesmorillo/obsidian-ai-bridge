# Verified current state

This is the M1 baseline audited against merged commit `22d3ee0` (PR #4), not a
claim about a deployed environment. Update this snapshot when capabilities change.
[Roadmap](roadmap.md) owns milestone status; [architecture](architecture.md) owns
boundaries; [API](api.md) describes the HTTP contract.

## Implemented capabilities and evidence

| Area | Verified behavior | Primary evidence |
| --- | --- | --- |
| Worker | Typed Hono/OpenAPI app assembled once per isolate; request middleware resolves the note service and bearer secret from bindings. Handlers call application services, not repositories. | `apps/worker/src/{index,app,app.types}.ts`, `src/http/` |
| Routes | Public `GET /health`, `GET /openapi.json`, `GET /docs`; authenticated `GET /api/v1/notes` and `GET`, `PUT`, `DELETE /api/v1/notes/:path`. `/api/v1` and descendants are protected, including unknown API routes. | `apps/worker/src/app.ts`, `src/http/openapi.routes.ts` |
| Authentication | One `OBSIDIAN_BRIDGE_TOKEN`; missing/empty configuration fails closed. Bearer scheme is case-insensitive; malformed, missing, unsupported or wrong credentials yield sanitized 401 with `WWW-Authenticate: Bearer`. Comparison hashes both tokens with SHA-256 and compares fixed-length digests without early exit. | `apps/worker/src/auth/`, `src/http/authentication.middleware.ts` |
| Persistence | `VAULT_BUCKET` binding, keys `vault/<normalized-path>`, Markdown HTTP metadata. Listing follows all R2 cursors, filters unsafe/non-Markdown/oversized/out-of-namespace keys, deduplicates; core sorts the result. No public pagination. | `apps/worker/src/infrastructure/`, `packages/core/src/vault/note-service.ts` |
| Reads/writes/deletes | Read returns text or 404. Persisted objects above 1 MiB are rejected before reading their text (sanitized 500). Write checks existence then performs an unconditional put: 201 for observed absence, otherwise 200. Delete is immediate and idempotent (204), with no tombstone or recovery. | Repository, service and handlers above |
| Addressing | Item routes require canonical unpadded base64url of UTF-8 `NotePath`, not hierarchical URL paths. Relative paths must end in lowercase `.md`; absolute/drive paths, backslashes, NUL, empty/dot segments, dangerous encoded separators/traversal and noncanonical identifiers are rejected. | `packages/core/src/note-path/`, corresponding unit tests |
| Payload | `MAX_NOTE_SIZE_BYTES = 1024 * 1024` in core. Worker bounds actual streamed bytes independently of the declared length, rejects invalid UTF-8, accepts empty content, and accepts Markdown/plain-text media types case-insensitively with parameters. Missing/empty content type is also accepted at runtime. Core rechecks UTF-8 byte length before writes. | `packages/core/src/vault/`, `apps/worker/src/http/note-body.ts`, `note-content-type.ts` |
| API documentation | OpenAPI 3.1 generated through `@hono/zod-openapi`; shared Zod response schemas; public Scalar HTML reference. Runtime path and byte validation is stricter than the broad OpenAPI string schemas. The PUT document requires a body and names supported media types, while runtime also accepts no body/header. | `apps/worker/src/http/openapi.routes.ts`, HTTP unit/integration tests |
| Responses | Stable typed error codes mapped to sanitized HTTP errors. JSON API/health/error and Markdown content responses use `Cache-Control: no-store`; this is not a claim about Scalar/OpenAPI or the bodyless DELETE response. Unsupported methods on valid note identifiers return 404, not 405. | `apps/worker/src/http/api-*`, `http-response-headers.ts`, `note.handlers.ts` |
| Logging | LogTape 2.3.4 JSON-lines console sink via a thin injected adapter; completed-request events include operation, method, registered route template (or `unknown`), status and duration in milliseconds. No request IDs, per-client audit trail or error-code field yet. Application events do not include tokens, bodies, concrete note paths or raw exceptions. | `apps/worker/src/logging/`, logging and Worker tests |
| Plugin | `src/main.ts` exports only a type-level `PluginScaffold`. There is no default `Plugin` subclass, lifecycle, command, settings UI, vault access, network behavior, persisted state or plugin test project. Manifest ID is `ai-bridge`, minimum host version `1.5.0`, `isDesktopOnly: false`; those declarations are not host compatibility test evidence. Current bundle task validates the scaffold only. | `apps/obsidian-plugin/`, root Vitest configuration |
| Core | Public branded identifier/path utilities, `NoteService`/`VaultNoteService`, `VaultRepository`, size limit and typed payload/storage errors. No Obsidian, Hono, Cloudflare or filesystem implementations. The repository port includes mutation operations; it is not a read-only local adapter contract. | `packages/core/src/`, package exports |
| Protocol | Zod schemas and inferred DTOs for health, note lists, write acknowledgments, errors, and a reserved version `0.1` metadata envelope. List/write path fields are plain schema strings, not domain validation. The reserved envelope is not wrapped around current REST responses and is not a sync protocol. | `packages/protocol/src/` |

## Tooling and validation baseline

- `.mise.toml` pins Bun **1.4.2** and Node.js **24.21.0**. Bun owns the workspace
  dependency graph and `bun.lock`; `mise run install` installs it frozen.
- Tasks: `install`, `format`, `biome:check`, `lint`, `typecheck`, `test`, `coverage`,
  `build`, `worker:build`, `plugin:build`, `dev`, `check`. Use `mise run <task>`.
  `mise install` installs tools, not workspace dependencies.
- `check` depends on Biome check (formatting, recommended lint and organize-import
  assists), type-aware Oxlint with denied warnings, TypeScript, coverage and both
  builds. It runs the test suite through coverage rather than twice.
- TypeScript is strict with unchecked-index and exact-optional checks. Shared
  `@core/*`, `@protocol/*`, `@worker/*`, `@obsidian-plugin/*` aliases cover internal
  imports; cross-package consumers use public `@obsidian-ai-bridge/*` exports.
- Oxlint plus `oxlint-tsgolint` enforce deprecated API detection, explicit-`any`
  prohibition, direct-console prohibition and configured documentation rules.
  These checks do **not** prove all architecture/TSDoc requirements in
  [AGENTS.md](../AGENTS.md); manual semantic review remains mandatory.
- Vitest **5**: **15 files / 105 tests** in the audited M1 suite, confirmed by
  `mise run check` during this documentation handoff. This is a baseline, not a
  fixed target for future work.
- Worker unit tests live under `apps/worker/tests/unit/` (auth, HTTP, R2 adapter,
  logging). `apps/worker/tests/integration/worker.test.ts` composes Hono, the real
  core service and an in-memory repository. Core and protocol tests live under
  their own `tests/unit/`. R2 uses a typed fake; no test exercises live Cloudflare
  or an installed Obsidian host. These are not E2E tests.
- V8 provider `@vitest/coverage-v8` **5.0.0**, run under Node through `coverage`.
  Root `vitest.config.ts` includes `apps/*/src/**/*.ts` and
  `packages/*/src/**/*.ts`, including unimported source; excludes `.d.ts`,
  `*.types.ts`, build/output and Wrangler state. Reports: text, JSON summary, LCOV.
  Global thresholds: **lines 95%, statements 95%, functions 94%, branches 90%**.
  Coverage is a regression signal, not proof of test quality.
- Root Vitest projects currently include shared packages and Worker only. M2 must
  register the plugin test project, not just create unexecuted test files.
- Worker build uses Node + Wrangler **4.130.0** `deploy --dry-run`; plugin build
  uses Bun with `obsidian` external. `build` does not deploy. `dev` runs the local
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
are no per-user/device identities, permissions, vault namespaces, conditional
writes, revisions, conflict detection, tombstones, remote-to-local writes,
selection rules, retries, offline queue or initial-sync state. The separate
existence check and put are not atomic concurrency protection. Never use them as
such in a future sync client.

There is no search, MCP, AI inference, attachment mirroring or plugin runtime.
No D1, Durable Objects, queues, Vectorize, Workers AI or external database is part
of the product architecture. Generated local emulator artifacts are not evidence
that such services were selected.

R2 contains note text, not application-encrypted ciphertext. The Worker/cloud
operator is within the trust boundary. Configuration names a development bucket;
it does not prove that bucket, a deployment, credentials or a vault installation
exists. Local secret configuration is ignored and must not become project memory.

The runtime/OpenAPI PUT permissiveness difference is a known contract gap, not a
new implementation in this handoff. Resolve and test the documented client-facing
contract in M3 before relying on generated clients. Broader operational limits,
recovery and authentication evolution belong to M5; any prerequisite needed to
prevent data loss in M3/M4 must be addressed in that earlier milestone.

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
