# Bidirectional vault sync: implementation and migration plan

## Outcome and current boundary

An Obsidian vault stored locally on Mac, iPhone, and iPad synchronizes through
the bridge API to a private R2-backed service. Local edits and authorized
REST/MCP changes converge without silently discarding either side of a conflict.
The service replaces iCloud as the **vault synchronization provider** after a
verified migration. It does not replace an independent backup, guarantee mobile
background execution, or imply end-to-end encryption. A future NAS can implement
the same storage contract after a separately qualified migration.

This is a post-M6 rollout plan, not authorization for all stages. M7 is delivered
as stage 1's private isolated foundation under [ADR 0020](../decisions/0020-private-sync-store-delivery-and-activation-gate.md)
on the documentation transition's merge. All applicable
[G1–G6 blockers](../qualification/m7-delivery-and-activation-gate.md) must close
before general real-data use/exposure/activation. The owner subsequently requested
a one-note exception under [ADR 0023](../decisions/0023-bounded-personal-vault-beta.md)
and [M10](../milestones/m10-personal-vault-beta.md); that beta has separate
pre-use requirements and does not close G1–G6.
The current implemented product still uses a one-writer,
Markdown-only outward mirror; M5's exact desktop qualification is not mobile or
bidirectional qualification. The [proposed ADR](../decisions/0016-bidirectional-vault-sync.md)
sets the target contract. The current [roadmap](../roadmap.md),
[architecture](../architecture.md), and [operations guide](../operations.md)
describe implemented behavior where current; the code and [current-state
evidence](../current-state.md) resolve stale prose until each slice updates its
documentation and qualification.

## Non-negotiable properties

1. **No silent loss:** keep a recoverable version of both sides when local and
   remote changed, or when effect certainty is unknown. A conflict is visible
   and resolvable; failed sync is never reported as success.
2. **One sync owner per vault at cutover:** iCloud and bridge do not write the
   same live vault concurrently during or after the eventual provider cutover.
   The bounded M10 beta is an explicit pre-cutover exception for one new path:
   iCloud remains enabled, can propagate the bridge's local write, and can
   deliver later events. Exact-base checks and conflict copies must preserve
   both versions. Each device retains an offline local copy; after cutover the
   server is the shared sync authority.
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
| REST/MCP-origin changes | Auto-apply authorized remote revisions against an exact acknowledged local base; a never-seen create requires a fresh complete local absence check with no pending intent, alias, or observation gap | Clean never-seen create, existing-local collision, recoverable delete, concurrent edit, stale revision, unknown effect, and hostile note-content tests |
| Vault namespace and legacy coexistence | M7 uses `sync/v1/vaults/<vault-id>/` in the existing bucket and never reads through or adopts v2 keys; a later import needs an explicit identity binding and v2 route fence | Synthetic namespace-isolation tests in M7; bucket inventory and v2 transition/rollback drill before any import |
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

### 0. Bound the protocol/storage foundation

Keep ADR 0016's broader product destination Proposed. Define only the decisions
required for an isolated, uncomposed protocol and storage foundation; do not accept
client enrollment, local reconciliation, mobile support, migration, or cutover policy
by implication. Preserve M1–M6 history and the current live deployment claim. Keep
the future threat categories visible in the [threat model](../threat-model.md), while
distinguishing M7 storage requirements from implemented controls.

**Exit:** the [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md)
resolves protocol versioning, namespace and v2 coexistence, conditional storage,
inventory/feed recovery, operation replay, and stage-1 tests. The broader ADR 0016
product contract remains Proposed; the current writer is unchanged and no new writer
is enabled.

Before publishing a release from this design-only change, follow the
[release-process guidance](../operations.md#release-please-and-documentation-only-changes).

### 1. Versioned sync protocol and storage port

Stage 1 is M7. Its exact schemas, namespace, v2 coexistence contract, operation
journal, fair round-robin 64-lane incremental feed, cursor-driven inventory,
same-key R2 write pacing/recovery, rename ordering, test-first PR units, and
acceptance criteria are in the
[delivered M7 storage specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md).
The contract uses the existing bucket under `sync/v1/vaults/<vault-id>/`; existing
v2 `vault/` and `recovery/` objects remain byte-for-byte untouched and are never
read through or silently adopted. M7 does not mount public sync routes, alter the
current writer, migrate data, or activate a vault. Before any later protocol
exposure, migrated identities require an explicit v2 compatibility fence so old
clients cannot write an invisible parallel revision.

Stage 1's initial inventory ceiling is 10,000 synthetic current objects, and the
current 1 MiB Markdown mutation limit remains in force. Each continuation sets the R2
limit to one object and commits exactly one complete list page/chunk. Short and empty
pages continue with the exact opaque cursor while `truncated` is true; only false
completes listing. Each head's revision/tombstone comes from its validated current-head
body, not list metadata. A resumable manifest and immutable evidence chunks span Worker
invocations. Each inventory, evidence-page, or cleanup invocation consumes at most 400
internal-service subrequests, leaving at least 600 of Workers Free's 1,000 limit without
assuming a Paid plan or raised quota. The total is at most 20,001 logical list pages and
one chunk per page (20,001 chunks), plus 10,000 unique heads. A no-interruption scan
uses at most 20,001 LIST and 10,000 head GET calls; durable per-page attempt
reservations allow one replay and cap actual calls at 40,002 LIST plus 20,000 head GET
(60,002 listing/head data subrequests). Each page has at most two data-read attempts;
preflight deferrals spend none. On resumption with an attempt reserved, probe the exact
chunk key first; a present chunk is validated and advances the manifest without repeating
LIST/head GET. If attempt two ends, fail only after an exact read proves no valid chunk
exists; an uncertain/unavailable chunk read stays blocked for read-back and cannot trigger
another data-read attempt. The scan is subject to 20 MiB unique head bodies, 40 MiB actual
head-read responses, 192 MiB serialized evidence, 4 KiB cursors, 9,216-byte schema-v2 manifests (historical v1 stays capped at
8,192 bytes and cannot continue), 12 KiB chunks, and a 24-hour lifetime. The
evidence ceiling is the sum of 15,360,000 summary bytes, 5,120,256 page-transcript bytes,
and 163,848,192 chunk-envelope bytes (184,328,448 total). Evidence reads use at most 16
chunks/heads per call, or 1,251 successful calls for one complete traversal, and expose a terminal
marker only after contiguous hash-chain verification. Only the final scan step may issue
a complete handle, after matching start/end feed vectors with no pending operation and
read-back-verified release of its active slot. Interrupted, throttled, expired, exhausted,
or inconsistent scans preserve their checkpoint or fail typed and never provide
absence/deletion evidence. Repeated writes to same-key mutable objects observe R2's
per-key rate limit while retaining exact CAS; throttled or uncertain effects remain
resumable/blocked. The mandatory preactivation gate requires isolated Workers Free runtime
qualification against the accepted 10 ms CPU/request target, reverified before
execution; repository checks and local workerd do not prove it. No
production deployment or mobile qualification is implied.

**Delivery exit:** reviewed merged private implementation, historical canonical
checks and the reconciled criterion report close M7, not operational support.
Local 5,000/10,000 maximum profiles remain evidence with their limits; real-day
expiry is incomplete. No 1,000-note limit is selected. All undemonstrated native
safety, worst-page/expiry, real R2, Workers Free CPU/memory/account and exposure
requirements transfer to mandatory G1–G6, not to approved checkmarks.

**General activation gate:** before broad real-data use or exposing stage 1, accept every
applicable G1–G6 row with source-bound evidence and explicit owner approval.
Partial inventory, unknown effects, stale CAS, client gaps and unverified resource
limits remain blocking. Migration needs the binding/v2 fence before exposure;
client sync/cutover additionally requires the later engine, host preservation and
backup/restore evidence. Stage 1 delivery authorizes neither stage 2 nor a vault.
The M10 one-note beta exception in ADR 0023 is separate and does not count as
acceptance of this general gate.

### 2. Pure three-way reconciliation engine

Persist each device's acknowledged remote base and pending effect before
dispatch. Classify local, base, and remote states, including never-seen,
equal, local-only change, remote-only change, concurrent edits, delete/edit,
rename, malformed object, and unknown effect. Hash/content equality outranks
mtime. A new empty vault downloads; an existing local vault gets a preview of
collisions before joining. Reject distinct paths that compare equal after
per-segment NFC normalization and Unicode case folding, plus any aliases
observed on a supported host; preserve original file bytes and display names.

For a never-seen remote create, perform a fresh complete local check for the
path and its equivalence class. Apply it only if both are absent, no pending
local intent exists, and observation has no gap; an existing object or any
ambiguous result requires review. This is separate from a durably acknowledged
absence established by stage 1.

Treat case-only rename and NFC/NFD aliases as explicit state-matrix cases. A
file removed externally while Obsidian was closed has no Vault delete event:
retain the remote version and show the missing local path for review rather
than inferring a tombstone. Initially preserve concurrent versions in a
visible conflict copy and review queue; automatic text merging is a later
optional feature, never a requirement for first cutover. Reuse M4 preservation
and receipt concepts where they fit without weakening their evidence rules.

Authorized REST/MCP-origin create, update, and recoverable delete revisions
auto-apply only when the local state still matches its exact acknowledged base
and remote and local preconditions pass, or when a never-seen create satisfies
the fresh-absence rule above. Show the origin; a concurrent local edit, stale
revision, or unknown effect preserves both sides for review. Note content never
becomes a command or an authority signal.

**Exit:** deterministic state-matrix tests cover clean REST/MCP auto-application,
never-seen creates with absent and pre-existing local paths, pending local
intent, path aliases, observation gaps, REST/MCP conflict review, offline edits,
stale revisions, reinstalls, interruption between persistence and remote
effect, deletion/recreation, closed-app external deletion, and repeat replay
without duplication or loss.

### 3. Safe Obsidian local effects and whole-vault files

Implement local create, conditional replace, recoverable delete, and rename
through supported Obsidian Vault APIs. Verify exact local bytes immediately
before and after each effect; changed bytes create a review item. Separate
effects caused by sync from new user edits to avoid echo loops. Add opaque
binary transfer and bounded/streamed file handling where host capabilities
permit it. Resolve configuration categories separately from note data, with
per-device defaults and secret/state exclusions. Keep user-visible recovery
copies out of automatic re-publication unless explicitly accepted.

For an incoming authorized tombstone, require the exact acknowledged local
base and retained remote recovery. Use `FileManager.trashFile` for the local
effect so Obsidian follows the user's trash preference; do not rely on a
stable OS or vault trash path. Qualify local recoverability on each supported
host and trash setting, or preserve and verify an exact excluded local copy
before trashing. If recovery cannot be established, or the local effect fails or remains
uncertain, stop for review without acknowledging deletion. Do not use permanent `Vault.delete` for this
automatic path.

Local rename effects consume the destination-first remote protocol receipts
defined in stage 1 and verify exact local evidence before and after mutation.

**Exit:** a disposable desktop vault round-trips Markdown, Canvas, and target
attachment types by hash; settings do not leak secrets; crashes and restarts
resume without converting an ambiguous effect into a destructive retry. A
remote tombstone leaves independently restorable remote and local recovery
evidence or fails closed.

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
REST/MCP clean auto-application and conflict preservation, hostile note text,
recovery history, tombstones, restore, and old-client denial.

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

M7 private delivery is closed under merged ADR 0020. The owner separately accepted
[M8's local Markdown demonstration](../milestones/m8-local-markdown-sync-demo.md)
and [ADR 0021](../decisions/0021-isolated-local-markdown-sync-demo.md); M8 becomes
NEXT on its specification PR's merge. Those local deliveries, the remote
synthetic successor and M9 have since completed. M10 is now the sole NEXT
milestone for the separately gated one-note personal-vault beta. G1–G6 remain
mandatory for public/productive exposure and broad real-data use; ADR 0023
defines only the owner beta exception. The historical M8 handoff authorized
no Cloudflare operation, personal-vault access or iCloud change.
