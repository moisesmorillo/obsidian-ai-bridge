# Security policy

Security and data safety are priorities for this project. The repository is in early development and does not yet provide a complete secure bridge or production-ready synchronization behavior.

## Current trust and data-safety boundary

M1 uses one bearer token granting all remote note operations in one R2 namespace.
PUT can unconditionally replace a note; DELETE immediately removes it without a
tombstone or application recovery. This is not safe automatic synchronization.
The Worker/cloud operator can read stored note text; there is no application-level
end-to-end encryption, per-client permission model or production security claim.

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
suppresses late results but cannot cancel host reads. Paths shown in deliberate
local UI remain sensitive; avoid sharing private result screenshots.

Use only a [disposable development vault](docs/plugin-development.md) for manual
installation. Build/host-double checks verify the CommonJS artifact without Node
runtime dependencies, but no real desktop/mobile host test or production safety
claim is made. M2 is complete; M3 remains planning-only until selection, credential
handling and server-enforced safe publishing are explicitly specified.

See [architecture](docs/architecture.md) for invariants and the
[roadmap](docs/roadmap.md) for safe publishing, reconciliation and hardening gates.
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
