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
The plugin currently has no vault/network behavior; the next milestone is local
read-only inspection, not permission to upload or modify a vault.

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
