# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** Milestone 1 / experimental. The authenticated Worker API can store Markdown notes in Cloudflare R2.

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

The plugin is intended to adapt Obsidian's official APIs. The Worker will provide the remote transport and integrate with R2 for durable object storage. MCP is planned as a future adapter, not an implemented feature.

## Goals

- Establish clear boundaries between domain logic, protocol contracts, and platform adapters.
- Build on TypeScript, Bun, Vitest, Cloudflare Workers, R2, and official Obsidian APIs.
- Keep security, data safety, and explicit sync semantics central to future design.
- Make critical logic testable independently of Cloudflare and Obsidian.

## Current limitations

- The Obsidian plugin has no vault or network behavior yet.
- The plugin ID is `ai-bridge`; existing development installs under the former `obsidian-ai-bridge` directory must be reinstalled under the new ID. The scaffold has no persisted plugin state.
- Notes must be Markdown files and are limited to 1 MiB.
- Authentication uses one bearer token; there are no users or device identities.
- There is no synchronization, conflict detection, tombstone, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support.

## Planned components

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
| `mise run check` | Run Biome formatting, linting, assists, type checking, unit tests, and Worker bundle validation. |
| `mise run lint` | Run type-aware Oxlint semantic checks, including deprecated API detection. |
| `mise run test` | Run Vitest unit tests. |
| `mise run typecheck` | Type-check all workspaces. |
| `mise run build` | Bundle the Worker with Wrangler in dry-run mode. |
| `mise run format` | Apply Biome formatting. |
| `mise run dev` | Run local Worker development through Wrangler. |

Use the ignored `mise.local.toml` for credentials, machine-specific settings, or local overrides. Start from `mise.local.toml.example`; never commit the local file or tokens.

## Local Worker development

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge-dev`. Create the Cloudflare bucket once before using a remote deployment or remote R2 development session:

```bash
mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge-dev --config apps/worker/wrangler.jsonc
mise exec -- bunx wrangler secret put OBSIDIAN_BRIDGE_TOKEN --config apps/worker/wrangler.jsonc
```

For local `wrangler dev`, set `OBSIDIAN_BRIDGE_TOKEN` in the ignored `mise.local.toml`, then start the Worker. `mise` supplies the variable to Wrangler; do not create or commit `apps/worker/.dev.vars`. Wrangler is run with Node.js because its local `workerd` proxy does not respond reliably when launched through Bun:

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
docs/
├── api.md
└── architecture.md
```

## Roadmap

1. Operate and refine the M1 Worker API without changing its security invariants.
2. Add the Obsidian adapter and local vault operations.
3. Define synchronization and conflict semantics.
4. Evaluate an MCP adapter after the REST boundary is established.

Dates and feature commitments are intentionally not set while the architecture is being validated.

## Security

This project handles potentially sensitive vault content. M1 is experimental and is not a production security boundary. See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
