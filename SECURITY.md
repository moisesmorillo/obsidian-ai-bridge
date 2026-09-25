# Security policy

Security and data safety are priorities. M5 qualifies only the latest software release
v1.0.2 within the exact, narrow envelope in the [operator guide](docs/operations.md#current-m5-qualification-and-support).
This is not security certification, production-service approval, or a complete-backup
claim; no production Worker/R2 deployment or personal vault was used.

## M3–M5 Slice 4 trust and authorization boundary

The implemented outward mirror trusts the Obsidian host/plugin environment, the
plugin runtime, Worker, Cloudflare/R2 operator, and authorized bearer holders with
plaintext note content. There is no application-level end-to-end encryption. A local
malicious or compromised privileged plugin/host is inside this trusted-host boundary;
M3 does not claim isolation from it.

The Worker now authenticates at most 16 named opaque client bearers from a strict
version-1 digest-only registry. Raw tokens use 256 random bits and remain only in the
consuming client's approved secret store; the registry contains domain-separated
SHA-256 verifier material and non-secret metadata. Neither raw tokens nor digests may
enter committed configuration, `data.json`, host-local mirror state, handoff records,
logs, notices, screenshots, API responses, or generated documentation. Native
SecretStorage is a host-managed vault-local store, not a documented OS-keychain or
isolation guarantee. Private R2 prevents public bucket access but does not protect
plaintext from a correctly authenticated client or privileged operator.

Successful authentication resolves client ID, name, and exact `read`/`write`/`delete`
metadata. One exhaustive operation policy enforces those independent permissions before
service/storage dispatch; `write` never implies `delete`. The designated writer needs
all three for complete M3/M4 behavior. Registry authentication is the only mode;
singleton bearer authority and every v1 HTTP route are retired.

`MIRROR_ASSOCIATION_ID`, `MIRROR_WRITER_ID`, plugin device UUIDs, and mirror
eligibility are not authorization secrets or client permission scopes. Static IDs
reduce accidental mutation by cooperating non-writer clients; an authenticated client
with route authority can still supply them. They remain separate from the principal,
current permission checks, and application preconditions.

The user opts into the whole eligible Markdown mirror. Eligibility is limited to
literal lowercase `.md` paths of at most 1 MiB, excluding dot-prefixed segments and
the host configuration subtree. It does **not** grant remote-client permission.
Attachments, plugin/Obsidian configuration, credentials, and arbitrary files are not
mirrored. Note text is untrusted data: the plugin and Worker do not execute
instructions found in notes.

## Implemented data-safety boundary

- The plugin uses official saved Vault events, native SecretStorage references,
  modern declarative settings, host-local state, standards Fetch, and a versioned
  same-realm runtime owner. Unsupported runtime capabilities, incompatible registry
  or persisted-state versions, invalid configuration, missing secrets, designation
  mismatch, and persistence failures fail closed.
- Exactly one designated writer is supported. iCloud remains working-vault sync;
  there is no election, lease, automatic takeover, shared transactional ledger, or
  multi-writer claim. Writer availability controls mirror freshness.
- Startup, scan, inventory, and listener-gap absence never authorize delete. An
  observed post-bootstrap runtime delete for an already associated path can authorize
  a tombstone after five seconds and an exact absence check, including possible
  iCloud/external activity. Host events do not prove human intent.
- Conditional format-2 revisions and receipts protect creates, updates, recreation,
  and tombstones. V1 has no registered HTTP or OpenAPI route; authenticated requests
  receive ordinary sanitized 404 before service/storage dispatch. There is no v1
  mutation fallback or latest-revision force overwrite.
- Deletion prepares recovery content before the tombstone CAS. The tombstone CAS is
  the deletion linearization point. Recovery sealing establishes 30 days from the
  stored tombstone upload time; sealing may fail after deletion and unsealed/orphan
  content may over-retain. Seal failure never undoes a committed tombstone.
- Expired sealed recovery content is removed only by explicit conditional replacement
  with a content-free retained marker. This is not native R2 hard delete or exact
  physical erasure. Tombstones/markers remain and M3 has no scheduled cleanup.
- Runtime replacement in one compatible realm reuses the owner; process restart uses
  the validated content-free ledger. Abort, unload, timeout, or UI disappearance is
  not proof that a Worker operation rolled back.
- M4 remote-to-local effects require an exact operator review. Stale session, local
  observation, remote revision/receipt, recovery metadata, lifecycle, configuration,
  listener epoch, path, or reservation evidence refuses mutation; evidence is never
  silently refreshed to the latest generation.
- Competing local or remote bytes are create-only and post-verified under generated
  `ai-bridge-conflicts` paths before replacement or reviewed remote cleanup. The
  current and historical `.ai-bridge-conflicts` namespaces are mirror-excluded at
  exact boundaries; frozen legacy receipts are not repaired or redispatched. M4 has
  no local delete, move, rename, trash, raw filesystem, or generic Vault capability.
- Remote Markdown and recovery bodies are untrusted plaintext. Review previews use
  literal text controls and do not render HTML/Markdown, execute links/commands, or
  interpret note instructions. A confirmed import becomes ordinary vault plaintext
  and may be observed by other trusted-host plugins.
- Recovery restore is local-first and makes no remote mutation. The restored path
  remains reserved in `restored-pending-review` until a fresh reviewed successor takes
  ownership. Unknown effects, successor events, and active M4 operations remain
  durable attention states and block handoff.

Status/notices, structured application logs, plugin data, host-local state, and
handoff exports intentionally exclude bearer plaintext and note bodies. Worker logs
do not include concrete note paths, request bodies, raw authorization headers, raw
exceptions, or storage envelopes. Plugin status is sanitized text and does not echo
raw transport errors. Deliberate M2 inspection may display sensitive paths/byte
metadata; do not share screenshots. These implemented redaction boundaries do not
claim that arbitrary runtime user data can never exist transiently in memory.

## Operational security constraints

Use only a disposable, synthetic vault for manual qualification. M5 qualifies one
active writer on Obsidian Desktop 1.13.7 / macOS 26.6.2 / Apple M4 Pro through 10,000
eligible notes; the [final report](docs/qualification/m5-final.md) records this bounded
profile and retained Keep-local/rotation evidence. It does not qualify other desktop
versions, mobile, iCloud ordering, background iOS, a deployed Worker/R2, or a general
production environment. No personal vault was used. Configuration is not evidence of
deployed resources or credentials.

A safe handoff drains the old writer, preserves all unresolved evidence, exports only
content-free ACK metadata, changes server designation, rotates the bearer
independently, verifies local hashes/absences and remote revisions on the new device,
and activates only after exact alignment. Events during verification invalidate the
sample. A lost writer/ledger cannot safely take over the same association
automatically; use a new isolated empty bucket/association/credentials while
preserving old state for recovery.

Do not run version-2/3 plugin code after M4 device-state version 4 exists. Startup
strictly performs the same-key v2→v3→v4 migration with canonical save/read-back before
runtime publication; there is no reverse migration, reset, or supported downgrade.
The runtime owner and registry are also version 4, and incompatible same-realm reuse
fails closed. Do not restore stale local state as authority, re-enable an old writer
after handoff without redesignation and credential handling, roll the Worker back over
format-2 objects, re-enable v1 mutations, discard unresolved intents/M4 operations, or
redirect delayed old requests into a reset association. Pause, preserve evidence,
restart when required, upgrade forward, hand off, revalidate, or use an isolated reset.
See the [operator guide](docs/operations.md) for exact setup, reviewed operations,
secret rotation, recovery API, handoff, migration, and rollback procedures.

## Residual limits

Saved reads and host-local persistence are not atomic/fsync guarantees. Same-size
edits with indistinguishable timestamps can evade best-effort local race evidence.
Offline/listener-gap deletions may remain remotely live because absence cannot safely
be promoted to delete authority. Ordering across iCloud devices is not globally
transactional. M4 provides only explicit reviewed reconciliation: it does not add
automatic bidirectional sync, cross-system atomicity, multi-writer coordination,
conflict-artifact cleanup automation or MCP. Beyond the bounded corrective desktop
scenario, complete desktop/mobile, iCloud, native-secret, host rollback/durability,
WebView transport, background iOS, and deployed Worker/R2 behavior remain unqualified.
R2 is a private mirror/API layer,
not the sole authority or a guaranteed complete backup.

## Reporting a vulnerability

Submit reports privately through **GitHub Security Advisories** for this repository.
Include reproduction details, impact, and suggested mitigation when possible. Do not
disclose a vulnerability in a public issue, discussion, pull request, or social media
before maintainers can coordinate a response.

## Supported software version and scope

The only M5-qualified software release is **v1.0.2**, latest-only, within the exact
platform and 10,000-note envelope documented in the [operator guide](docs/operations.md#current-m5-qualification-and-support)
and [final qualification report](docs/qualification/m5-final.md). There are no
backports or parallel support lines. This is not support for an operated production
service: no production Worker/R2 deployment, security certification, or complete backup
is claimed. The default branch receives best-effort security review; earlier tags are
unsupported.

| Version | Support status |
| --- | --- |
| v1.0.2 | M5-qualified latest release, exact bounded envelope only |
| Development branch | Best-effort review; no release support until separately qualified |
| Earlier published tags | Unsupported |

## Examples of security issues

Report authentication/authorization bypasses, path traversal, token or plaintext
leakage, unsafe remote mutation/deletion, recovery-retention bypasses, registry/state
fail-open behavior, and malformed input that escapes validated boundaries.
