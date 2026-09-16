# ADR 0003 — Single-writer mirror association and per-path state

## Status

**Accepted — Worker designation guard implemented in Slice 2C; device-local state,
serialized ownership and handoff model implemented in Slice 3.** Supersedes this
unmerged PR's per-note/manual/global-interlock proposal. The Worker validates static
association/writer UUIDs and guards every v2 mutation. Slice 3 adds strict uncomposed
native-secret-reference/preferences and App-local state adapters plus core activation/
handoff policy. Slice 4 implements uncomposed Fetch transport; Slices 5–6 implement
uncomposed core bootstrap, positive sync and runtime lifecycle orchestration. Settings
UI, host event/timer composition and remote handoff verification remain later M3
work. The filename is retained for existing links.

## Context

iCloud is the device-to-device working-vault synchronization mechanism, not a
transactional store for mirror baselines. Copying plugin data.json between devices
cannot coordinate writers or preserve independently changing ACK ledgers. An
unresolved global single-note slot is disproportionate for automatic whole-vault
work. Conversely, a durable queue of note bodies duplicates sensitive vault data.

## Decision

### Whole-mirror opt-in and designation

One local activation enables the whole eligible Markdown mirror, not individual
paths. Newly installed/non-writer devices default to disabled. Keep endpoint and
SecretStorage reference preferences in plugin data.json; store writer activation,
device UUID and mirror ledger via official App.loadLocalStorage/saveLocalStorage,
which are vault-specific **host local storage**, not files in the iCloud vault.
Validate both stores, and never use copied data.json to designate a writer.
Host local storage is not a keychain or an fsync/transaction guarantee. Detectable
quota/corruption/storage failures must fail closed. Restoration of otherwise valid
historical state is not automatically detectable: it requires explicit paused
revalidation, not a claim that schema checking proves absence of rollback.

The Worker has explicit non-secret operator configuration for one
`MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID`. Missing/malformed configuration
disables v2 mutations. An authenticated `/api/v2/mirror` describes the association,
configured writer, protocol/retention capabilities. The plugin displays its own
device UUID for operator setup; no platform name or filesystem path is an identity.
Any supported desktop/mobile device can be chosen.

To activate: configure HTTPS/development origin and SecretStorage reference,
explicitly acknowledge full eligible scope, and verify that the authenticated
Worker association and writer IDs equal the intended association and this device's
local ID. Record that binding and enable on this device only. Autosync is disabled
on mismatch; no automatic election or attempt to change the Worker designation.
Every v2 mutation carries both IDs and the bearer; Worker rejects mismatch as 403
before storage. Token is retrieved at dispatch, never persisted outside SecretStorage.

The static ID guard prevents accidental cooperating non-writer instances sending
mutations. **It is not a new secret, lease, distributed fence or permission scope**:
the current bearer remains privileged, and a malicious holder could impersonate
an ID. Trusted non-plugin clients using that privileged contract can still change
remote generations; plugin CAS detects that divergence. Future scoped read/write/
MCP authorization belongs at Worker/auth, not in mirror eligibility or device names.

### Per-path state, not a content queue

Core owns a closed versioned per-path state machine. Persist, for each tracked path:

- last ACK: unassociated, live(revision, content SHA-256), or
  tombstone(revision, recovery snapshot ID);
- at most one unresolved mutation: operation UUID/action, original precondition,
  attempted content hash when applicable, association identity, consumed retry/
  evidence budget and phase; no body;
- coalesced desired state: dirty-present, runtime-delete evidence, or rename
  prerequisite/deferred-cleanup state; destructive evidence includes observation
  generation, post-bootstrap authority and the prior acknowledged association;
- sanitized blocked reason where operator attention is needed. No arbitrary error
  text, selected flags, retained note bodies or one record per keystroke.

Create/modify work is reconstructible from the current vault and acknowledged hash;
startup rescans it rather than replaying a historic text queue. Destructive intent
is not reconstructible from absence: persist runtime delete/rename evidence before
any corresponding mutation. Multiple paths may be unresolved; only that path and
its rename dependencies block. Authentication, designation, connection or state-store
failure pauses the whole coordinator. Retained state is proportional to tracked
paths plus unresolved rename prerequisites, not the number of ordinary edit events.

Every mutation intent is persisted before dispatch. Save an ACK and its sent hash
before releasing a path for the next generation. A changed local file during a
request stays dirty; the ACK is for the bytes actually sent, not newly read text.
A failed ACK save is confirmed remote effect / local-state-unrecorded: pause all
new mutations until local persistence is sound, then retain/reconcile the same intent.
No rollback DELETE or success notice pretending the state was recorded.

One application state owner serializes complete read-current/apply/persist transitions
across path jobs and preference updates. Serializing writes of stale snapshots is
not sufficient. External data.json changes pause/revalidate configuration; they do
not replace the local ledger or reactivate a writer. No cross-process transaction
or safe arbitrary restoration of browser storage is claimed.

### Re-enable/restart and uncertainty

A host-runtime-owned, versioned coordinator registry keyed by the actual vault/App
identity owns jobs, path reservations, loaded ledger and persistence exclusion.
It outlives individual Plugin instances and UI sessions in that JavaScript runtime,
including same-runtime bundle reload. The registry is a small plugin adapter boundary
on globalThis under a package-specific Symbol; validate the registry contract and
refuse an incompatible existing owner instead of replacing it while work is pending.
It is not a cross-device/process lock, and never exposes note bodies/tokens as UI
or serializable registry diagnostics. Core has no global host dependency.

Unload detaches event/UI ownership, stops timers/new dispatch and requests Fetch
abort. Keep reservations until actual local read/network/persistence settlement;
abort does not undo a Worker mutation. A replacement Plugin attaches to this owner
and cannot reset exclusions. Delayed onLayoutReady callbacks check their enable
identity before registering anything. An old completion may settle its exact
ledger intent through the owner, never write a stale whole-state snapshot or show
UI through a new session. Connection changes wait for the same drain barrier.

A process restart creates a new coordinator only after loading the persisted ledger.
Inspect unresolved operations for exact own receipts. If retrying is allowed,
reconstruct only bytes whose hash matches the original persisted intent and retain
its original precondition/operation ID. Otherwise block that path visibly. Startup
absence never creates a deletion intent. Retry budgets survive restart, repeated
notifications and re-enable. Lost/corrupt state cannot safely recreate associations
from equal remote text or new GET revisions.

### Safe writer handoff

No concurrent automatic takeover, election or lease:

1. On the old device, **Pause for handoff** stops new admission, detaches event
   intake and drains already accepted queued/started work and persistence. An
   unsatisfied dirty/delete/rename intent prevents a clean export. No admission of
   new events during the handoff pause; later changes are checked by the new writer's
   bootstrap, not silently claimed as delivered. Paused/missed removals are not
   reconstructed from absence.
2. Every dispatched operation must have a recorded outcome, or evidence that a
   completed original-condition generation makes every delayed duplicate unable
   to mutate. Client abort/timeout, a quiet interval, or a GET still showing the
   prior revision is not enough. Unresolved mutations/rename cleanup block handoff;
   read-only reports explain which paths need attention. Do not erase them to pass.
3. Export a validated **content-free handoff record**: schema/association/origin,
   acknowledged per-path states and integrity checksum. Exclude device activation,
   device ID, tokens and secret references. Pause remains durable on the old device.
   Export/import is explicit user-controlled metadata transfer, never iCloud locking
   or background ingestion of a shared file. No local note writes are needed.
4. The operator disables the old installation, changes Worker designation to the
   new device ID and rotates the bearer, updating trusted clients deliberately.
   Configuration alone cannot retract old requests, hence the preceding drain.
   This is a separately authorized operator action, never validation deployment.
5. The new device configures its own SecretStorage reference, explicitly imports
   the handoff record and verifies association/designation with the Worker. Verify
   each transferred ACK against current remote state; mismatch is divergence, not
   permission to adopt latest. Imports remain **staged** until one complete indexed
   evidence batch proves local saved hashes equal transferred live ACK hashes,
   transferred tombstones are locally absent, and remote ACKs still match. Apply that
   batch through one serialized owner save rather than one whole-ledger save per path.
   Missing/different local state blocks activation: iCloud may still be hydrating or
   hold stale content, not a new edit or deliberate recreation. Observe events during
   this verification and invalidate changed observations in collapsed batches. Do not fix
   a mismatch by adopting a newer revision or blindly overwriting either side.
   After this alignment gate, activate/bootstrap normal work. Subsequent runtime
   events follow ordinary M3 policy; missing scans never gain delete authority.
   Old device stays disabled.

If the old device/ledger is lost or cannot be made quiescent, **do not take over the
same association automatically**. Preserve it for M4/operator recovery. The safe
reset option is an explicitly provisioned new empty bucket/association with new
credentials and designation, leaving the old namespace untouched; old requests
must have no route to the new storage. Never point a reset association at the same
keys and pretend old pending writes disappeared. Do not provision resources merely
to validate this plan.

Ordinary endpoint change follows pause/drain then new setup; clear local activation
and secret reference, preserve/export old unresolved metadata rather than silently
forget it. No automatic transfer of ACKs between origins. A verified handoff within
the same association is the only M3 baseline import. A changed URL/bucket without
that explicit procedure is unassociated and create-only, not adopted by scanning.

## Consequences

The writer's availability bounds remote freshness; other devices continue using
iCloud normally. Local storage quota/crash loss can require explicit recovery;
plaintext note content is not duplicated locally. Device-local IDs can be copied by
host backup or malicious software; exactly-one-writer is a documented operating
constraint plus static guard, not a security isolation/leader-election guarantee.
Multiple Obsidian processes simultaneously writing the same local ledger are not
supported. The operator must run one writer host for that vault; process-wide crash
recovery uses server CAS/receipts rather than invented cancellation guarantees.

## Alternatives

Multiple active devices were declined for M3. A synced selected-note list is both
the wrong product and unsafe coordination. Leases/leader election/database are not
needed for explicit designation. A global unresolved slot stalls unrelated notes;
a durable body queue stores unnecessary plaintext and stale edits. Handing off by
copying data.json or refreshing every remote revision would silently reopen
association/conflict decisions reserved for M4.

## Evidence / related documents

[Approved decisions and API evidence](../plans/m3-design-decisions.md),
[conditional ADR](0002-conditional-remote-note-mutation.md),
[recovery ADR](0004-recoverable-mirror-deletions.md),
[M3 state model](../milestones/m3-remote-bridge-client-and-publishing.md#state-and-persistence).
M2's current main.ts and lifecycle tests serialize only a Plugin instance; M3 must
extend ownership, not assume those tests already prove instance-replacement safety.
