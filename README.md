# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** M3 automatic eligible-Markdown mirroring is **COMPLETE** on PR #27; the transition becomes canonical when that PR is merged. **NEXT:** [M4 — Remote-to-local reconciliation and conflict resolution](docs/milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md), currently planning only. M3 remains experimental and undeployed, with no personal-vault installation, real-host/iCloud qualification, production-readiness, or remote-to-local claim.

## Motivation

The intended product automatically mirrors **all eligible saved Markdown notes**
from Obsidian to a private Worker/R2 service after whole-mirror opt-in. One designated
device writes the mirror; iCloud remains device-to-device vault sync. Remote API and
future MCP authorization are separate from mirror scope. R2 is not the sole source
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

Completed M3 connects this outward path in the generated plugin: an explicitly activated designated writer observes official saved-file events and uses the conditional v2 Worker API. The system remains experimental and undeployed; it has no remote-to-local synchronization, MCP, production certification, or real Obsidian desktop/mobile qualification.

## Goals

- Establish clear boundaries between domain logic, protocol contracts, and platform adapters.
- Build on TypeScript, Bun, Vitest, Cloudflare Workers, R2, and official Obsidian APIs.
- Keep security, data safety, and explicit sync semantics central to future design.
- Make critical logic testable independently of Cloudflare and Obsidian.

## Current limitations

- After explicit whole-scope consent, one configured designated writer automatically mirrors eligible saved Markdown outward. Unconfigured, disabled, and non-writer instances remain passive. M2 metadata-only inspection commands remain available and independent.
- Local eligibility excludes dot-prefixed segments and the host configuration directory; literal paths are not URI-decoded. Reads use best-effort change detection, not atomic snapshots or editor buffers. Notes are limited to 1 MiB.
- The plugin ID is `ai-bridge`. See [disposable-vault qualification guidance](docs/plugin-development.md). No real Obsidian desktop/mobile host or iCloud event trace has been tested.
- Authentication uses one privileged bearer token; there are no users. Association/writer UUIDs are non-secret cooperating-writer guards, not authorization. Trusted host/plugin/Worker/cloud operators can read plaintext.
- iCloud remains working-vault device sync. The plugin sees host events rather than a transactional iCloud log; missed/offline absences never grant deletion authority, so some deletions require later reconciliation.
- M3 has no remote-to-local behavior, automatic takeover, conflict resolution, richer restore UI, scheduled cleanup, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support. The [operator guide](docs/operations.md) describes setup, recovery, handoff, rotation, and rollback restrictions.

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
| `mise run worker:storage-test` | Qualify conditional R2 semantics in the pinned local workerd runtime. |
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
`apps/obsidian-plugin/dist/main.js` and `manifest.json` may be copied only into a
**disposable** development vault; see the complete [qualification, configuration,
unload and removal instructions](docs/plugin-development.md). M2 inspection commands
remain metadata-only. M3 adds declarative connection/writer settings and automatic
saved-event mirroring only after strict configuration, designation verification, and
whole-scope consent. The automated artifact suite is not a real-host or mobile
compatibility test; no Worker deployment or personal-vault installation is required
for canonical validation.

## Local Worker development

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge-dev`. Create the Cloudflare bucket once before using a remote deployment or remote R2 development session:

```bash
mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge-dev --config apps/worker/wrangler.jsonc
mise exec -- bunx wrangler secret put OBSIDIAN_BRIDGE_TOKEN --config apps/worker/wrangler.jsonc
```

For local `wrangler dev`, set `OBSIDIAN_BRIDGE_TOKEN` under `[env]` in the ignored `mise.local.toml`, then start the Worker. Wrangler 4.130.0 declares this name through `secrets.required`; it loads the matching process environment value supplied by mise and warns when it is missing. The committed development configuration also contains canonical non-secret `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID` UUID-v4 examples; operators must deliberately replace them together when configuring their own namespace/designated writer. Invalid or missing IDs fail v2 mutations closed. Do not create or commit `apps/worker/.dev.vars`. Wrangler is run with Node.js because its local `workerd` proxy does not respond reliably when launched through Bun:

```bash
mise run dev
```

Wrangler provides local R2 emulation for the binding during local development. The API details are in [docs/api.md](docs/api.md).

## Worker API

The Worker exposes public health/OpenAPI/Scalar routes, authenticated envelope-aware v1 reads, and authenticated conditional v2 mirror/current/recovery routes. Unsafe v1 PUT and DELETE now return `410 mutation_api_retired` without storage mutation. V2 note PUT/DELETE and recovery seal/purge require the configured association/writer IDs, one operation UUID, and the documented exact conditional header. Recovery metadata and content use distinct GET endpoints.

For note item routes, `:path` is a canonical base64url-encoded note path. See [docs/api.md](docs/api.md) for the complete route/status/header contract and encoding example.

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
[active M4 planning specification](docs/milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md).
The completed [M3 specification](docs/milestones/m3-remote-bridge-client-and-publishing.md),
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

This project handles potentially sensitive vault content. The connected outward M3 runtime remains experimental and is not a production security boundary or certification. See [SECURITY.md](SECURITY.md) and the [operator guide](docs/operations.md).

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
