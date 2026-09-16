# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** M2 complete / experimental. The plugin remains non-automatic and read-only. **NEXT:** [M3 — Automatic eligible-Markdown remote mirror](docs/milestones/m3-remote-bridge-client-and-publishing.md). Slices 0–6 provide qualified storage primitives, shared contracts, safe public v2 Worker routes, device-local state/configuration, bounded Fetch transport, and independently testable core bootstrap/autosync plus runtime deletion/recreation/rename orchestration, but no connected plugin mirror exists.

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

This diagram is the intended bridge, not a connected system today. The plugin composes only official Obsidian APIs for explicit local inspection; its typed Worker Fetch adapter is not composed into runtime behavior. The independent Worker provides remote transport and R2 storage. MCP is planned, not implemented.

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
- Authentication uses one privileged bearer token; there are no users. Slice 3 device/writer UUIDs are operational safety identities, not an authorization boundary.
- The Worker has conditional format-2 generations, tombstones, and recovery primitives. Slice 4 adds an uncomposed typed Fetch `RemoteBridge`; Slices 5–6 add core-only bootstrap, coalescing, fair path scheduling, finite retry/evidence recovery, bounded inventory reporting, and event-authorized deletion/recreation/rename orchestration. These are not composed into plugin Vault callbacks, settings, or runtime timers. There is still no user-visible automatic sync, remote-to-local behavior, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support.

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
[active M3 design proposal](docs/milestones/m3-remote-bridge-client-and-publishing.md).
The [approved decision brief](docs/plans/m3-design-decisions.md) and
[sequential plan](docs/plans/m3-remote-bridge-client-and-publishing.md) specify
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
Slice 3 adds strict uncomposed plugin-data, native-secret-reference, App-local-state and handoff boundaries plus core activation/state-owner policy. Slice 4 adds a typed bounded v2 Fetch client. Slices 5–6 compose local-read/state/remote capabilities only inside independently testable core policy, including bounded runtime deletion/recreation/rename workflows; they do not compose settings, watchers, runtime timers, or automatic plugin behavior; [M2 completion and slice evidence](docs/plans/m2-obsidian-read-only-local-adapter.md)
record the earlier local-inspection baseline. The roadmap defines the useful product end state, milestone exit criteria and
unresolved decisions. The [current-state audit](docs/current-state.md) links facts
to source/configuration; [API documentation](docs/api.md) describes the implemented
remote contract. Inspect relevant source/tests before coding; implement only the
active milestone. Dates are intentionally not assigned.

## Security

This project handles potentially sensitive vault content. The implemented Worker Slice 2 and local-only plugin remain experimental and are not a production security boundary. See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
