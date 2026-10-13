# obsidian-ai-bridge

One Obsidian vault, synchronized across Mac, iPad and iPhone through a private Cloudflare Worker, and reachable by authorized AI agents over MCP. This is the intended product, not current behavior: synchronization is not implemented or deployed, and no device behavior or sync measurements are claimed.

## Current status

The F0 foundation is under implementation. The Worker entry point has no API routes, and the plugin lifecycle is inert; there is no sync, authorization service, or deployed service yet. Implemented local checks do not establish remote CI success: OAB-2 remains in progress pending remote CI evidence, and final branch gates remain pending. F0 and CI are not declared complete here.

## Local development

Install the repository-pinned Bun and Node versions with mise:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
```

`bun run check` runs Biome formatting/lint checks, TypeScript checks for all workspaces, Vitest suites, and package builds. It includes a Wrangler dry-run build only; it does not deploy or modify Cloudflare resources. The current workspace responsibilities are:

- `apps/worker`: Cloudflare Worker entry point (Hono); API and synchronization behavior are not implemented.
- `apps/plugin`: Obsidian plugin artifact and lifecycle; synchronization behavior is not implemented.
- `packages/protocol`: shared Zod protocol schemas and types that define identity contracts for future Worker/plugin interfaces and are currently exercised by tests; the production entry points do not yet import or use these wire interfaces.

## Project records

- [`docs/spec.md`](docs/spec.md) is the product contract and phase-gate authority.
- Backlog tasks in `backlog/` record committed work, current status, dependencies, and evidence, including deferred work; they are not a second product specification.
- Linked plans record the current implementation approach for selected work. Later phases will be researched, decomposed, and planned when selected; no future phase implementation is authorized by this README or its tracking tasks.
- [`AGENTS.md`](AGENTS.md) defines repository workflow and constraints.

The current F0 implementation approach is linked from its Backlog task; this repository has no separate roadmap or certification report. Local success is not remote CI evidence and does not pass final branch gates. Cloudflare resource changes and access to the owner's personal vault require separate explicit authorization; phase dependencies never confer that authorization.
