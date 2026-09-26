# obsidian-ai-bridge

A data-safety-focused bridge between Obsidian and authorized remote AI or agent clients.

> **Status:** M1–M6 are **COMPLETE** in the current transition; [M6 — MCP adapter](docs/roadmap.md#m6--mcp-adapter)
> is the final defined milestone. The transition becomes canonical when its completion
> PR merges; no M7 is defined. M5 qualifies only the latest M5-ready release,
> **v1.0.2**, for one designated active writer on Obsidian Desktop 1.13.7 / macOS
> 26.6.2 / Apple M4 Pro, with synthetic-vault scale through 10,000 eligible Markdown
> notes. See the [final M5 qualification report](docs/qualification/m5-final.md) and
> [operating envelope](docs/operations.md#current-m5-qualification-and-support).
> This is a narrow software-support claim, not security certification, production-
> service approval, or a complete-backup guarantee. M6 adds a Worker MCP adapter over
> existing M5 authentication and application services; it does not change M5's plugin
> support claim, imply deployment, or claim MCP OAuth authorization conformance.
> M6's [specification](docs/milestones/m6-mcp-adapter.md) and [qualification report](docs/qualification/m6-final.md)
> record its exact limits and evidence. No personal vault or production resource was
> used. Mobile, Intel macOS, Windows/Linux writers, iCloud event ordering, background
> iOS, other desktop versions, and deployed Worker/R2 behavior remain unqualified.
> The v1.0.2 GitHub release has no downloadable binary assets; the qualified plugin
> artifact is source-built and reproducible.

## Motivation

The intended product automatically mirrors **all eligible saved Markdown notes**
from Obsidian to a private Worker/R2 service after whole-mirror opt-in. One designated
device writes the mirror; iCloud remains device-to-device vault sync. Remote API and
MCP authorization is separate from mirror scope. R2 is not the sole source
of truth or a guaranteed full backup; NAS replication/stronger remote authority are
future possibilities, not implemented features.

## Architecture

```text
Obsidian
   |
Obsidian Plugin
   |
Cloudflare Worker
   |
Cloudflare R2
```

Completed M3 connects this outward path in the generated plugin: an explicitly activated designated writer observes official saved-file events and uses the conditional v2 Worker API. Completed M4 adds explicit reviewed remote-to-local actions, strict state-v5 observation-gap fencing, and dispatch-boundary lease checks—not automatic bidirectional synchronization. M5 completes registry-only authentication/lifecycle, independent route permissions, v1 retirement, content-free live diagnostics, operational runbooks, and bounded release qualification. The only M5 software-support claim is v1.0.2 within the exact [documented envelope](docs/operations.md#current-m5-qualification-and-support); M6 adds a bounded Worker MCP adapter using the existing authentication and application-service boundary. This is not MCP OAuth conformance, security certification, production-service approval, or deployment. The [final qualification report](docs/qualification/m5-final.md) distinguishes the qualified 10,000-note desktop profile from unqualified platforms and event traces.

## Goals

- Establish clear boundaries between domain logic, protocol contracts, and platform adapters.
- Build on TypeScript, Bun, Vitest, Cloudflare Workers, R2, and official Obsidian APIs.
- Keep security, data safety, and explicit sync semantics central to future design.
- Make critical logic testable independently of Cloudflare and Obsidian.

## Current limitations

- After explicit whole-scope consent, one configured designated writer automatically mirrors eligible saved Markdown outward. Unconfigured, disabled, and non-writer instances remain passive. M2 metadata-only inspection commands remain available and independent.
- Local eligibility excludes dot-prefixed segments, the host configuration directory, and the exact current/historical conflict-preservation namespaces `ai-bridge-conflicts` and `.ai-bridge-conflicts`; prefix-sharing ordinary names remain eligible. Literal paths are not URI-decoded. Reads use best-effort change detection, not atomic snapshots or editor buffers. Notes are limited to 1 MiB.
- The plugin ID is `ai-bridge`. The [M5 qualification report](docs/qualification/m5-final.md) records active-writer, migration/restart, and artifact evidence through 10,000 synthetic notes on the single qualified Obsidian/macOS desktop profile, plus retained Keep-local and credential-rotation evidence. This does not qualify other desktop versions, mobile, iCloud event ordering, background iOS, or a deployed Worker/R2. Never use a personal or production vault for manual qualification; see [disposable-vault guidance](docs/plugin-development.md).
- Authentication resolves a named client principal only from a strict registry of at most 16 domain-separated token digests. Raw client tokens remain only in approved client secret stores. Exhaustive HTTP and MCP operation policies enforce independent `read`, `write`, and `delete` permissions before service/storage dispatch; `write` never implies `delete`. M5's designated writer credential needs all three for M3/M4 behavior. Live content-free diagnostics identify authenticated client IDs and closed operation/outcome categories, with zero-day retention and no audit-trail claim. Association/writer UUIDs remain separate non-secret cooperating-writer guards.
- iCloud remains working-vault device sync. The plugin sees host events rather than a transactional iCloud log; missed/offline absences never grant deletion authority, so some deletions require later reconciliation.
- M3 itself has no remote-to-local behavior. M4 adds explicit reviewed reconciliation, text-only recovery selection, and bounded deferred-history cleanup, but no automatic takeover, automatic bidirectional conflict resolution, or scheduled cleanup. M6's separately authorized MCP interface does not expose reconciliation or local-vault mutation. There is no search, D1, Durable Objects, Workers AI, or Vectorize support. The [operator guide](docs/operations.md) describes review, restoration, setup, recovery, handoff, rotation, migration, and rollback restrictions.

## Workspace components

- `apps/worker` — Cloudflare Worker adapter and infrastructure integration.
- `apps/obsidian-plugin` — Obsidian integration and local vault adapter.
- `packages/core` — platform-independent domain and application logic.
- `packages/protocol` — shared contracts, schemas, API types, and serialization definitions.

## Development

[mise](https://mise.jdx.dev/installing-mise.html) is required. Install it using the official instructions, then verify it is available:

```bash
mise --version
```

From a clean clone, install the committed Bun and Node.js toolchains and locked workspace dependencies:

```bash
git clone https://github.com/moisesmorillo/obsidian-ai-bridge.git
cd obsidian-ai-bridge
mise install
mise run install
```

`mise` is the canonical task runner. The normal workflow is:

| Task | Purpose |
| --- | --- |
| `mise run check` | Run Biome formatting, linting, assists, type checking, coverage-enforced tests, and both application bundle validations. |
| `mise run lint` | Run TSDoc presence and type-aware Oxlint semantic checks, including deprecated API detection. |
| `mise run tsdoc:check` | Check associated TSDoc presence across production TypeScript. |
| `mise run test` | Run the fast Vitest test suite without coverage. |
| `mise run worker:storage-test` | Qualify conditional R2 semantics in the pinned local workerd runtime. |
| `mise run coverage` | Run the Vitest suite with V8 coverage and enforce global thresholds. |
| `mise run typecheck` | Type-check all workspaces. |
| `mise run build` | Bundle the Worker with Wrangler in dry-run mode, stage the CommonJS plugin/manifest and run artifact smoke tests. |
| `mise run plugin:smoke` | Rebuild the plugin and load the actual bundle with an isolated Obsidian host double. |
| `mise run format` | Apply Biome formatting. |
| `mise run dev` | Run local Worker development through Wrangler. |

`mise run test` is the fast normal developer test command. `mise run coverage`
runs the same suite with coverage reporting and threshold enforcement, while
`mise run check` is the authoritative validation command. Production TypeScript uses
TSDoc for named semantic declarations, including internals. The quality gate enforces
documentation presence; semantic accuracy and usefulness remain review responsibilities.
See [AGENTS.md](AGENTS.md#documentation-comments) for the policy and enforcement boundary.

Tests live in dedicated `tests/` trees outside production `src/` trees. Isolated
behavior belongs under `tests/unit/`; tests that intentionally compose multiple
application layers belong under `tests/integration/`.

Use `.mise.toml` for shared non-sensitive configuration. Use the ignored `mise.local.toml` for credentials, machine-specific settings, or local overrides. Start from `mise.local.toml.example`; never commit the local file or tokens. The repository does not use `.env` files.

## Local plugin development

After installation, run `mise run plugin:smoke`. The generated
`apps/obsidian-plugin/dist/main.js` and `manifest.json` may be copied only into a
**disposable** development vault; see the complete [qualification, configuration,
unload and removal instructions](docs/plugin-development.md). M2 inspection commands
remain metadata-only. M3 adds declarative connection/writer settings and automatic
saved-event mirroring only after strict configuration, designation verification, and
whole-scope consent. The automated artifact suite is not a real-host or mobile
compatibility test; no Worker deployment or personal-vault installation is required
for canonical validation.

## Local Worker development

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge`.
Local `wrangler dev` uses an R2 emulator. For a remote deployment, first verify that
the target Cloudflare account has an empty bucket with that name; create it only if
needed:

```bash
mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge --config apps/worker/wrangler.jsonc
```

Use `mise run credentials -- create` to build a registry file outside the repository and display a fresh raw token once in an interactive terminal; see the [credential lifecycle and migration procedure](docs/operations.md#credential-registry-lifecycle-and-singleton-migration). For local `wrangler dev`, set `OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY` under `[env]` in the ignored `mise.local.toml` only for local development. Registry authentication is the sole runtime mode; `OBSIDIAN_BRIDGE_TOKEN` and `OBSIDIAN_BRIDGE_AUTH_MODE` are retired. An initial Worker deploy may omit the registry secret; supported protected HTTP and MCP operations then return `401` until it is provisioned, with no legacy fallback. The committed configuration intentionally has no `MIRROR_ASSOCIATION_ID` or `MIRROR_WRITER_ID`; authenticated reads remain available only after registry provisioning, and v2 mutations fail closed until operators deliberately configure a real association and the plugin-generated writer ID. Do not create `apps/worker/.dev.vars`, and never commit raw tokens or digest registries. Wrangler is run with Node.js because its local `workerd` proxy does not respond reliably when launched through Bun:

```bash
mise run dev
```

Wrangler provides local R2 emulation for the binding during local development. The API details are in [docs/api.md](docs/api.md).

The first Worker deployment was performed manually. Later stable releases deploy
automatically through GitHub Actions; manual runs remain available. See the
[release deployment procedure](docs/operations.md#staged-release-deployment).

## Worker API

The Worker exposes authenticated conditional v2 mirror/current/recovery routes. `/health` is not registered. OpenAPI and Scalar are available through `mise run dev` locally; `/openapi.json` and `/docs` return `404` in the deployed Worker. The v1 HTTP API, including its former read and retired-mutation compatibility routes, is no longer registered. V2 note PUT/DELETE and recovery seal/purge require the configured association/writer IDs, one operation UUID, and the documented exact conditional header. Recovery metadata and content use distinct GET endpoints.

For note item routes, `:path` is a canonical base64url-encoded note path. The separate stateless MCP endpoint is `POST /mcp`; its bearer-authenticated tools and explicit content resources reuse the existing Worker services and independent permission table, and do not implement MCP OAuth discovery. See [docs/api.md](docs/api.md) for the complete route/status/header contract and encoding example.

## Repository structure

```text
apps/
├── obsidian-plugin/
└── worker/              Hono HTTP adapter and Cloudflare R2 integration
packages/
├── core/
└── protocol/
docs/                   Architecture, API, current-state audit, roadmap,
                        milestone specifications and decision records
```

## Project memory and next work

Start with [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), the
[canonical roadmap and agent onboarding](docs/roadmap.md), and the completed
[M5 specification](docs/milestones/m5-operational-and-security-readiness.md) with its
[final qualification evidence](docs/qualification/m5-final.md). M1–M6 are complete in
this transition, with no milestone marked NEXT and no M7 defined. The accepted
[ADR 0014](docs/decisions/0014-stateless-mcp-adapter-and-existing-credentials.md),
completed [M6 specification](docs/milestones/m6-mcp-adapter.md), and [M6 qualification
report](docs/qualification/m6-final.md) record the adapter and its residual limits.
M5's current supported release, exact host/scale envelope, residual limits, and all A1–A12 evidence are in
the report and [operator guide](docs/operations.md#current-m5-qualification-and-support).
The [M5 threat model](docs/threat-model.md), [credential/permission ADR](docs/decisions/0010-scoped-client-credentials-and-permissions.md),
and [operational-policy ADR](docs/decisions/0011-m5-operational-envelope.md) record
its accepted boundaries. The completed
[M3 specification](docs/milestones/m3-remote-bridge-client-and-publishing.md),
[approved decision brief](docs/plans/m3-design-decisions.md), and
[sequential plan](docs/plans/m3-remote-bridge-client-and-publishing.md) record
automatic bootstrap/saved-file events, per-path state, safe conditional mutations,
recoverable runtime deletes/renames and explicit single-writer handoff. The
[Slice 0 qualification](docs/qualification/m3-slice-0-platform-primitives.md)
proves required predicates in the pinned local workerd runtime and records host
declaration availability without claiming real desktop/mobile testing. There is
no per-note selection model. M3 Slice 1 raises the plugin baseline to Obsidian **1.13.0** for native
SecretStorage and declarative settings, while preserving the existing M2 commands.
Slice 1 adds shared typed contracts only. Worker Slice 2A–2C adds private format-2
codecs, conditional R2 adapters, application current/recovery orchestration, safe
public v2 HTTP/OpenAPI/CORS, envelope-aware v1 reads and v1 mutation retirement.
Slice 3 adds strict plugin-data, native-secret-reference, App-local-state and handoff boundaries plus core activation/state-owner policy. Slice 4 adds a typed bounded v2 Fetch client; Slices 5–6 provide bounded core autosync and lifecycle policy; Slice 7 composes modern settings, official Vault events, layout-ready bootstrap, timers, Fetch, and same-realm runtime ownership. Slice 8 adds proportional generated-artifact qualification and the [M3 operator guide](docs/operations.md). [M2 completion and slice evidence](docs/plans/m2-obsidian-read-only-local-adapter.md)
record the earlier local-inspection baseline. The roadmap defines the useful product end state, milestone exit criteria and
unresolved decisions. The [current-state audit](docs/current-state.md) links facts
to source/configuration; [API documentation](docs/api.md) describes the implemented
remote contract. Inspect relevant source/tests before coding; implement only the
active milestone. Dates are intentionally not assigned.

## Security

This project handles potentially sensitive vault content. M5's v1.0.2 software support is limited to the exact documented envelope; it is not a production security boundary, security certification, or complete backup. See [SECURITY.md](SECURITY.md), the [consolidated threat model](docs/threat-model.md), and the [operator guide](docs/operations.md).

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
