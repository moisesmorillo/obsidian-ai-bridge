# Bidirectional vault sync: implementation and migration plan

## Outcome and current boundary

An Obsidian vault stored locally on Mac, iPhone, and iPad synchronizes through
the bridge API to a private R2-backed service. Local edits and authorized
REST/MCP changes converge without silently discarding either side of a conflict.
The service replaces iCloud as the **vault synchronization provider** after a
verified migration. It does not replace an independent backup, guarantee mobile
background execution, or imply end-to-end encryption. A future NAS can implement
the same storage contract after a separately qualified migration.

This is a post-M6 **proposal**, not a `NEXT` milestone or permission to activate
the personal vault. Current release 1.4.2 still implements a one-writer,
Markdown-only outward mirror; M5's exact desktop qualification is not mobile or
bidirectional qualification. The [proposed ADR](../decisions/0016-bidirectional-vault-sync.md)
sets the target contract. The current [roadmap](../roadmap.md),
[architecture](../architecture.md), and [operations guide](../operations.md)
remain the authority for implemented behavior until each slice merges.

## Non-negotiable properties

1. **No silent loss:** keep a recoverable version of both sides when local and
   remote changed, or when effect certainty is unknown. A conflict is visible
   and resolvable; failed sync is never reported as success.
2. **One sync owner per vault:** iCloud and bridge never write the same live
   vault concurrently during or after cutover. Each device retains an offline
   local copy; the server is the shared sync authority.
3. **No inferred delete:** initial empty vaults, startup scans, missed events,
   incomplete inventory, and suspended mobile apps do not delete remote files.
   A confirmed deletion creates a recoverable tombstone bound to a known base.
4. **One revision domain:** plugin, REST, and MCP observe and mutate the same
   application versions under independent read/write/delete permissions. The
   existing v2 application ETag and format-2 receipts have an explicit
   migration or versioned rejection. Old protocol clients fail closed rather
   than publishing into a split namespace.
5. **Storage portability without fake interchangeability:** the application
   contract has no R2 types. A NAS adapter must pass the same conditional-write,
   enumeration, crash-recovery, and restore tests before it can own live data.
6. **Explicit scope and privacy:** vault data, selected configuration, per-device
   settings, and secrets have distinct policies. The Worker can read plaintext
   under the current trust model; private R2 access is not end-to-end encryption.

## What must sync

| Category | Target rule | Qualification evidence |
| --- | --- | --- |
| Markdown notes | Both directions; preserve canonical paths and exact bytes | Create, edit, rename, delete, offline conflict, case-only rename, NFC/NFD alias, closed-app external deletion |
| Canvas and user attachments | Both directions as opaque files; size and transfer limits defined before cutover | Binary round-trip hash, interrupted upload/download, mobile memory bound |
| Obsidian configuration | Explicit per-category opt-in for portable settings; safe device defaults | Desktop/mobile settings coexist without overwriting device layout |
| Plugin installation and updates | Managed separately on each device initially; never sync executable binaries implicitly | Reinstall/re-enroll without changing content authority |
| Credentials, bridge ledger, caches, workspace layout | Device-local and excluded from sync | No secret or state leakage in server inventory or release artifact |

The current 1 MiB Markdown cap, `.md`-only path policy, and exclusion rules cannot
silently be marketed as whole-vault sync. Before migration, inventory the real
vault **locally and read-only**: file types, counts, sizes, configuration needs,
unsupported paths, and attachment references. Decide explicit supported limits
from this evidence. A missing supported file blocks cutover; an intentionally
excluded category must be visible to the user.

## Decisions to close before personal-vault cutover

| Decision | Working proposal | Evidence needed |
| --- | --- | --- |
| Maximum file size and transfer method | Support the measured vault, with bounded transfers and no whole-file mobile memory assumption | Read-only vault inventory and real iPhone/iPad transfer tests |
| Configuration categories | Opt into portable Obsidian settings; keep secrets, device layout, plugin binaries, and bridge state local | User review of actual configuration and desktop/mobile replay |
| Conflict behavior | Preserve both versions and require review; no automatic Markdown merge initially | Two-device and MCP conflict exercises |
| MCP-origin changes | Choose automatic local application for authorized agents or a review queue; show origin either way | Threat-model review, owner decision, and tests for the selected policy |
| Vault namespace | Choose one vault per bucket or immutable vault-ID prefixes; keep existing `vault/<path>` objects safe | Bucket inventory, v2 REST/MCP transition and rollback drill |
| Path equivalence | Propose NFC-normalized, Unicode-case-folded per-segment comparison and reject aliases without changing file bytes | macOS/iPhone/iPad case and normalization matrix, enrollment collision preview |
| Backup retention and location | Independent versioned copy outside the active R2 authority | Restore drill, including tombstones and control metadata |
| Privacy model | Retain current trusted plaintext Worker model so authorized MCP can read notes | Explicit consent and verified private storage/API access |

These defaults are proposals. Inventory or testing can change them before
implementation of the affected slice; none is a reason to activate the
personal vault early.

## Ordered, independently reviewable work

Each slice ends with focused behavior tests, `mise run check`, semantic review,
updated docs, a fail-closed downgrade path, and a reviewable PR. Estimate
production files/lines before starting; split a slice by behavior if the
repository's change-size gate would be crossed. Tests and docs accompany the
behavior they verify. No slice alone enables the personal vault.

### 0. Replace the proposed product contract

Accept or revise ADR 0016 and the roadmap target. Preserve M1–M6 history and
the current live deployment claim. Specify file scope, platform support, trust
model, conflict policy, backup requirement, MCP-origin policy, and the
difference between R2 authority and a complete backup. Revise this plan and
ADR before any code PR.

**Exit:** one reviewable contract; no M7 invented and no writer enabled.

### 1. Versioned sync protocol and storage port

Define vault identity, per-file application revisions, current/live/tombstone
states, immutable recovery/version references, bounded inventory, and client
checkpoints. Keep authorization at the Worker boundary and make a narrow
`SyncStore` port in core. Map or explicitly reject existing v2 application
ETags and format-2 receipts. Adapt R2 conditional writes behind the port.
Decide one-vault-per-bucket versus immutable vault-ID prefixes and inspect
existing `vault/<path>` objects before any adoption. Start in an isolated,
versioned namespace, with exact import/retention and rollback rules for those
objects. Define how old v2 API and MCP reads/writes are routed or denied during
transition so no change is invisible to the new engine. Provide a durable,
bounded incremental change feed or equivalent manifest for routine sync;
define cursor ordering, expiry, gap detection, and snapshot consistency.
Complete scans recover from a missing, expired, or ambiguous cursor, but are
not the normal mobile poll path. Set request/byte/time limits from a measured
vault and qualify the recovery scan on supported devices.

**Exit:** two callers racing on the same version cannot both commit; a failed
head/history operation leaves recoverable evidence; old clients cannot fork
the data. Incremental replay and full-scan recovery converge on the same
version graph. Storage failures cannot turn into empty-success responses.

### 2. Pure three-way reconciliation engine

Persist each device's acknowledged remote base and pending effect before
dispatch. Classify local, base, and remote states, including never-seen,
equal, local-only change, remote-only change, concurrent edits, delete/edit,
rename, malformed object, and unknown effect. Hash/content equality outranks
mtime. A new empty vault downloads; an existing local vault gets a preview of
collisions before joining. Reject distinct paths that compare equal after
per-segment NFC normalization and Unicode case folding, plus any aliases
observed on a supported host; preserve original file bytes and display names.
Treat case-only rename and NFC/NFD aliases as explicit state-matrix cases. A
file removed externally while Obsidian was closed has no Vault delete event:
retain the remote version and show the missing local path for review rather
than inferring a tombstone. Initially preserve concurrent versions in a
visible conflict copy and review queue; automatic text merging is a later
optional feature, never a requirement for first cutover. Reuse M4 preservation
and receipt concepts where they fit without weakening their evidence rules.

**Exit:** deterministic state-matrix tests cover offline edits, MCP edits,
stale revisions, reinstalls, interruption between persistence and remote
effect, deletion/recreation, closed-app external deletion, path aliases, and
repeat replay without duplication or loss.

### 3. Safe Obsidian local effects and whole-vault files

Implement local create, conditional replace, recoverable delete, and rename
through supported Obsidian Vault APIs. Verify exact local bytes immediately
before and after each effect; changed bytes create a review item. Separate
effects caused by sync from new user edits to avoid echo loops. Add opaque
binary transfer and bounded/streamed file handling where host capabilities
permit it. Resolve configuration categories separately from note data, with
per-device defaults and secret/state exclusions. Keep user-visible recovery
copies out of automatic re-publication unless explicitly accepted.
Rename is a durable destination-first operation: conditionally create the
destination and persist its evidence before conditionally tombstoning the
source. A crash between those steps may leave two visible copies, never a
missing sole copy; recovery checks both exact revisions and asks for review if
either changed. A repeated replay must not duplicate the destination or erase
an independently edited source.

**Exit:** a disposable desktop vault round-trips Markdown, Canvas, and target
attachment types by hash; settings do not leak secrets; crashes and restarts
resume without converting an ambiguous effect into a destructive retry.

### 4. Independent enrollment and mobile lifecycle

Each installation uses browser OAuth and its own revocable grant. Verify the
callback, token storage/refresh, network transport, Web Crypto, and local-state
persistence on actual Obsidian iPhone and iPad hosts. Extend the current
read-only connection to request independently approved `write` and `delete`
scopes, prove refresh rotation and revocation across restarts, and retire the
plugin's M5 bearer write path and static `MIRROR_WRITER_ID` guard only after
new admission is qualified; other M5 credential uses need explicit transition
rules and do not disappear by implication. Existing grants never gain scope
implicitly. `isDesktopOnly: false`
in a manifest is not proof. The plugin syncs on open, resume, saved change,
and explicit **Sync now** while Obsidian runs. A suspended iOS app makes no
freshness promise. Bound startup scans, memory, concurrency, retries, network
use, and battery cost for the supported vault size. Measure normal incremental
sync separately from exceptional full-scan recovery.

**Exit:** two disposable mobile vaults and one desktop vault exchange changes
in both directions, including offline and app suspension/resume. Revoke one
device without disabling others; its queued writes fail closed on reconnect.

### 5. Backend qualification and independent backup

Exercise the deployed Worker/R2 with synthetic data: multi-device races,
conditional failures, partial transfers, expired credentials, revoked grants,
MCP mutations, recovery history, tombstones, restore, and old-client denial.
Document private bucket access and the plaintext Worker/operator trust
boundary. Implement an independent backup and prove a restore into an isolated
environment, including content, versions, tombstones, vault identity, and
client re-enrollment or checkpoint recovery. R2 itself is not the backup.

**Exit:** reproducible synthetic restore and rollback drills; no personal
vault content in tests, logs, PRs, or diagnostic artifacts.

### 6. Personal-vault migration from iCloud

1. Inventory and back up the current iCloud vault locally. Record file counts,
   sizes, and hashes without uploading content during discovery.
2. Keep the personal vault on iCloud while all previous stages run on disposable
   vaults. Prepare a separate local vault on Mac, iPhone, and iPad; do not point
   two sync providers at the same live folder.
3. At a deliberate cutover window, stop edits on all devices and let iCloud
   settle. Freeze a dated, independently readable copy and compare inventories.
4. Bootstrap the new remote authority from the chosen Mac copy, then attach
   iPhone and iPad **one at a time** as local vaults. Download and verify the
   whole supported inventory and attachment hashes before editing on each.
5. Test a small create/edit/delete cycle and one authorized MCP change, then
   confirm they reach all three devices. Keep the frozen iCloud copy untouched
   through an observation period.

**Abort before cutover:** disable the new plugin's writes and continue using
the unchanged iCloud vault. **Rollback after new writes:** export/reconcile
the latest remote and local changes into a restored copy before re-enabling
iCloud. Never turn an old iCloud snapshot back into an active writer blindly.

**Exit:** user confirms data and workflow on all devices; supported inventory
matches; independent restore works; no parallel sync provider remains.

### 7. Future NAS storage option

Keep the plugin and public protocol unchanged. Implement another `SyncStore`
adapter or move the whole service only after deciding reachability, uptime,
TLS/auth, backup, and failure behavior. An S3-compatible NAS is eligible only
if it passes the atomic conditional-write and consistent-inventory contract;
otherwise supply transactional coordination in the server rather than assuming
R2 semantics. Export and verify versions, tombstones, vault identity, and
checkpoints before switching the sole authority. Run a synthetic cutover and
reverse drill first. Cloudflare Tunnel or private routing is a deployment
choice, not an implied dependency of this plan.

**Exit:** storage-conformance suite and restore drill pass against NAS; clients
continue using the same API without reinterpreting old revisions.

## Next handoff

This design proposal must be reviewed before a production sync PR. The first
implementation PR after this design is accepted should establish
the versioned sync contract and R2 storage port **without changing the live
writer path**. Before code, verify the current `main`, open PRs, roadmap,
workflows, and deployed bindings again. Use disposable vaults through stage 5.
Do not activate the personal vault or disable iCloud from an automated job.
