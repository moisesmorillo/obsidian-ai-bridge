# M3 decisions — automatic eligible-Markdown mirror

**Status: maintainer decisions resolved; M3 Slices 0–5 implemented. Public v2
server routes and core autosync policy exist, but no connected user-visible M3 mirror exists.**

This replaces the proposal in PR #8 at `e35bd90`. That proposal drifted from the
product by coupling mirror scope to per-note consent, making manual publishing
primary, and postponing automatic changes/deletions to M4. Those are not the
product requirements. Historical filenames containing “publishing” remain only to
preserve links; their current titles and contracts describe automatic mirroring.

## Authoritative product definition

A user opts into a **private personal mirror of all eligible Markdown notes**.
The designated Obsidian device automatically reflects local saved creates, changes,
approved runtime removals and renames into Worker/R2. iCloud continues to synchronize
the working vault between devices. R2 is a remote mirror/API persistence layer, not
the sole authority, complete backup or replacement for iCloud.

Eligibility determines mirror scope, **not REST/MCP authorization**. Future MCP
adapts authorized Worker/application operations; it never accesses R2 directly or
treats inclusion in the mirror as permission. Local-to-remote is the M3 authority
direction; a changed remote revision causes divergence, not local replacement or
an autosync overwrite. Future NAS replication/remote authority is possible but not
selected or implemented. No new exclusion feature is needed in M3.

## Decision record

“Accepted” means maintainer-approved design, not necessarily complete production
implementation. Slice 2A–2C realizes private storage/application transitions and
the public authenticated v2 transport with v1 mutation retirement. Slice 3 adds the
uncomposed plugin configuration/device-state boundary, serialized core owner and
handoff model; Slice 4 adds Fetch transport; Slice 5 adds core bootstrap/coalescing,
fair scheduling and finite retry/evidence orchestration. Settings UI, host event/timer
composition, and delete/rename autosync remain.
Engineering defaults below are bounded implementation choices, not new product
permissions. The [spec](../milestones/m3-remote-bridge-client-and-publishing.md),
[plan](m3-remote-bridge-client-and-publishing.md) and ADRs are normative together.

| ID | Accepted decision | Consequences |
| --- | --- | --- |
| D1-D | Full eligible Markdown mirror; whole-mirror opt-in | No per-note selected state, folder/tag/frontmatter rules, select-all machinery or primary manual publish command. Retain literal NotePath, lowercase .md, dot/config exclusions and 1 MiB UTF-8 bound. |
| D2 | Native SecretStorage; modern host baseline | M3 minimum Obsidian 1.13.0 for declarative settings, including existing SecretStorage since 1.11.4. Persist a secret reference, never plaintext token. No old-host fallback or keychain claim. |
| D3 | HTTPS with explicit exact-loopback HTTP development opt-in | Only literal localhost, 127.0.0.1, [::1]; no LAN/DNS/suffix/numeric-encoding expansion. Rebinding is explicit and paused. |
| D4 | Single current-object envelope, fresh server generation and R2 conditional PUT | Storage CAS is the linearization point. New v2 routes; retire unsafe v1 PUT **and DELETE** so neither can overwrite/remove current live/tombstone generations. No DB/DO required. |
| D5, revised | Per-path synchronization state, not publishing selection | Acknowledged revision/hash, at most one unresolved intent per path, coalesced desired state and durable deletion/rename evidence. No second local copy of note text. A blocked path does not block unrelated paths. |
| D6 | Standards Fetch | redirect:error, credentials:omit, AbortController, bounded streaming/deadlines, explicit CORS; no requestUrl/Node/Electron fallback. |
| D7 | Runtime deletion authority, option A | An observed post-bootstrap delete for an already-associated eligible path may remove it from the active mirror. This may be iCloud/external activity; it is not proof of human intent. No scan-difference deletes or confirmations. |
| D8 | Application recovery, 30 days | Archive content before CAS tombstone; retain current tombstones; normal note reads/listing hide deletion. Recovery copies survive recreation. No native R2 trash/versioning claim. |
| D9 | One designated writer device | Explicit operator-configured identity and device-local activation/state; no iCloud ledger coordination, election or leases. Any supported device can be writer. Handoff drains old work and transfers verified non-content baselines explicitly. |

## Technical conclusions and rejected alternatives

### Autosync and lifecycle

Use Vault create/modify/delete/rename events, not editor-change or filesystem polling.
Wait for onLayoutReady, register event handlers **before** bootstrap enumeration,
then reconcile observations. Create events also occur at vault load; bootstrap
absence and pre-bootstrap deletion observations never authorize remote deletion.
Saved reads reuse M2's exact-file/pre/post checks plus event-generation checks and
SHA-256 comparison. No fixed Obsidian autosave cadence is assumed from undocumented
implementation details.

Coalesce latest desired state, not every event: 750 ms quiet time, 5 s maximum
coalescing wait, 5 s deletion grace, two running path jobs globally, one per path.
Remote inventory traversal also has a finite page budget; endless new cursors are
not cured merely by cycle detection. Incomplete inventory never implies absence.
Continuous instability may postpone a read; maximum wait is not a snapshot guarantee.
Use finite retry/evidence budgets per persisted intent, with no reset from every
modify event or re-enable. Separate actual operation settlement, coordinator lifetime
and presentation lifetime. A runtime-owned vault coordinator survives replacement
Plugin instances in the same JavaScript host; restart uses the durable ledger.

One global unresolved record would stall an entire vault on a single conflict;
a general durable content job queue would duplicate vault data and replay stale
work. Per-path intent interlocks plus rescanning current saved state are sufficient.
Only destructive lifecycle evidence and rename prerequisites need durable event
semantics; create/modify histories collapse into current desired state.

### Safe mutation and recovery

Raw-text ETags can repeat on same-body writes; R2's unique upload version is not a
conditional predicate. A fresh revision inside the stored envelope makes each
current generation different, including same-text updates and tombstones. The
[conditional ADR](../decisions/0002-conditional-remote-note-mutation.md) defines
original-precondition retries and exact operation receipts. A GET of arbitrary
latest state is never update authority; a matching receipt for our persisted
operation is acknowledgment evidence, not automatic adoption.

Native physical DELETE cannot implement required revision protection on the Worker
binding. Tombstoning with conditional PUT is technically dominant. Native lifecycle
rules expire whole objects and cannot act as a recoverable deletion transition.
Bucket locks on current objects would block normal edits. See
[ADR 0004](../decisions/0004-recoverable-mirror-deletions.md): prepare recovery copy,
CAS tombstone, seal recovery deadline; failures retain data rather than roll back.
GETs stay read-only; explicit designated conditional maintenance may seal from a
still-current matching tombstone, never an assumed timestamp or read-side bypass.

Recovery alternatives considered: native version history is unavailable in the
current documented R2 API; inline-only tombstone content would lose recovery on
recreation; full immutable history plus a head/database adds unnecessary history.
A separate deletion snapshot is the minimum additional persistence. Thirty days,
rather than 90 days or indefinite normal retention, is the maintainer's choice.
Uncertain/unsealed snapshots may over-retain: do not purge them using an assumed
commit time. Cleanup CAS-replaces expired recovery content with a small purged
marker so late retries cannot recreate it; there is no unsafe physical DELETE.
It is explicit, bounded and application-controlled in M3, not a blanket lifecycle
rule or a new scheduled service.

### Rename and writer ownership

An explicit local rename is a two-path workflow, not unrelated delete/create.
Create/acknowledge the eligible destination first, then conditionally tombstone the
source. Collision, ambiguity, a newer local lifecycle event or remote divergence
prevents source cleanup. Compound/overlapping renames may defer cleanup visibly;
M3 does not need an atomic multi-object rename transaction. Rename out of eligibility
removes the associated old mirror path recoverably without reading/uploading the
excluded destination. Startup-discovered path differences are not rename evidence.

The maintainer chose one writer instead of multiple active devices. Use an explicit
static Worker association/writer identity check plus device-local activation, not a
synced boolean. This guards cooperating plugin instances; the existing bearer is
still privileged and a writer ID is not a secret or a scoped authorization scheme.
No lease clock or leader election. A new writer is not enabled until old requests
are safely settled/fenced by completed conditional generations and its ledger is
clean. Imported baselines also require observed matching local hashes/tombstone
absence before activation: stale iCloud text is not a new edit or recreation.
If that cannot be established, handoff is blocked, not guessed. See
[ADR 0003](../decisions/0003-publishing-association-and-local-state.md).

## Primary-source evidence and qualification limits

Official sources were fetched/researched in this session. Broad Obsidian research
used shallow temporary clones, not repeated per-file API requests:

- [Obsidian API at cc174432](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts):
  Vault lifecycle callbacks contain file (and oldPath for rename), no human/iCloud
  origin flag. Vault.read reads saved disk content; editor-change is a distinct
  editor/programmatic-change event. SecretStorage is since 1.11.4;
  App.loadLocalStorage/saveLocalStorage are vault-local host storage since 1.8.7;
  onExternalSettingsChange explicitly mentions externally/sync-modified data.json.
- [Official event guide](https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Plugins/Events.md)
  requires registered event cleanup on unload. It does not promise cancellation of
  asynchronous work already started or the identity of recreated Plugin instances.
- [Load-time guide](https://docs.obsidian.md/plugins/guides/load-time): create events
  enumerate existing files at initialization; register after onLayoutReady. Neither
  layout-ready nor elapsed debounce proves iCloud has finished downloading a vault.
- [Vault guide](https://docs.obsidian.md/Plugins/Vault): external filesystem changes
  can precede host notifications/cache invalidation. read rather than cachedRead
  preserves M2's best-effort freshness; neither gives an atomic remote-write snapshot.
- [Secret guide](https://docs.obsidian.md/plugins/guides/secret-storage): native
  secrets are local storage keyed to the vault, shared by plugin references; plugin
  data.json is plaintext. No OS-keychain isolation/encryption guarantee established.
  No deleteSecret API is declared; disconnect does not delete a shared host secret.
- [Settings guide](https://docs.obsidian.md/Plugins/User+interface/Settings): modern
  declarative settings require 1.13.0. Installed official types mark display()
  deprecated. Use the modern API without a legacy fallback. The pre-Slice-1 M2
  artifact used 1.5.0; Slice 1 raised the current manifest and artifact tests to
  1.13.0 without adding an M3 client.
- [Mobile guide](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development):
  Node/Electron APIs unavailable on mobile. Public docs do not certify Fetch/abort/
  streaming/CORS behavior across every desktop/mobile WebView. Required primitives
  are feature-detected, failures pause sync, and focused real-host qualification
  remains a test gate, not a product choice or a reason for transport fallback.
- [R2 Workers reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
  conditional PUT returns null without storing; accepts Headers/R2Conditional;
  delete(key|keys) has no conditional parameter; upload version is not a predicate.
  SHA-256 put options are incoming integrity checks, not comparison to old content.
- [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/): bucket
  Get/PutVersioning unsupported. Do not treat the upload version field as historical
  retrieval or assume a native trash facility.
- [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/):
  whole-object expiration, typically removed within 24 hours after expiration;
  not exact-time physical deletion, conditional tombstoning or recovery.
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/):
  prevent overwrite/delete, apply by prefix, override lifecycle expiration. They
  are not mutable-note history and are not selected for the current namespace.
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/):
  binding reads/writes/deletes strongly consistent; unconditional competing writes
  still last-writer-wins. Caches/custom domains do not replace direct binding CAS.
- [Historical wildcard issue](https://github.com/cloudflare/workerd/issues/2572),
  closed: use constructed Headers for absence checks. The completed
  [Slice 0 qualification](../qualification/m3-slice-0-platform-primitives.md) now
  pins that local runtime regression instead of assuming a fake proves platform semantics.

No real host, iCloud event trace, deployment, bucket or credentials were exercised.
Tests must not invent a reliable delete-origin flag, exact autosave interval,
cloud-download-complete signal, storage fsync, physical purge deadline or distributed
writer fence that these sources do not provide. The approved operating/trust model
and conservative failure states account for those limits.

## Remaining decisions

**No unresolved material M3 product decision.** Implementation must qualify the
specified platform primitives and satisfy deterministic safety tests before wiring
automatic mutation. A failed qualification pauses that slice and requires technical
remediation/review; it does not authorize reverting to the rejected product model.
M3 remains NEXT, not COMPLETE; M4 and MCP are not implemented here.
