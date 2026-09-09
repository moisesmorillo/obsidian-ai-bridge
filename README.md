# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** Early development / experimental. This repository is a foundation only; product functionality is not implemented yet.

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

## Non-goals for this scaffold

- No Worker API or R2 persistence.
- No Obsidian plugin behavior or vault access.
- No authentication, synchronization, or conflict resolution.
- No MCP implementation.

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
git clone https://github.com/<owner>/obsidian-ai-bridge.git
cd obsidian-ai-bridge
mise install
bun install --frozen-lockfile
bun run check
```

The repository uses Biome for formatting and linting, TypeScript for type checking, and Vitest for tests.

## Repository structure

```text
apps/
├── obsidian-plugin/
└── worker/
packages/
├── core/
└── protocol/
docs/
└── architecture.md
```

## Roadmap

1. Define and validate protocol contracts.
2. Implement isolated domain primitives and security invariants.
3. Add the Obsidian adapter and Worker transport incrementally.
4. Add R2 persistence with explicit authorization and data-safety rules.
5. Evaluate and implement an MCP adapter after the REST boundary is established.

Dates and feature commitments are intentionally not set while the architecture is being validated.

## Security

This project will handle potentially sensitive vault content. Do not use the scaffold with real data as if security features already existed. See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on the repository foundation until product decisions are documented.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
