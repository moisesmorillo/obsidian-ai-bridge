# obsidian-ai-bridge

A secure bridge between Obsidian and remote AI or agent clients.

> **Status:** M1–M4 are **COMPLETE** and [M5 — Operational and security readiness](docs/roadmap.md#m5--operational-and-security-readiness) remains the single **NEXT** milestone. M5 Slices 0–4 are complete: the Worker now authenticates only through the strict bounded digest-only credential registry, enforces independent route permissions, exposes only v2 authenticated operations, and emits client-attributed content-free live diagnostics. Slice 5 is next, but Slice 5–6 qualification remains blocked despite the merged host-visible preservation fix: the listener-gap safety correction in [ADR 0013](docs/decisions/0013-listener-ready-effect-authority-and-observation-gap-recovery.md) is design only, and full qualification must be rerun; there is no current support claim. The bridge remains experimental and undeployed. No personal-vault installation, full real-desktop/mobile/iCloud/background-iOS qualification, or production-readiness claim is made.

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

Completed M3 connects this outward path in the generated plugin: an explicitly activated designated writer observes official saved-file events and uses the conditional v2 Worker API. Completed M4 adds qualified explicit reviewed remote-to-local actions, not automatic bidirectional synchronization. M5 Slices 2–4 add named registry-only authentication/lifecycle, independent route permission enforcement, v1 retirement, and live client-attributed diagnostics, but not operational readiness. The system remains experimental and undeployed; it has no MCP or production certification. Real-host evidence is limited to the isolated corrective preservation-root and Keep-local scenario, not complete desktop/mobile qualification.

## Goals

- Establish clear boundaries between domain logic, protocol contracts, and platform adapters.
- Build on TypeScript, Bun, Vitest, Cloudflare Workers, R2, and official Obsidian APIs.
- Keep security, data safety, and explicit sync semantics central to future design.
- Make critical logic testable independently of Cloudflare and Obsidian.

## Current limitations

- After explicit whole-scope consent, one configured designated writer automatically mirrors eligible saved Markdown outward. Unconfigured, disabled, and non-writer instances remain passive. M2 metadata-only inspection commands remain available and independent.
- Local eligibility excludes dot-prefixed segments, the host configuration directory, and the exact current/historical conflict-preservation namespaces `ai-bridge-conflicts` and `.ai-bridge-conflicts`; prefix-sharing ordinary names remain eligible. Literal paths are not URI-decoded. Reads use best-effort change detection, not atomic snapshots or editor buffers. Notes are limited to 1 MiB.
- The plugin ID is `ai-bridge`. See [disposable-vault qualification guidance](docs/plugin-development.md). Corrective isolated Obsidian desktop evidence covers only the replacement preservation root and one Keep-local path; no complete desktop, mobile or iCloud qualification has been performed.
- Authentication resolves a named client principal only from a strict registry of at most 16 domain-separated token digests. Raw client tokens remain only in approved client secret stores. One exhaustive operation policy enforces independent `read`, `write`, and `delete` permissions before service/storage dispatch; `write` never implies `delete`. The designated writer credential needs all three for current M3/M4 behavior. Live content-free diagnostics identify authenticated client IDs and closed operation/outcome categories, with zero-day retention and no audit-trail claim. Association/writer UUIDs remain separate non-secret cooperating-writer guards.
- iCloud remains working-vault device sync. The plugin sees host events rather than a transactional iCloud log; missed/offline absences never grant deletion authority, so some deletions require later reconciliation.
- M3 itself has no remote-to-local behavior. M4 adds explicit reviewed reconciliation, text-only recovery selection, and bounded deferred-history cleanup, but no automatic takeover, automatic bidirectional conflict resolution, scheduled cleanup, search, MCP, D1, Durable Objects, Workers AI, or Vectorize support. The [operator guide](docs/operations.md) describes review, restoration, setup, recovery, handoff, rotation, migration, and rollback restrictions.

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

The Worker uses a `VAULT_BUCKET` R2 binding configured for `obsidian-ai-bridge-dev`. Create the Cloudflare bucket once before using a remote deployment or remote R2 development session:

```bash
mise exec -- bunx wrangler r2 bucket create obsidian-ai-bridge-dev --config apps/worker/wrangler.jsonc
mise exec -- bunx wrangler secret put OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY --config apps/worker/wrangler.jsonc
```

Use `mise run credentials -- create` to build a registry file outside the repository and display a fresh raw token once in an interactive terminal; see the [credential lifecycle and migration procedure](docs/operations.md#credential-registry-lifecycle-and-singleton-migration). For local `wrangler dev`, set `OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY` under `[env]` in the ignored `mise.local.toml` only for local development. Registry authentication is the sole runtime mode; `OBSIDIAN_BRIDGE_TOKEN` and `OBSIDIAN_BRIDGE_AUTH_MODE` are retired. Wrangler 4.130.0 declares the registry secret through `secrets.required`. The committed development configuration also contains canonical non-secret `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID` UUID-v4 examples; operators must deliberately replace them together when configuring their own namespace/designated writer. Invalid auth configuration fails all authenticated requests closed; invalid or missing designation IDs fail v2 mutations closed. Do not create `apps/worker/.dev.vars`, and never commit raw tokens or digest registries. Wrangler is run with Node.js because its local `workerd` proxy does not respond reliably when launched through Bun:

```bash
mise run dev
```

Wrangler provides local R2 emulation for the binding during local development. The API details are in [docs/api.md](docs/api.md).

## Worker API

The Worker exposes public health/OpenAPI/Scalar routes and authenticated conditional v2 mirror/current/recovery routes. The v1 HTTP API, including its former read and retired-mutation compatibility routes, is no longer registered. V2 note PUT/DELETE and recovery seal/purge require the configured association/writer IDs, one operation UUID, and the documented exact conditional header. Recovery metadata and content use distinct GET endpoints.

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
completed [M4 specification](docs/milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
and [sequential plan](docs/plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md).
M4 Slices 1–8 implement and qualify the closed contracts, strict v2→v3→v4 migration
fence, review/admission, narrow local write/conflict preservation, live/adoption/
tombstone/recovery execution, bounded parent-owned history steps, step-scoped
preservation, and shared runtime/session/command/modal/status composition.
[ADR 0009](docs/decisions/0009-m4-history-runtime-and-device-state-v4.md) defines the v4
compatibility transition and conservative event authority. M5 is NEXT with completed Slices 0–4; Slice 5 is next. Its
[planning specification](docs/milestones/m5-operational-and-security-readiness.md),
[consolidated threat model](docs/threat-model.md),
[credential/permission ADR](docs/decisions/0010-scoped-client-credentials-and-permissions.md),
and [operational-policy ADR](docs/decisions/0011-m5-operational-envelope.md)
define the accepted client model and operating policy. Slice 2 implements the bounded
digest-only registry, typed principal resolution, offline lifecycle tooling, and the
historical singleton migration checkpoint. Slice 3 adds client-ID, closed-operation,
authentication, status, and stable-error attribution to content-free live diagnostics
without durable retention. Slice 4 activates registry-only authentication, enforces
independent route permissions, and retires every v1 HTTP route/OpenAPI contract. The
10,000-note value is a later desktop qualification target, not current support. The completed
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

This project handles potentially sensitive vault content. The connected outward M3 runtime remains experimental and is not a production security boundary or certification. See [SECURITY.md](SECURITY.md), the [consolidated threat model](docs/threat-model.md), and the [operator guide](docs/operations.md).

## Contributing

Contributions are welcome while the project is experimental. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and keep changes focused on documented milestones.

## License

MIT © Moisés Morillo. See [LICENSE](LICENSE).
