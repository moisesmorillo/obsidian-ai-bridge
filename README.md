# obsidian-ai-bridge

One Obsidian vault, synchronized across Mac, iPad and iPhone through a private Cloudflare Worker, and reachable by authorized AI agents over MCP. This is the intended product, not current behavior: synchronization is not implemented or deployed, and no device behavior or sync measurements are claimed.

## Current status

The F0 foundation is complete and merged in [PR #3](https://github.com/moisesmorillo/obsidian-ai-bridge/pull/3). Its frozen installation, lint, configured typechecks, 49 tests and local builds passed both locally and in actual [push CI](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/38321019882) and [PR CI](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/38321022414).

This is foundation evidence, not qualification of all 44 product acceptance cases. The Worker entry point still has no API routes, and the plugin lifecycle is inert; synchronization and the authorization service are not implemented or deployed. F1 has not started.

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

Completed implementation plans remain historical evidence; the selected task's plan records its current approach. This repository has no separate roadmap or certification report. Local success is not remote CI evidence. Cloudflare resource changes and access to the owner's personal vault require separate explicit authorization; phase dependencies never confer that authorization.

### Selecting work

| Classification | Records | Meaning |
| --- | --- | --- |
| Completed foundation | OAB-1–5 and OAB-22; `Done`, `F0` | Delivered foundation and owner-review corrections, not delivered synchronization |
| Delivery phases | OAB-6–12; `To Do`, `phase-gate`, exact `F1`–`F6`/`F3b` label | Spec §14 entry/exit gates; research and decompose only when selected |
| Trigger-based deferrals | OAB-13–21; `Deferred`, `deferred`, `trigger-based` | Spec §16 items with no committed delivery phase; retain their individual reopening triggers |
| Maintenance | For example OAB-23; `maintenance`, `backlog` | Repository tracking work, not an unlabeled product phase |

Use explicit status and classification filters:

```sh
# All committed phase gates, including those blocked by prerequisites
backlog task list --status 'To Do' --labels phase-gate --plain

# Phase gates whose dependencies are complete: currently only OAB-6 (F1)
backlog task list --status 'To Do' --labels phase-gate --ready --plain

# Optional work waiting for its documented trigger, not a scheduled phase
backlog task list --status Deferred --plain
```

`--ready` measures dependency readiness, not owner authorization or whether a real-use trigger occurred. The current CLI still reports `isReady: true` for dependency-free Deferred items; their status and trigger have not made them scheduled work. Do not use that flag or JSON field alone as the work-selection policy; retain the explicit status and classification filters above. A deferred feature's preserved seam is not the feature itself: F1's blob-reference/storage boundary does not authorize garbage collection, and F3b's baseline exporter does not imply packed archives. Reopening a Deferred item requires evidence of its specific trigger, then research and a reviewed implementation plan; do not invent phase assignments or dependency blockers.
