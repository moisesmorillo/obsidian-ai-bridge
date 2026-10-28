# obsidian-ai-bridge

The project implements a private Cloudflare Worker with SQLite Vault authority, conditional file operations, history, search, blob storage, bounded reads, OAuth, MCP, and an owner console. The F2 Worker is deployed at `https://obsidian-bridge.mmorillo.dev`.

## Current status

Independent public checks on 2026-10-28 confirmed canonical OAuth discovery, Access login redirection for `/authorize`, denial for unauthenticated REST and MCP requests, OAuth protocol errors for invalid registration and token requests, and no service responses from the known `workers.dev` hostname. The `/owner` root returned `404`; the implemented owner route is `/owner/clients`. The configured preview URL setting is false, and deployment output emitted no preview URL.

Public deployment evidence for OAB-7.7 is recorded. These checks do not prove Access policy contents, successful login or consent, authenticated vault operations, revocation, plugin behavior, or device behavior. The owner subject remains unconfirmed against an Access assertion. OAB-7.8 and full F2 exit remain open.

## Local development

Install the repository-pinned Bun and Node versions with mise:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
```

`bun run check` runs Biome formatting/lint checks, TypeScript checks for all workspaces, Vitest suites, and package builds. It includes a Wrangler dry-run build only; it does not deploy or modify Cloudflare resources. The current workspace responsibilities are:

- `apps/worker`: Cloudflare Worker routes, SQLite Vault authority, blob reads and writes, history, search, and conditional mutation behavior.
- `apps/plugin`: Obsidian plugin artifact and lifecycle; synchronization behavior is not implemented.
- `packages/protocol`: canonical Zod schemas, derived types, and codecs shared by Worker interfaces.

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
