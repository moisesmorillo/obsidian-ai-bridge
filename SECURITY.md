# Security policy

Security and data safety are priorities for this project. The repository is in early development and does not yet provide a complete secure bridge or production-ready synchronization behavior.

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
