# M4 — Reviewed remote-to-local reconciliation and conflict resolution

**Status: NEXT — Slices 1–3 implemented; no M4 user-facing behavior.** M3 is COMPLETE.
The accepted design remains sequential. Slices 1–2 establish closed content-free
contracts, device-state v3, deterministic migration/fencing, and the read-only review
and admission seam. Slice 3 adds only uncomposed, operation-authorized local mutation
and durable conflict-preservation primitives. Slices 4–8 remain unimplemented. No
review UI, action orchestration, remote mutation, tombstone/restore/history execution,
timer, deployment, or personal-vault installation is active.

## Objective

Let the designated operator deliberately inspect and resolve remote divergence without
silently losing local or remote data. M4 adds reviewed remote-to-local reconciliation,
exact adoption of revisioned generations, durable conflict preservation, reviewed
remote tombstone handling, local-first recovery restore, and bounded deferred-history
resolution.

M4 is **not automatic bidirectional synchronization**. Remote divergence creates a
review item until an operator acts. Every mutation is authorized by a closed typed
source and is rejected when its sampled evidence is stale.

## Inherited M3 invariants

- One designated writer remains the supported baseline. There is no election, lease,
  automatic takeover, shared transactional ledger, or implicit multi-writer model.
- Local saved events remain the ordinary outward mutation source. Startup, inventory,
  listener-gap, and partial-hydration absence never grant deletion authority.
- V2 conditional revisions, receipts, application ETags, permanent tombstones,
  recovery-first deletion, 30-day recovery, purge markers, and v1 mutation retirement
  remain authoritative.
- Whole eligible lowercase-`.md` scope, literal safe paths, dot/config exclusions, and
  the 1 MiB UTF-8 bound remain unchanged.
- The privileged bearer and trusted plaintext host/plugin/Worker/cloud boundaries
  remain unchanged. M5 owns future permission redesign.
- No blocker is cleared by refreshing to latest state. Equal text does not establish
  generation identity. Remote content is untrusted data and note instructions are
  never executable.
- M3 unresolved intents/effects and deferred rename evidence take precedence over M4
  review. No M4 action may erase or reinterpret them.
- No local or remote mutation is silent. No cross-system atomicity is claimed.

## Accepted design decisions

The accepted ADRs are normative with this specification:

- [ADR 0005](../decisions/0005-reviewed-reconciliation-authority.md): reviewed-only
  authority and one designated writer;
- [ADR 0006](../decisions/0006-conflict-preservation-and-local-mutation.md): verified
  local preservation, narrow mutation port, and persisted commit ordering;
- [ADR 0007](../decisions/0007-explicit-adoption-tombstone-and-restore.md): exact
  revisioned adoption, no unsafe in-place legacy adoption, reviewed tombstones, and
  local-first restore using the existing v2 API;
- [ADR 0008](../decisions/0008-m4-device-state-migration.md): version-3 state,
  deterministic v2 migration, and downgrade fencing.

No material M4 decision requires maintainer input. Implementation details may be
refined only when they preserve these accepted authority and data-safety contracts.

## Authority model

### Alternatives considered

| Model | Data-loss/stale-iCloud risk | Restart/auditability | Complexity and conflict UX | Future/operational fit | Decision |
| --- | --- | --- | --- | --- | --- |
| A. Reviewed/manual reconciliation | Lowest: every remote-to-local effect binds to exact evidence and operator intent | Durable intent after confirmation; open UI invalid after restart; straightforward audit | Explicit review is slower but conflicts are visible | Preserves M3 and provides safe primitives for M5/M6 | **Accepted** |
| B. Automatic bounded bidirectional sync | Remote-only changes would silently choose authority; stale iCloud can appear unchanged | Needs remote event ordering, automatic delete policy, and more durable state | Highest; hidden “safe” cases become another conflict policy | Requires coordination the product does not have | Rejected |
| C. Hybrid auto-import/simple + reviewed conflicts | “Simple” remote-ahead cases still lack freshness/intent proof | Two policy paths can diverge across restart | Medium-high and harder to explain | Marginal convenience, same core risks | Rejected |

### Typed authority sources

| Authority source | Permitted effects | Never permits |
| --- | --- | --- |
| `m3-saved-event` | Existing M3 conditional outward create/update/tombstone/rename | Remote-to-local mutation or blocker refresh |
| `operator-reconciliation-decision` | Exact reviewed live/live resolution | Mutation after any evidence changes |
| `operator-adoption-decision` | Associate one exact format-2 revision whose receipt belongs to the current association; create/replace local only as selected | Legacy/equal-text/physical-absence auto-adoption |
| `operator-tombstone-decision` | Adopt an exact tombstone only after fresh local absence, preserve/copy local, or conditionally recreate remote | Plugin deletion/move of a live local path |
| `operator-recovery-restore-decision` | Restore one exact recoverable snapshot to one checked destination | GET-side write or automatic remote recreation |
| `operator-history-decision` | One bounded current-state cleanup/retention choice | Reconstructed intent from incomplete rename history |
| existing explicit handoff | M3 content-free verified writer transfer | M4 conflict resolution or automatic takeover |

UI never owns this policy. Every button maps to one application command containing a
review ID, action discriminant, path/target, and current UI session ID. The
application service loads the authoritative durable state and revalidates evidence.

## Reconciliation evidence and state model

### Evidence tuple

A read-only review has one UUID-v4 `reviewId` and one immutable
`ReconciliationReviewSnapshot` that binds:

- current association and canonical origin;
- designated writer/device and lifecycle kind;
- exact target NotePath plus any reserved source/destination paths;
- local existence, stable saved-content SHA-256, measured byte size, local observation
  generation, listener epoch, and exact transient sampled content;
- acknowledged baseline kind, revision, content hash/recovery ID, and whether an M3
  unresolved intent/effect or deferred rename exists;
- sampled remote kind, format-2 revision/receipt/content hash, tombstone metadata,
  legacy content hash with **no generation identity**, or physical absence;
- recovery identity/revision/status/hash/expiry where applicable;
- configuration generation and runtime-owner version.

`ReconciliationReviewSnapshot` is the single typed semantic owner of this immutable
content-free identity. It stores one runtime identity plus complete evidence for the
target and every related source/destination/collision path. An admitted operation
copies the same snapshot, and strict validation requires exact equality across every
authority dimension. Only metadata is durable. Sampled local/remote note bodies remain
transient in the review session and are discarded on close/unload. A confirmed
operation can later reconstruct bytes only from an exact local hash, exact revisioned
remote generation, exact recovery snapshot, or a verified preservation artifact.

### Classifications

Classification order is authoritative: unresolved M3 work, deferred history, and
unavailable evidence win before ordinary three-way comparison.

| State | Evidence | Meaning/actions | Invalidation |
| --- | --- | --- | --- |
| `aligned` | Local hash equals live ACK hash and remote live revision equals ACK; or local absent + exact ACK tombstone | Informational; no resolution action | Any local event/epoch, remote revision/state, lifecycle/config change |
| `local-ahead` | Remote equals ACK; stable local live hash differs from live ACK | Ordinary M3 outward work when no review operation reserves the path; operator may inspect/defer | Local generation/hash or remote revision change |
| `remote-ahead` | Local equals live ACK; remote is a different format-2 live revision | Review required: use remote, keep local, keep both, defer | Either side, ACK, path, lifecycle, review session |
| `both-changed` | Stable local differs from ACK and remote live differs from ACK | Conflict: preserve first; keep local/use remote/keep both/defer | Same as remote-ahead |
| `remote-tombstoned` | Exact remote tombstone differs from live/unassociated baseline, or exact acknowledged tombstone meets local content | Review using tombstone matrix; no automatic local removal | Tombstone revision, local evidence, ACK/lifecycle |
| `local-missing` | Stable exact local absence while a live ACK/remote exists and no M3 runtime-delete authority exists | Informational conflict; import exact remote or defer; never remote-delete from absence | Any local event/epoch or remote/ACK change |
| `legacy-remote` | Remote state/content is legacy and lacks an application revision | Preserve/fork import to a different path or defer; no same-path baseline | Any review refresh; equality is never identity |
| `unknown-local` | Read is unstable, missing during a positive read, excluded, oversized, unavailable, or listener epoch is incomplete | Block mutation; refresh after stable evidence | A complete fresh stable observation |
| `remote-unavailable` | Remote read, contract, auth, designation, or bounded inventory fails | No resolution mutation; global failures retain M3 fences | Fresh successful exact evidence and valid admission |
| `unresolved-m3-effect` | Any unresolved M3 mutation/evidence/persistence effect exists for involved path | M3 evidence recovery only; no M4 decision | Exact M3 settlement persisted |
| `deferred-history` | Rename-deferred/invalidated/overlap evidence or multiple dependent paths exist | Grouped history review only | Any involved path/effect changes |

Equal live text with a different remote revision is `remote-ahead` or `both-changed`,
not `aligned`. A remote physical absence never means tombstoned. An unassociated local
and absent remote path remains normal M3 create territory, not M4 adoption.

### Review lifecycle

- Discovery is bounded and read-only. Candidate paths are the union of tracked ledger
  paths, positive local inventory, visible remote note pages, and recovery-metadata
  paths; tombstones are hidden from ordinary note lists, so each candidate uses the
  exact state endpoint before classification. Inventory is not an atomic snapshot and
  never supplies mutation authority.
- Open review snapshots are ephemeral. Explicit refresh creates a new review ID.
- Events update observation generations even for same-text saves. Listener detach,
  owner replacement, process restart, configuration change, or lost observation epoch
  invalidates every open snapshot.
- After operator confirmation, persist a content-free `ReconciliationOperation`
  before the first preservation/local/remote effect. That operation, not the UI,
  owns restart recovery. On startup, every persisted read-only review without an
  active operation is marked stale before commands are enabled.
- At most one operation may reserve a path. Multi-path actions reserve all involved
  paths lexically and do not block unrelated paths.

## Stale-decision protection

The **decision-admission commit** is the serialized state-owner transition that turns
an ephemeral UI choice into a durable operation. Immediately before that transition,
the application must still prove:

1. the same current runtime owner, listener epoch, configuration generation, origin,
   association, designated writer, and lifecycle;
2. the same review ID and action, with no newer review/operation on any reserved path;
3. the same acknowledged baseline and M3 unresolved/deferred state;
4. the same local path existence, event generation, and exact stable content hash;
5. the same remote kind and exact application revision/receipt, or the same selected
   recovery revision/status/hash;
6. the same source/destination identity and collision state;
7. every required preservation receipt still exists with the expected hash.

After admission, each phase revalidates the evidence it consumes immediately before
its effect. A conditional local replacement supplies the exact sampled current text
to the host's atomic compare-and-replace operation; create requires exact absence.
Remote mutation always uses the original application revision; a latest GET never
replaces it. Local events are serialized relative to admission: an event committed
before admission makes the review stale, while an event after admission is a successor
generation that remains dirty/reviewable after the exact admitted bytes settle.

There is no simultaneous local+remote transaction. The final remote read before a
local effect and the remote CAS before a remote effect are their respective evidence
points. A competitor committing after the relevant evidence point is a new divergence,
not proof the UI command bypassed validation; preservation and exact local/CAS
predicates still prevent silent loss. Tests must hold this post-admission window open
and assert the successor remains visible.

If any required check changes before its decision/phase evidence point, the service
records `stale`, performs no further mutation,
retains all preservation artifacts and proven effects, and requires a new review.
A stale decision cannot be “refreshed” in place. Same-text remote ABA changes the
format-2 revision. Same-process local ABA changes observation generation; any listener
gap/restart invalidates the epoch. The documented M3 residual remains: a same-size,
same-timestamp local replacement that emits no observable host event cannot be proven
distinct. M4 does not claim otherwise and rechecks exact current text at local commit.

## Bounded local mutation capability

Core keeps `ReadOnlyLocalVault` unchanged and defines a separate
`LocalReconciliationWriter`. Its conceptual commands and preconditions are:

| Command | Preconditions | Collision/effect rule | Postcondition evidence |
| --- | --- | --- | --- |
| `createEligible` | Valid eligible destination, ≤1 MiB UTF-8, expected absent, active exact operation | Existing file/folder refuses; no suffix/overwrite | Exact file identity and content hash after create |
| `replaceEligible` | Existing eligible file, exact transient expected text/hash/generation, replacement in bounds | Host atomic `process` callback refuses changed text | Returned written text plus fresh exact read/hash |
| `createPreservation` | Generated `.ai-bridge-conflicts/<operation>/<side>.md`, expected absent, outside the actual config subtree, content in bounds | Any parent/file/config collision blocks | Exact reserved path/hash and successful reread |

The port never accepts host objects, arbitrary normalized strings, generic write/delete
methods, filesystem paths, or transport types. The adapter uses official Obsidian APIs
only. It may reuse the reserved root folder, but the operation-UUID folder is
create-only on first dispatch. Only the same durable unknown-effect operation may
adopt an existing exact side hash; a file at the root or unrelated/mismatching
operation/side collision blocks. It
creates folders component-by-component and never follows a remote-supplied path into
the reserved tree.

No local rename, hard local delete, or move-to-archive deletion substitute is required
or permitted in M4. Obsidian has no documented atomic compare-and-delete/move
predicate, so stale-decision protection cannot be guaranteed for those effects.
Operators may rename/delete directly in Obsidian; the resulting host event invalidates
review and requires fresh evidence. The conflict archive is durable preservation, not
a transactional filesystem or backup. Operators clean completed artifacts explicitly;
cleanup automation is outside M4.

## Conflict preservation and resolution

### Preservation rules

- A competing version must be durably present at its original current generation or
  in a post-verified local preservation artifact before replacement or remote cleanup.
- Remote recovery is relied on only for the deletion snapshot it actually represents;
  it is not assumed to preserve arbitrary live/live competitors.
- Preservation metadata records operation, original path, side, exact source revision
  if any, content hash, reserved path, and proof status. It contains no body.
- Conflict files are excluded by the existing dot-segment rule and never enter normal
  mirroring. An operator-selected eligible keep-both destination is separate.
- Failed/colliding preservation stops the action. No mutation compensates by deleting
  another version.

The state-v3 validator owns the complete pre-effect preservation matrix:

| Action | Evidence-derived required preservation before a material effect |
| --- | --- |
| Keep local | Exact target remote live hash + revision as `remote` |
| Use remote | Exact target local live hash as `local`; none only for exact local absence |
| Keep both | Exact non-primary competitor; tombstone keep-both permits only remote primary and therefore preserves local |
| Exact revision adoption | None; this action represents only local absence or explicit equal-byte association and cannot replace a competitor |
| Accept tombstone | None; exact local absence and no material effect |
| Recreate remote | Exact target local live hash as `local` |
| Restore recovery | Exact selected destination local hash as `local` when occupied; none for exact absence |
| Fork legacy | Exact target legacy hash with no source revision as `remote` |
| Bounded history | Exact target remote live hash + revision before selected remote cleanup; a no-effect retain/defer completion requires none |
| Defer | None |

Every persisted receipt must match the operation UUID, original path, generated
side-specific preservation path, required side, source revision/null relationship,
and evidence-derived content hash. An extra receipt or any receipt whose source
evidence cannot establish exact bytes is invalid.

### Live/live actions

| Action | Authority and preservation | Ordered effects | Failure/restart/final baseline |
| --- | --- | --- | --- |
| **Keep local** | Exact operator decision; preserve sampled remote live bytes first | Persist intent → create/verify `remote.md` → revalidate both sides → conditional remote PUT of exact local bytes against sampled revision | Unknown remote effect uses exact receipt evidence. On confirmation persist new remote ACK/hash; local remains. Failure leaves remote original and copy. |
| **Use remote** | Exact operator decision; preserve sampled local bytes first | Persist intent → create/verify `local.md` → revalidate → atomic conditional local replace with exact sampled remote bytes → verify local | Persist local effect before adopting sampled remote revision as ACK. Save failure leaves intent; restart proves local hash + remote revision + copy. No remote mutation. |
| **Keep both** | Exact operator decision plus primary side and operator-chosen locally/remotely absent eligible path; archive required competitor first | Create/verify archive → create/verify competitor locally → conditional absence-only remote create and persist alternate ACK → resolve original using Keep local or Use remote ordering → release both aligned paths | Partial local copies are retained and recorded. Any changed/colliding path blocks. Original ACK changes only after selected primary is proven. |
| **Manual merge** | No built-in automatic or modal merge | Operator edits a local note using Obsidian, then opens a fresh review and chooses Keep local/Keep both | Editing invalidates the old review. The merged bytes use the ordinary exact local evidence and conditional remote PUT. |
| **Defer** | Operator or no action | No mutation; retain review/blocker | Fresh review later; unrelated paths progress. |

### General harmful-decision matrix

| Local/baseline/remote at commit | Action/preservation | Local effect | Remote effect | Required result and surviving bytes/revisions |
| --- | --- | --- | --- | --- |
| Local generation/hash changed from review | Any | None | None | Reject stale; current local and sampled remote remain; existing archive remains |
| Remote format-2 revision changed, including same text | Any action targeting it | None beyond already proven archive | None | CAS/revalidation rejects; both current remote revision and local/archive bytes survive |
| Baseline or M3 unresolved effect changed | Any | None | None | M3 owner wins; review stale; no ACK refresh |
| Keep local, remote archive verified, remote PUT confirmed | Keep local | Original local unchanged | Fresh receipt/revision from sampled parent | Local bytes, archived old remote bytes, and new remote revision survive; baseline updates last |
| Keep local, archive verified, remote effect unknown | Keep local | Original local unchanged | Unknown | Local + archive survive; intent blocks; exact receipt evidence only may complete |
| Use remote, local archive verified, local replace confirmed | Use remote | Remote bytes at original | None | Archived old local bytes and remote current revision survive; baseline updates only after state save |
| Local replace succeeds, state save fails | Use remote/restore | New local plus archive | None | Durable pre-intent enables restart proof; mutation admission globally fenced; no false completion |
| Eligible keep-both copy succeeds, original resolution fails | Keep both | Alternate + archive survive | Original remote unchanged/unknown | Partial phase persists; no cleanup; operator can resume/re-review |
| Persistence fails before first effect | Any | None | None | Operation not dispatched; all originals survive |
| Process restarts after any phase | Any | Inspect exact phase/evidence | No blind retry | Resume only from exact hashes/revisions/receipts; otherwise block with all materialized copies retained |

## Explicit adoption and remote-state cases

Every format-2 adoption/recreate action requires the remote receipt association to
match the current binding. A mismatch is unsupported lineage and remains blocked.

| Remote/local situation | Permitted explicit action | Baseline rule |
| --- | --- | --- |
| Unknown same-association format-2 live, local absent | Import exact remote to local after revalidation | Adopt exact revision only after create/verify/save |
| Unknown format-2 live, same local text | Associate exact remote revision | Equality is not authority; operator gesture + exact revision and local hash establish it |
| Unknown format-2 live, different local text | Live/live actions | Preserve competitor before mutation; no direct adoption |
| Unknown format-2 tombstone, local absent | Adopt exact tombstone | Exact absence + operator gesture; no local write |
| Unknown tombstone, local live | Tombstone actions below | No automatic deletion/adoption |
| Remote physically absent, local live and unassociated | Ordinary M3 absence-only create, if no M4 blocker | Not adoption |
| Remote physically absent for established ACK | Preserve/block as lineage loss | Never create/update from a refreshed absence |
| Legacy remote, any local state | Forked import to a different absent path, export/preserve, or defer | Original legacy path remains unassociated; no same-path baseline |

Legacy fork uses no new API: exact bytes are preserved, a different local path is
created, and existing conditional PUT creates a new format-2 generation only if that
remote destination remains absent. The original legacy object is never normalized or
overwritten.

## Remote tombstone matrix

| Local evidence | Acknowledged baseline | Exact remote | Operator decision | Result |
| --- | --- | --- | --- | --- |
| Fresh absent | Live/unassociated | Tombstone T | Adopt deletion | Revalidate absence/T; record T baseline; no local mutation |
| Fresh live, hash equals live ACK | Live A | Tombstone T | Preserve/defer, copy to an alternate path, or reject deletion | No plugin removal is permitted; T remains unresolved unless exact recreation is chosen |
| Fresh live, hash differs from live ACK | Live A | Tombstone T | Preserve/defer, copy to an alternate path, or reject deletion | Changed bytes survive; no plugin removal/adoption of T |
| Fresh live | Live/tombstone | Tombstone T | Reject deletion | Preserve existing recovery by leaving it untouched; conditional recreate from T with exact local bytes; ACK fresh live revision |
| Locally recreated after acknowledged T | Tombstone T | Tombstone T | Recreate remote | Exact conditional recreation; no absence-based create |
| Any live | Any | Tombstone T | Keep both | Preserve/copy local to archive or chosen alternate and leave T unresolved; adoption waits for a later fresh local-absence review |
| Unknown/unstable/partially hydrated | Any | Tombstone T | Any destructive choice | Block; defer/refresh only |
| Evidence changes while open | Any | T or newer | Any | Stale review; no further effect |

A tombstone can be adopted only after fresh local absence. M4 never calls hard local
delete or rename-as-delete; an operator-initiated Obsidian removal requires a new
review. Remote physical absence is not a row in this matrix because it is not a
tombstone and supplies no deletion authority.

## Recovery restore

1. List bounded recovery metadata through the existing API; selection identifies
   recovery UUID and exact metadata revision.
2. Inspect metadata, read content, validate strict UTF-8/size/hash, and re-inspect the
   selected revision/status immediately before persisting the restore intent and again
   immediately before the local effect.
3. Choose the original eligible path or another operator-entered eligible NotePath.
   Invalid, excluded, dot/config, occupied-folder, and oversized destinations refuse.
4. If absent, create-only. If occupied, require a different path or explicit archive
   plus atomic compare-and-replace. No silent collision suffix.
5. Persist the active `restored-pending-review` operation phase before the local
   mutation; consume the plugin's own host event without granting ordinary outward
   authority.
6. Verify destination bytes and persist the local effect. The active reservation
   survives restart/re-enable, blocks handoff, and excludes the path from ordinary M3
   scheduling. Do not mutate the remote head or update its baseline.
7. Present a new review: keep local/recreate remote, associate an exact live head,
   publish an alternate absent path, or defer. The restore may become terminal only
   when the fresh reviewed successor operation is linked and takes over the same path
   atomically. Completion of that successor may release ordinary M3 ownership.

Prepared and unexpired sealed recovery are recoverable. Missing, changed, expired, or
purged content is refused. Restore to an original path does not imply the current head
is still the matching tombstone. Restart reconciles exact destination hash and phase;
it never repeats a create over a collision or assumes an interrupted host write failed.

## Deferred rename/history reconciliation

M4 reviews current evidence, not imagined history. It groups every path referenced by
an M3 rename plan plus current local/remote states and exact ACKs.

| History state | Permitted operator choices | Required preservation/safety |
| --- | --- | --- |
| Destination ACK exact; source remote still expected; local source absent | Complete source cleanup | Preserve source remote content, then recovery-first conditional tombstone exact source revision |
| Source and destination both live | Retain as independent notes, choose one canonical path, or complete remote source cleanup | Preserve every version that will be replaced/tombstoned; adopt exact revisions explicitly |
| Rename chain A→B→C with exact current evidence | Map each current generation to an existing/new destination or keep independent | Reserve all involved paths lexically; execute one proven step at a time; no history inference |
| Overlapping renames | Defer or explicitly map current notes | No automatic chain collapse; unrelated paths continue |
| Remote edit at former source | Keep/adopt as independent, import, or preserve then explicitly tombstone | Old cleanup authority is invalid; exact new revision requires fresh choice |
| Locally recreated source | Treat as independent current local note | Never consume the old cleanup permission to remove recreated bytes |
| Destination moved/edited again | Review current destination(s) | Old destination prerequisite is stale; preserve and remap explicitly |
| Insufficient/contradictory history | Keep current versions/defer and choose explicit current mappings | No arbitrary historical reconstruction or cleanup |

A grouped operation persists every reserved path and completed step. It never claims
an atomic multi-key rename. A remote tombstone step remains recovery-first. If a
chosen mapping requires a local rename/removal, the operator performs it in Obsidian
and starts a fresh review; M4 never executes that stale-sensitive host effect.

## Durable state and migration

M4 schema version 3 is incompatible with M3 version 2 because old code must not ignore
partial resolutions. The durable additions are:

```text
MirrorDeviceState
  + reconciliationReviews[]       # sparse, content-free sampled metadata/status
  + reconciliationOperations[]    # sparse durable confirmed actions
      authority/action/reserved paths
      immutable runtime + per-path local/baseline/remote/M3/recovery snapshot
      phase, exact evidence-bound preservation receipts, restore successor link
      local/remote effect certainty
      no note bodies, bearer, or raw errors
```

Existing M3 path entries remain structurally unchanged during migration. The two
collections are bounded together by tracked paths, and validation rejects overlapping
reservations rather than duplicating operation references on every path.

Conceptual phases are closed and action-specific, for example:
`intent-persisted → preservation-required → preservation-proven → local-effect-* /
remote-effect-* → baseline-persisted → complete`, with `stale`, `unknown-effect`, and
`blocked` terminal/attention states. Impossible phase/action combinations fail strict
validation rather than falling through.

Migration occurs before runtime publication or any listener/network/local mutation:
strict v2 decode → deterministic v3 projection preserving every field → v3 validate →
one same-key save → read-back exact decode. Failure is state-unavailable. A valid v2
value retries; malformed/unknown versions remain untouched and fail closed. M3 code
sees v3 as unsupported, providing the downgrade fence. Runtime-owner version also
increments; same-realm M3↔M4 replacement refuses and requires a host restart.

No reverse migration exists. Handoff lifecycle/staged data is preserved without
activation. Active M4 operations block handoff export. Valid historical rollback may
remain undetectable and requires paused revalidation. See
[ADR 0008](../decisions/0008-m4-device-state-migration.md).

## Remote API audit

| M4 operation | Existing v2 capability | Sufficiency |
| --- | --- | --- |
| Describe association/designated writer | `GET /api/v2/mirror` | Sufficient; required before action |
| Discover remote candidates | paged `GET /api/v2/notes` | Sufficient; observational only |
| Read/compare revisioned or legacy note | note content + state GET | Sufficient; content is untrusted and bounded |
| Keep local/recreate tombstone | conditional note PUT | Sufficient; exact revision predicate |
| Preserve/review/adopt remote tombstone | state GET plus exact local evidence; optional archive/copy | Sufficient; adoption is absent-only and has no remote mutation |
| Read recovery | recovery list/metadata/content GET | Sufficient; GET remains read-only |
| Existing maintenance | seal/purge POST | Unchanged; not restore |
| Complete reviewed source cleanup | recovery-first conditional DELETE | Sufficient; exact live revision |
| Same-path legacy adoption | No unique conditionable legacy generation | **Not permitted**; fork to a different path |

M4 adds no Worker/API/OpenAPI/CORS operation and no server database/history. Remote
DTO validation and effect certainty stay in the plugin transport adapter. A future
same-path legacy conversion requires a successor ADR and exact generation predicate.

## One-writer decision

M4 does not require a second writer. The same designated plugin owner performs both
M3 outward work and explicit reviewed reconciliation. Path reservations serialize M3
and M4 work locally; Worker revisions serialize remote mutations. Other clients may
still cause divergence through the privileged API, but they do not become plugin
writers. Multi-writer expansion, election, leases, and automatic takeover are removed
from M4 implementation scope.

## Application architecture and semantic owners

```text
commands / review modal / status
    ↓ typed commands and sanitized projections
ReconciliationReviewService (read-only sampling facade)
ResolutionCoordinator (phase routing only)
    ├─ DivergenceClassifier
    ├─ ReviewEvidencePolicy / DecisionValidator
    ├─ ConflictPreservationService
    ├─ LiveResolutionService
    ├─ RevisionedAdoptionService
    ├─ RemoteTombstoneResolutionService
    ├─ RecoveryRestoreService
    └─ RenameHistoryResolutionService
    ↓
ReadOnlyLocalVault + LocalReconciliationWriter + RemoteBridge + MirrorStateOwner
    ↓
Obsidian read/mutation adapters + existing bounded Fetch adapter
```

Semantic ownership is explicit:

| Policy | Authoritative owner |
| --- | --- |
| Divergence classification | `DivergenceClassifier`, pure core decision table |
| Review evidence/snapshot identity | `ReviewEvidencePolicy` and typed review contracts |
| Operator-decision/stale validation | `DecisionValidator`, pure core policy |
| Conflict preservation requirement/receipts | `ConflictPreservationService` |
| Local mutation execution | `LocalReconciliationWriter` port and Obsidian adapter mechanics |
| Cross-boundary phase ordering | `ResolutionCoordinator` using action-specific services; no policy duplication |
| Revisioned adoption | `RevisionedAdoptionService` |
| Tombstone review | `RemoteTombstoneResolutionService` |
| Recovery restore | `RecoveryRestoreService` |
| Deferred history | `RenameHistoryResolutionService` |
| Version-2→3 migration | strict adapter codec/migrator plus core v3 validation |
| State serialization/admission | existing `MirrorStateOwner`, extended with validated operation transitions |

The coordinator may route phases but must not implement classification, stale checks,
preservation rules, local adapter mechanics, every action matrix, UI formatting, and
migration in one module. Each closed decision table receives focused unit tests. Core
imports no Obsidian, HTTP/Fetch, Hono, Cloudflare, R2, or filesystem types.

## UI/UX model

M4 adds two focused commands:

- **AI Bridge: Review remote divergence** — bounded candidate list and one detail
  modal for the selected path/group;
- **AI Bridge: Restore recovery snapshot** — bounded recovery selection and
  destination confirmation.

Settings continue to own configuration/consent/health controls, not reconciliation
policy. Status adds review/stale/partial-operation counts and sanitized per-path
outcomes. The detail modal shows path, local state/hash/timestamp when useful,
acknowledged revision, remote kind/revision, conflict type, available typed actions,
stale status, and verified preservation path/result.

Local and remote text previews, when explicitly opened, use text-only DOM APIs such as
`textContent`/read-only text controls. They never use Markdown rendering, HTML
insertion, link execution, command interpretation, or note instructions. Large text
remains bounded. Paths and errors are sanitized; the UI never exposes bearer values,
raw transport exceptions, storage validators, envelopes, or hidden recovery internals.

Modal close/unload invalidates its session. No polling loop keeps a review current.
Refresh is explicit and returns a new review ID. Buttons disable after one submission;
application revalidation, not button state, protects correctness.

## Security and trust analysis

- Remote Markdown, legacy bytes, recovery content, paths, DTOs, and persisted state are
  untrusted input. Validate strict UTF-8, actual bytes, schemas, revisions, receipts,
  and NotePath before display or mutation.
- Never render remote Markdown as HTML or execute links, embeds, scripts, commands,
  frontmatter, templates, or note-like instructions during review. A confirmed import
  becomes ordinary vault plaintext and may be indexed/observed by other trusted-host
  plugins, so the UI warns before writing and does not automatically open or render it.
- Reserved conflict paths are generated solely from a validated operation UUID and
  fixed side names. Remote path text is ledger metadata, never path concatenation.
- Use official Obsidian Vault APIs only; do not add raw filesystem/Node access. Do not
  claim protection from a malicious trusted host/plugin or undocumented symlink
  behavior beneath the host abstraction.
- Collision, path traversal, dot/config destinations, folder/file ambiguity,
  malformed Unicode/UTF-8, and >1 MiB text fail before mutation.
- Stale UI, replayed command, process restart, listener gaps, and configuration changes
  invalidate review authority. Unknown local/remote effects remain blocked.
- Conflict copies can contain sensitive plaintext. Status/logs persist only path/hash/
  revision metadata; operator cleanup is explicit. Never log or export bodies by
  default.
- The privileged bearer and plaintext trust boundary do not expand into M5 scoped
  permissions. Writer/association/review IDs are not secrets or authorization.

## Deterministic harmful-interleaving test plan

Tests use barriers/deferred promises at the real application-port boundaries. They
assert exact bytes, revisions, receipts, durable phases, and forbidden calls.

| Interleaving | Barrier and expected result | Bytes/revisions that must survive |
| --- | --- | --- |
| Local edit while remote review read is pending | Hold remote content; emit/save local B before response | Local B and remote sampled/current generation; review classified stale; no write |
| Remote edit after review before admission commit | Hold commit revalidation; replace R with R2 | Local bytes, R2, and any archive; no mutation from R predicate |
| Local edit after admission while remote PUT is pending | Admit exact local A; save B before PUT settles | Remote ACK records admitted A, local B remains successor dirty/reviewable, archive survives |
| Remote edit after final evidence point while local replace is pending | Admit/apply sampled R while remote advances to R2 | Archived old local, local sampled R, and remote R2 survive; path returns to remote-ahead review |
| Same-text ABA local | Review A; events A→B→A increment generation | Final A survives; old review stale despite equal hash; no effect |
| Same-text ABA remote | Review revision R(A); remote R2(B)→R3(A) | R3 survives; revision mismatch rejects |
| Lost remote ACK | Commit conditional PUT, withhold response | Local + archive + committed revision survive; exact receipt evidence completes, no latest adoption |
| Local write succeeds, remote follow-up fails | Keep-both/keep-local: verify local copy, then remote refusal/unknown | Original/local alternate/archive and old or committed remote generation survive; phase partial |
| Remote write succeeds, local/state follow-up fails | Remote commit then fail ACK-state save | New remote revision + local/archive survive; global persistence fence; exact receipt resumes |
| Restart between every multi-step phase | Stop after intent/archive/local/remote effect | All materialized files/remote generations survive; only exact phase resumes |
| Unload/re-enable with review open | Detach epoch before click/re-enable | UI command stale; no mutation; owner work remains |
| Stale UI command/replay | Submit same review twice or after refresh | At most one intent/effect; second command stale |
| Local delete event versus remote edit | Hold M3 delete evidence/effect while remote changes | Remote edit and recovery/current heads survive; M4 blocked behind M3 |
| Remote tombstone versus local recreation | Review T while local is recreated/edited | Local bytes survive; old decision stale; T unchanged unless fresh recreate chosen |
| Recovery restore path renamed during review | Hold content read; rename destination before commit | Renamed/current file and recovery bytes survive; no write at stale path |
| Restore collision | Destination appears after absence sample | Existing destination untouched; recovery remains; create refused |
| Legacy fork collision | Local or remote chosen destination appears | Legacy source and collider survive; no normalization/overwrite |
| Local write failure/unknown | Fail before effect and after possible host effect separately | Before: originals unchanged. Unknown: inspect both paths, retain archive, block |
| Persistence failure after local mutation | Verify local write then fail state save | Written local + preservation + original remote survive; admission fenced |
| Partial hydration during evidence sample | Hold local read/listener epoch; replace identity/metadata | No mutation; unknown-local/stale; remote untouched |
| Rename chain changes during review | Hold grouped review; observe next rename/edit | Every current local/remote generation survives; group stale; no old cleanup |
| Unrelated-path progress | Block path A at preservation/evidence; run ready B | A remains blocked and preserved; B uses ordinary bounded M3 progress |
| No infinite retry/poll | Fail reads/effects through configured finite budgets and advance fake clock | No hidden task after budget; durable blocked state and all bytes remain |

Additional tables cover each classifier row, tombstone row, resolution action/phase,
state migration variant, malformed untrusted input, path collision, and transport
effect certainty. A test that resolves the competitor before opening the barrier does
not count as interleaving evidence.

## Sequential implementation

The bounded test-first sequence is normative in the
[M4 plan](../plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md):

1. **Implemented:** closed contracts, state v3, strict migration, and runtime downgrade fence;
2. **Implemented:** read-only evidence sampling and pure divergence/stale-decision policy;
3. **Implemented:** narrow local mutation adapter and verified preservation;
4. revisioned adoption and live/live action orchestration;
5. remote tombstone resolution and local-first recovery restore;
6. bounded deferred rename/history resolution;
7. runtime/session/command/modal/status composition;
8. generated artifact, operational/security documentation, qualification, and final
   semantic gates.

No slice exposes a user mutation before its preservation, stale validation, durable
state, restart, and focused tests exist.

## Slice 1 implementation evidence

- Core exports closed typed authority, classification, review status, action, operation
  phase, local/remote evidence, reservation, effect, recovery identity, and
  preservation-receipt contracts. M3 saved-event authority remains M3-owned.
- Device-state schema version 3 retains the M3 lifecycle, device/binding identity,
  paths, ACKs, desired state, unresolved intents/phases/budgets, blockers, delete and
  rename evidence, staged handoff, and global fences exactly. It adds only bounded
  sparse `reconciliationReviews` and `reconciliationOperations`; no body/payload or
  arbitrary-record field exists.
- Core validation indexes tracked paths, review/operation IDs, and active reservations
  once; it rejects duplicate IDs, overlapping active paths, unreserved related paths,
  invalid tracked/new destinations, foreign-association or incoherent exact-receipt
  evidence, incompatible classification/action/authority/phase/effect/preservation
  combinations, preservation hashes/revisions not derived from sampled bytes,
  unowned terminal restores, impossible review/successor links, M3-effect precedence
  violations, deferred-history conflicts, and capacity overflow.
- `device-state-v2.codec.ts` is a frozen strict historical decoder. The current strict
  codec writes only version 3; each decoder refuses the other version.
- Startup performs detect → strict decode → deterministic in-memory projection → v3
  validation/encode → one same-key save → one exact read-back comparison/strict decode
  before constructing `MirrorStateOwner`. Load/decode/invariant/encode/save/quota/
  read-back/integrity/version failures fail closed without reset or in-memory publish.
  Valid untouched v2 retries; a committed v3 whose read-back failed loads as v3 next
  startup.
- Runtime owner and same-realm registry structural versions are both 3. M3 and M4
  owners/registries refuse each other; compatible M4 replacements retain the owner.
  Active M4 operations block handoff drain/export, while empty M4 state preserves M3
  handoff behavior and staged/draining/drained authority exactly.
- Deterministic tests migrate exactly 50,000 M3 path entries within the unchanged
  8 MiB codec bound with empty M4 collections and no per-path placeholder growth.
  Final canonical validation passes 64 source files / 880 tests at 95.00%
  statements, 91.35% branches, 98.47% functions, and 96.98% lines, plus eight
  storage qualification tests and six generated-artifact tests.
- No UI, commands, modals, settings actions, local writer/Obsidian mutation adapter,
  Fetch/RemoteBridge change, Worker/API/OpenAPI change, deployment configuration,
  M4 timer, or reconciliation scan is introduced.

### Migration decision matrix

| Stored value / decode | Migration-validation-save-read-back | Registry compatibility | Result |
| --- | --- | --- | --- |
| Missing | Existing new-device v3 provisioning succeeds | Compatible/empty | Publish new disabled v3 owner |
| Valid v2 | All stages and exact read-back succeed | Compatible/empty | Migrate once and publish v3 |
| Valid v2 | Migration, validation, encode, save, quota, integrity, or read-back fails | Any | Fail closed; retry later if stored value remains v2 |
| Save committed v3, read-back failed | Next startup strictly decodes v3 | Compatible/empty | Load v3; never reinterpret as v2 |
| Valid v3 | No migration | Compatible/empty | Strict-load and publish v3 |
| Valid v2/v3 | N/A | Existing incompatible M3/M4 registry/owner | Fail closed without replacement/reset |
| Version 1, future, malformed, corrupt, or integrity mismatch | No migration/save | Any | Unsupported/corrupt/unavailable; stored value untouched where host save did not commit |

### Slice 2 implementation evidence

Slice 2 implements the core-only, read-only review seam: bounded candidate discovery
across tracked/local/remote/recovery inventories; exact local and remote sampling;
content-free immutable snapshots with transient target bodies; deterministic
classification and allowed-action policy; same-text local observation generations;
new-ID refresh/stale lifecycle; and serialized, evidence-revalidated admission through
`MirrorStateOwner`. Admission persists only a content-free review/operation pair and
never receives a local writer or remote mutation capability. Focused unit tests cover
the classification table, M3/availability precedence, physical absence semantics,
exact revisioned adoption, review refresh, same-text staleness, serialized persistence,
and the no-mutation boundary. Slice 2 does not compose UI, local mutation,
preservation, tombstone resolution, restore, history execution, deployment, or vault
installation.

### Slice 3 implementation evidence

Slice 3 implements a separate `LocalReconciliationWriter` with only eligible
create, exact compare-and-replace, and generated create-only preservation commands.
Core application services authorize each command against one active durable operation,
its action, exact path evidence, reservation, phase, preservation matrix, and transient
content digest. They persist a prepared local effect or pending preservation receipt
before host dispatch, settle only post-verified evidence, retain `unknown` certainty
when an effect cannot be proven, and fence later effects after persistence failure.
Same-operation recovery is explicit and may adopt only exact expected bytes.

The Obsidian adapter uses only official `Vault` lookup/create/createFolder/read/process
operations through a narrow host wrapper. It builds preservation folders component by
component, never interpolates a source path into the reserved tree, refuses every
file/folder/config-root collision, performs compare-and-replace inside `Vault.process`,
and rereads exact identity/text/hash after effects. It exposes no delete, rename, move,
trash, filesystem, generic Vault, or remote capability. Conflict artifacts remain
outside mirroring through the existing dot-segment exclusion. Focused tests cover
collisions, concurrent changes, host ambiguity, postcondition failures, pending →
verified receipt ordering, persistence barriers, restart recovery, multi-path
reservations, event-generation fencing, malicious/inert content, and port-capability
negatives. The primitives are not composed into the plugin runtime or UI; Slice 4 owns
action orchestration.

### State relationship matrix

| Lifecycle / M3 state / M4 state | Authoritative outcome |
| --- | --- |
| Disabled or handoff-staged + any M4 review/operation | Invalid |
| Active/paused + no unresolved M3 effect + disjoint valid sparse M4 metadata | Valid |
| Any active M4 operation + reserved path with unresolved M3 mutation | Invalid; M3 effect wins |
| Deferred rename + non-history active M4 operation | Invalid; deferred history wins |
| Deferred rename + exact history action | Valid contract state; no Slice 1 effect capability |
| Overlapping active M4 reservations | Invalid |
| Persisted restore intent or confirmed local effect + `restored-pending-review` | Active reservation fences M3 scheduling and handoff across restart |
| Completed restore + no linked successor owner | Invalid |
| Completed restore + linked reviewed successor on the restored path | Valid atomic ownership transfer; successor remains the fence until its reviewed completion |
| Handoff-draining + active M4 operation | Migration-preserved but not drainable/exportable |
| Handoff-drained + active M4 operation | Invalid/export-blocked |
| Empty M4 collections + valid M3 lifecycle/handoff | Valid and behavior-preserving |

## Acceptance checklist

Slices 1–3 establish the contract, migration, read-only evidence/admission, and
uncomposed local-effect/preservation prerequisites. The end-to-end M4 acceptance
items remain incomplete until the later behavior slices are implemented.

- [x] **A1 — Authority and writer model:** Reviewed-only remote-to-local authority is
  typed end-to-end; one designated writer remains; no automatic import, last-writer-
  wins, election, lease, or blocker refresh exists.
- [x] **A2 — Classification and review evidence:** Every required reconciliation
  state and classification precedence is implemented with exact local/baseline/remote/
  recovery evidence and focused decision-table tests.
- [x] **A3 — Stale decisions:** Local events/ABA, remote revisions/ABA, lifecycle,
  path, configuration, epoch, restart, and review-ID changes reject stale commands
  before mutation; evidence is not silently refreshed.
- [x] **A4 — Local mutation and preservation:** `ReadOnlyLocalVault` remains read-only;
  the separate narrow writer enforces eligibility, size, absence/compare predicates,
  collision policy, post-verification, unknown effects, and archive-first safety. No
  local rename/delete exists, and no competing version is destroyed before durable
  preservation proof.
- [ ] **A5 — Conflict resolution and adoption:** Keep local, use remote, keep both,
  defer, explicit format-2 adoption, and legacy fork behavior pass phase/restart/
  unknown-effect tests. Equal text alone never creates a baseline.
- [ ] **A6 — Remote tombstones:** Locally absent/live/modified/recreated/unstable rows
  pass exact tests; absent-only adoption and live preserve/recreate/copy/defer choices
  are explicit; no plugin local delete/move, remote tombstone, or absence silently
  removes local content.
- [ ] **A7 — Recovery restore:** Exact prepared/unexpired selection, destination and
  collision checks, preservation, local-first write, restored-pending-review fence,
  stale evidence, restart, expired/purged negatives, and no GET-side mutation pass.
- [ ] **A8 — Rename/history:** Deferred cleanup, duplicates, chains, overlaps, former-
  source remote edits, recreated sources, and later destination edits preserve all
  versions and require explicit current-state choices without pseudo-atomicity.
- [ ] **A9 — Migration/restart:** Strict deterministic v2→v3 migration preserves all
  M3 intents/blockers/handoff data, fails closed, read-back verifies, rejects unknown
  versions, fences downgrade/runtime replacement, and reconciles every M4 partial
  phase to exact resume, completion, stale, unknown-effect, or blocked state without
  body history.
- [ ] **A10 — API, security, and UX:** Existing v2-only capability is proven sufficient;
  OpenAPI/CORS remain synchronized and unchanged unless implementation evidence forces
  a successor decision. Text-only review, path/content validation, sanitized status,
  token/body/log negatives, and malicious Markdown tests pass.
- [ ] **A11 — Qualification and canonical gates:** Generated CommonJS artifact tests
  proportionally exercise real built review→preservation→conditional action and stale
  session behavior. `mise install`, `mise run install`, `mise run check`, runtime
  qualification, four-metric coverage thresholds, diagnostics/editor review,
  Markdown links, `git diff --check`, and secret/generated-artifact scans pass. Real
  host/deployment/iCloud evidence or its absence is reported exactly.
- [ ] **A12 — Documentation, review, and transition:** Architecture/current-state/API
  (if changed)/security/plugin-development/operations/migration/conflict runbooks match
  implementation; independent `/skill:code-review` finds no unresolved blocking issue;
  completion evidence is recorded; only then is M4 COMPLETE and M5 made the single
  NEXT milestone in the completion PR.

## Non-goals

No automatic bidirectional sync, silent last-writer-wins, blanket remote authority,
automatic or equal-text adoption, same-path legacy normalization, automatic merge,
local rename/delete, arbitrary history reconstruction, multi-writer coordination,
election/leases, remote event log, database/DO/queue, attachments, collaboration,
replacement of iCloud/Obsidian Sync, M5 permission redesign, MCP, search/inference,
production certification, deployment, or personal-vault installation.
