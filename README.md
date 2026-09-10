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
- Notes must be Markdown files and are limited to 1 MiB.
- Authentication uses one bearer token; there are no users or device identities.
- There is no synchronization, conflict detection, tombstone, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support.

## Planned components

- `apps/worker` — Cloudflare Worker adapter and infrastructure integration.
- `apps/obsidian-plugin` — Obsidian integration and local vault adapter.
- `packages/core` — platform-independent domain and application logic.
- `packages/protocol` — shared contracts, schemas, API types, and serialization definitions.

## Prerequisites

- [mise](https://mise.jdx.dev/) for the repository toolchain.
- Bun 1.4.2, installed through the committed `.mise.toml` configuration.

Install the declared toolchain with:

```bash
mise install
```

## Local setup

```bash
git clone https://github.com/moisesmorillo/obsidian-ai-bridge.git
cd obsidian-ai-bridge
mise install
bun install --frozen-lockfile
bun run check
```

The repository uses Biome for formatting and linting, TypeScript for type checking, and Vitest for tests.

## Local Worker development

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge-dev`. Create the Cloudflare bucket once before using a remote deployment or remote R2 development session:

```bash
cd apps/worker
bunx wrangler r2 bucket create obsidian-ai-bridge-dev
bunx wrangler secret put OBSIDIAN_BRIDGE_TOKEN
```

For local `wrangler dev`, add `OBSIDIAN_BRIDGE_TOKEN` to the ignored `apps/worker/.dev.vars` file, then start the Worker:

```bash
bun run dev
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

## Repository structure

```text
apps/
├── obsidian-plugin/
└── worker/
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
