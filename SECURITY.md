# Security policy

Security and data safety are priorities for this project. The repository is in early development and does not yet provide a complete secure bridge or production-ready synchronization behavior.

## Current trust and data-safety boundary

The Worker uses one bearer token granting all remote note operations in one R2
namespace. Authenticated v1 PUT and DELETE are retired with storage-free 410
responses. Worker Slice 2 implements conditional v2 generations, recovery-first
tombstones, 30-day recovery sealing and conditional purge markers without native
R2 DELETE or unconditional mutation capability. This server subset is still not a
connected or production-ready synchronization system. The Worker/cloud operator can
read stored note text; there is no application-level end-to-end encryption,
per-client permission model or production security claim.

Keep tokens in ignored local configuration or the Worker secret mechanism, never
in committed files or diagnostics. Do not log note content, concrete note paths,
credentials or raw failures. Configuration is not evidence of deployed resources.
The M2 plugin performs only deliberate local read-only inspection through official
Obsidian APIs. Enabling alone does not enumerate/read notes. Commands show exact
paths and byte metadata as text, never note bodies; failures are sanitized and no
plugin diagnostic logging is added. Eligibility requires literal safe lowercase
`.md` paths at most 1 MiB, excludes dot-prefixed path segments and the host's
configuration subtree, and never authorizes future upload. The plugin has no
network calls, settings/token storage, persistence, editor saves, watchers or
vault mutation. Installation and Obsidian's enabled-plugin configuration are
explicit host/developer actions, not product writes.

Saved reads check size before access, actual UTF-8 length after access, and
identity/path/size/mtime changes around the await. This is not an atomic snapshot:
same-size edits with indistinguishable timestamps can evade detection. Unload
suppresses late results but cannot cancel host reads; re-enabled commands remain
excluded until that pending operation settles. Paths shown in deliberate local UI
remain sensitive; avoid sharing private result screenshots.

Use only a [disposable development vault](docs/plugin-development.md) for manual
installation. Build/host-double checks verify the CommonJS artifact without Node
runtime dependencies, but no real desktop/mobile host test or production safety
claim is made. M2 is complete. M3 Worker Slice 2 and device-local state Slice 3 are
implemented. Slice 3 provides uncomposed strict preference/secret-reference and
App-local state adapters, serialized transition ownership, activation and staged
handoff validation; automatic saved-event processing, Fetch, retries, rename
orchestration and remote handoff verification remain unimplemented. The
[approved decisions](docs/plans/m3-design-decisions.md) distinguish that server
subset from the future connected mirror.

## Accepted M3 safety model — partially implemented on the Worker

The user opts into the whole eligible Markdown mirror; there is no per-note
selection model. Eligibility controls mirror scope, **not API/MCP authorization**.
Local saved changes drive automatic one-way mirroring from one designated device.
Static writer IDs guard cooperating clients, not a malicious privileged bearer;
iCloud/data.json is never a transactional writer coordinator. Handoff must drain
and resolve old work before changing designation/credentials; abort is not rollback.

M3 targets Obsidian 1.13.0 and native SecretStorage references, not plaintext tokens
in data.json or a claim of OS-keychain protection. Device activation/per-path ledger
use official host-local storage outside vault files; it is not an fsync guarantee
or safe multi-process store. HTTPS is default; exact loopback HTTP needs explicit
development opt-in. Fetch denies redirects/cookies, supports abort and bounded
reads/deadlines; no less-safe requestUrl or old-version fallback.

The implemented Worker uses fresh server revisions/R2 CAS and retired v1 PUT/DELETE
to protect updates, removals and recreation. The plugin does not use this API yet.
A post-bootstrap runtime delete for an already-associated eligible path authorizes a recoverable tombstone, including possible iCloud/external activity;
it does **not** prove human intent. Startup/list/scan absence never authorizes delete.
Separate recovery content is stored before tombstone, kept for 30 days and survives
recreation. Failed sealing can over-retain. Expired content is conditionally replaced
with a small purged marker; authoritative heads/markers never lifecycle-expire in M3.
No native R2 trash/versioning, exact physical erasure or complete backup claim.

R2 remains a private mirror/API layer, not sole authority; iCloud is still working-
vault device sync. Remote divergence blocks replacement; plugin never imports or
writes local notes. Recovery REST retrieval is not automatic local restore. Trusted
host/cloud operators still see plaintext, and operator deletion/stale restore or
old-code rollback can violate the experimental active-association assumptions.
No real resources/credentials or desktop/mobile qualification are inferred.

See [architecture](docs/architecture.md) for invariants and the
[roadmap](docs/roadmap.md) for automatic mirroring, reconciliation and hardening gates.
No future conflict or deletion flow may silently discard user data.

## Reporting a vulnerability

Please submit security reports privately through **GitHub Security Advisories** for this repository. Include enough detail to reproduce the issue, its impact, and any suggested mitigation.

Please do not disclose a vulnerability publicly in an issue, discussion, pull request, or social media post before maintainers have had an opportunity to coordinate a response.

## Supported versions

There are currently no supported production releases. The default branch is the only development line receiving security review while the project is experimental.

| Version | Supported |
| --- | --- |
| Development branch | Yes, on a best-effort basis |
| Published releases | None yet |

## Examples of security issues

Please report issues such as:

- Authentication or authorization bypasses.
- Path traversal or unsafe vault path handling.
- Exposure of remote vault content.
- Leakage of tokens, credentials, or other secrets.
- Unauthorized modification or deletion of vault or remote data.
- Malicious or insufficiently validated synchronization payloads.
