# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** M2 complete / experimental. The plugin provides local-only, read-only inspection; the independent M1 Worker provides authenticated R2 storage. **NEXT (planning only):** [M3 — Remote bridge client and explicit publishing](docs/milestones/m3-remote-bridge-client-and-publishing.md).

## Motivation

Obsidian vaults are valuable local knowledge stores. The project will explore a carefully bounded way for remote AI and agent clients to interact with vault data without coupling domain logic to a specific transport or hosting platform.

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

This diagram is the intended bridge, not a connected system today. The plugin uses official Obsidian APIs for explicit local inspection only; it makes no Worker calls. The independent Worker provides remote transport and R2 storage. MCP is planned, not implemented.

## Goals

- Establish clear boundaries between domain logic, protocol contracts, and platform adapters.
- Build on TypeScript, Bun, Vitest, Cloudflare Workers, R2, and official Obsidian APIs.
- Keep security, data safety, and explicit sync semantics central to future design.
- Make critical logic testable independently of Cloudflare and Obsidian.

## Current limitations

- The plugin explicitly lists eligible saved-note metadata and inspects the active saved note; it never shows note bodies, mutates notes, makes network requests or persists settings. Enabling alone performs no inspection.
- Local eligibility excludes dot-prefixed segments and the host configuration directory; literal paths are not URI-decoded. Inspection is not upload consent. Reads use best-effort change detection, not atomic snapshots or editor buffers.
- The plugin ID is `ai-bridge`. See [disposable-vault installation/removal and compatibility evidence](docs/plugin-development.md). No real Obsidian desktop/mobile host has been tested.
- Notes must be Markdown files and are limited to 1 MiB.
- Authentication uses one bearer token; there are no users or device identities.
- There is no synchronization, conflict detection, tombstone, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support.

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
| `mise run lint` | Run type-aware Oxlint semantic checks, including deprecated API detection. |
| `mise run test` | Run the fast Vitest test suite without coverage. |
| `mise run coverage` | Run the Vitest suite with V8 coverage and enforce global thresholds. |
| `mise run typecheck` | Type-check all workspaces. |
| `mise run build` | Bundle the Worker with Wrangler in dry-run mode, stage the CommonJS plugin/manifest and run artifact smoke tests. |
| `mise run plugin:smoke` | Rebuild the plugin and load the actual bundle with an isolated Obsidian host double. |
| `mise run format` | Apply Biome formatting. |
| `mise run dev` | Run local Worker development through Wrangler. |

`mise run test` is the fast normal developer test command. `mise run coverage`
runs the same suite with coverage reporting and threshold enforcement, while
`mise run check` is the complete quality gate.

Tests live in dedicated `tests/` trees outside production `src/` trees. Isolated
behavior belongs under `tests/unit/`; tests that intentionally compose multiple
application layers belong under `tests/integration/`.

Use `.mise.toml` for shared non-sensitive configuration. Use the ignored `mise.local.toml` for credentials, machine-specific settings, or local overrides. Start from `mise.local.toml.example`; never commit the local file or tokens. The repository does not use `.env` files.

## Local plugin development

After installation, run `mise run plugin:smoke`. The generated
`apps/obsidian-plugin/dist/main.js` and `manifest.json` can be deliberately copied
into a **disposable** development vault; see the complete
[install, command, unload and removal instructions](docs/plugin-development.md).
The commands are **AI Bridge: Inspect local Markdown notes** and
**AI Bridge: Inspect active Markdown note**. Results show paths/byte metadata only.
Active inspection reads saved text; save and retry for unsaved changes. No Worker,
credentials or deployment are needed. The automated smoke check is not a real-host
or mobile compatibility test.

## Local Worker development

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge-dev`. Create the Cloudflare bucket once before using a remote deployment or remote R2 development session:

```bash
mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge-dev --config apps/worker/wrangler.jsonc
mise exec -- bunx wrangler secret put OBSIDIAN_BRIDGE_TOKEN --config apps/worker/wrangler.jsonc
```

For local `wrangler dev`, set `OBSIDIAN_BRIDGE_TOKEN` under `[env]` in the ignored `mise.local.toml`, then start the Worker. Wrangler 4.130.0 declares this name through `secrets.required`; it loads the matching process environment value supplied by mise and warns when it is missing. Do not create or commit `apps/worker/.dev.vars`. Wrangler is run with Node.js because its local `workerd` proxy does not respond reliably when launched through Bun:

```bash
mise run dev
```

Wrangler provides local R2 emulation for the binding during local development. The API details are in [docs/api.md](docs/api.md).

## M1 API

| Method | Path | Authentication |
| --- | --- | --- |
| GET | `/health` | None |
| GET | `/api/v1/notes` | Bearer token |
| GET | `/api/v1/notes/:path` | Bearer token |
| PUT | `/api/v1/notes/:path` | Bearer token |
| DELETE | `/api/v1/notes/:path` | Bearer token |
| GET | `/openapi.json` | None |
| GET | `/docs` | None |

For note item routes, `:path` is a canonical base64url-encoded note path. See [docs/api.md](docs/api.md) for the encoding example.

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
[canonical roadmap and agent onboarding](docs/roadmap.md), then the
[active M3 planning handoff](docs/milestones/m3-remote-bridge-client-and-publishing.md).
M3 requires specification refinement and an implementation plan before coding;
[M2 completion and slice evidence](docs/plans/m2-obsidian-read-only-local-adapter.md)
record the implemented baseline. The roadmap defines the useful product end state, milestone exit criteria and
unresolved decisions. The [current-state audit](docs/current-state.md) links facts
to source/configuration; [API documentation](docs/api.md) describes the implemented
remote contract. Inspect relevant source/tests before coding; implement only the
active milestone. Dates are intentionally not assigned.

## Security

This project handles potentially sensitive vault content. M1 is experimental and is not a production security boundary. See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
