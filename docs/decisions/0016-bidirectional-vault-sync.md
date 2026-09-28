# ADR 0016 — Bidirectional vault synchronization

## Status

**Proposed.** This changes the proposed product destination, not the deployed
single-writer behavior or the M1–M6 completion record. No later milestone is
defined or marked `NEXT`. Implementation requires separately reviewed contracts,
qualification, and an explicit personal-vault cutover.

## Context

The current plugin publishes eligible Markdown from one designated Obsidian
Desktop installation to a private Worker/R2 mirror. iCloud moves working files
between the user's Mac, iPhone, and iPad. M4 remote-to-local effects require
review and do not constitute automatic synchronization. The user now wants the
bridge itself to synchronize a local vault on each device in both directions,
including remote MCP changes, and eventually to replace R2 with homelab storage
without replacing the client protocol.

The v2 per-note conditional mutations, recovery objects, authorization policy,
and local evidence machinery are useful foundations. They do not cover binary
assets, configuration, routine remote-to-local application, mobile operation,
initial enrollment, or an independently restorable authoritative store. The
existing 1 MiB Markdown-only qualification is not a whole-vault claim.

## Decision

### Authority and boundaries

- Each device has a **local Obsidian vault**. The bridge service is the shared
  synchronization authority. iCloud must not sync the same live vault after
  cutover. Offline edits remain local until the app can synchronize.
- The Worker remains the authenticated API boundary. Each installation receives
  its own revocable OAuth grant; MCP/REST clients use the same application
  revision and permission rules. A device ID identifies a participant but is
  not a credential, lock, or designated writer. Owner-authorized enrollment
  creates one immutable vault identity; no operator-copied writer UUID is needed.
- The initial data scope is Markdown, Canvas, and user attachments required by
  the vault. Configuration sync is a separate, explicit category decision:
  portable settings may be selected; credentials, device-local state, caches,
  workspace layout, and the bridge's own ledger are never synchronized. Plugin
  installation and updates remain device-local unless a later safe contract is
  accepted. File-type, size, path, and platform limits must be explicit before
  any personal-vault cutover.
- This is not end-to-end encryption. The authorized Worker/operator can read
  content to serve API and MCP requests, as under the current trust model.
  Encryption at rest, private bucket access, and independent backup remain
  separate controls. No client receives direct R2 or future NAS credentials.

### Synchronization semantics

- The service maintains a current version or recoverable tombstone per path,
  bounded version history, and an application-level revision independent of a
  storage vendor's ETag. Each device durably remembers the exact remote version
  it acknowledged and any unresolved local or remote effect.
- Synchronization classifies local, acknowledged base, and remote versions.
  Unchanged local content can receive a remote change; unchanged remote content
  can receive a local change. Concurrently changed content, delete/edit races,
  ambiguous effects, and invalid state preserve both sides and require review.
  Initial behavior creates a conflict copy rather than guessing a text merge.
- A mutation uses create-only or compare-and-swap against the exact observed
  remote version. A failed condition stops the operation; it never retries
  against a newly observed head. Local application uses official Obsidian Vault
  APIs with an exact pre-application local check. If that check fails, preserve
  the local bytes and create a review item. No timestamp is an authority token.
- An empty new vault is a download target, not evidence of remote deletion.
  Startup absence, an incomplete scan, a stopped app, or an observation gap
  cannot authorize deletion. A deletion requires an acknowledged path and a
  captured post-enrollment Vault delete event, with a matching remote
  precondition. The event alone does not prove human intent. Tombstones prevent
  stale devices from recreating deleted files.
- Remote MCP changes are ordinary remote revisions. They reach devices through
  the same pull/reconcile path. API and MCP must not bypass revision checks or
  write a separate namespace that the sync engine cannot observe.
- Mobile freshness is qualified while Obsidian runs: on opening, returning to
  the app, local changes, and an explicit Sync now action. Do not promise iOS
  background execution while the app is suspended.

### Portable storage boundary

- Core owns a narrow `SyncStore` contract for conditional current-version
  mutation, immutable recovery/version retrieval, tombstones, and complete
  bounded inventory. The R2 implementation is an adapter inside the Worker;
  R2 keys, conditional headers, and ETags do not enter plugin state or the
  public sync protocol. A full scan remains a correctness fallback if an
  incremental change cursor is missing, expired, or ambiguous.
- A future NAS backend must demonstrate the **same atomic per-path condition**,
  durable version/history retention, consistent enumeration or a safe snapshot
  protocol, and backup/restore semantics. S3 compatibility alone is not proof.
  Migration transfers the entire version graph, tombstones, vault identity, and
  client checkpoint compatibility; it is not a bucket URL change. Whether the
  Worker reaches a private NAS service or the API also moves is a later
  deployment decision.
- R2 as synchronization authority is not a complete backup. Before cutover,
  add and restore-test an independent backup of content, history, and control
  metadata. A rollback cannot silently reactivate an old iCloud copy as a
  writer after remote changes have occurred.

## Consequences

The existing mirror-only product contract, the one-writer guard, and the
reviewed-only remote-to-local rule must be superseded by a versioned protocol;
historical ADRs remain accurate for the implemented releases. The Worker and
plugin need coordinated migration, but old clients must fail closed during the
transition. Whole-vault scope and mobile qualification make this substantially
larger than automatic multiwriter admission. [The rollout plan](../plans/bidirectional-vault-sync-rollout.md)
defines independently reviewable slices and the cutover evidence.

## Rejected shortcuts

- Removing `MIRROR_WRITER_ID` alone permits more publishers but does not deliver
  remote changes to devices or protect a device without an acknowledged base.
- Last-writer-wins and timestamp ordering can discard offline or MCP changes.
- Adding Durable Objects before a concrete cross-object coordination need does
  not establish local intent or resolve a stale device. Existing R2 conditional
  writes are a suitable per-path starting point.
- Running iCloud and bridge sync on the same live vault during migration creates
  two independent writers of local files and obscures deletion provenance.

## References

- [Current architecture](../architecture.md)
- [M3 association and local state](0003-publishing-association-and-local-state.md)
- [M4 reviewed reconciliation](0005-reviewed-reconciliation-authority.md)
- [Client authorization](0015-browser-mediated-client-authorization.md)
- [Obsidian Sync setup and existing-vault warning](https://obsidian.md/help/sync/setup)
- [Obsidian guidance on parallel sync providers](https://obsidian.md/help/sync/faq)
- [Obsidian mobile plugin development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
