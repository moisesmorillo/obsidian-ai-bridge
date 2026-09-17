# ADR 0008 — M4 device-state migration and downgrade fence

## Status

**Accepted — implemented in M4 Slice 1.** Device-state v3, frozen v2 decoding,
deterministic same-key migration/read-back, downgrade refusal, sparse validation, and
runtime registry version 3 are executable. No later M4 reconciliation behavior is
implemented.

## Context

M4 adds durable review/resolution intents, preservation receipts, partial local/remote
effects, and restored-pending-review state. Reusing M3 schema version 2 would let old
code ignore safety-critical fields. Host-local storage offers replacement of one value
but no cross-process transaction, rollback detector, or safe multi-key commit.

Migration must preserve every M3 acknowledgement, unresolved mutation, retry/evidence
budget, blocker, delete authority, deferred rename plan, lifecycle state, and staged
handoff. A valid historical rollback can remain indistinguishable from a current
valid snapshot.

## Decision

M4 introduces device-state schema **version 3** under the existing
`ai-bridge:mirror-device-state` key. The corrected Slice 1 contract retains version 3:
no implemented runtime can create a non-empty M4 review/operation collection, so every
reachable persisted v3 value and every v2→v3 migration remains unchanged and empty at
this boundary. No new evidence is inferred during migration. Version 3 preserves every version-2 path entry
unchanged and adds two sparse bounded top-level collections:

- content-free review records with classification, review ID, one immutable runtime/
  configuration/listener and per-path local/baseline/remote/M3/recovery snapshot, and
  stale/open status;
- reconciliation operations with one operation ID, reserved paths, typed authority/
  action, an exact copy of the immutable snapshot, phase, evidence-bound preservation
  receipts, explicit `restored-pending-review`/history blockers, optional linked
  reviewed successor ownership, and local/remote effect certainty.

Neither collection contains a bearer, note body, remote response body, raw error, or
body history. Their combined path references are bounded by the existing tracked-path
limit; no null M4 fields are appended to all 50,000 M3 entries. On startup, read-only
reviews without an active operation become stale before UI/action admission; confirmed
operation phases retain restart authority. Core validation rejects duplicate IDs,
overlapping reservations, references to unknown/untracked paths where the action
requires an existing entry, invalid phases/effects, and operations inconsistent with
lifecycle or M3 unresolved intents.

### Migration boundary

Migration runs once at startup before listeners, runtime-owner publication, remote
admission, review UI, or mutation capability:

1. load the raw existing value;
2. strictly decode and validate the complete version-2 state with the frozen v2
   decoder, including staged-handoff integrity;
3. deterministically project every field unchanged into version 3, adding no reviews
   or operations;
4. validate the complete version-3 invariants;
5. replace the same host-local key once;
6. load it again and require an exact canonical version-3 decode before creating the
   state owner.

No network or vault mutation occurs inside migration. If save, read-back, integrity,
validation, quota, or host capability fails, startup is state-unavailable and all M3/
M4 mutations remain disabled. The old in-memory version-2 value is never published as
an M4 owner. On restart, a valid v2 value retries the deterministic migration, a valid
v3 value loads normally, and malformed/partial data fails closed.

The existing key is reused deliberately. After a successful write, M3 code sees
unsupported version 3 and fails closed rather than loading a stale side-by-side v2
ledger. Version 1 and unknown future versions remain unsupported. There is no reverse
migration and no safe downgrade while version-3 state or format-2 remote effects may
exist.

### Runtime replacement, handoff, and rollback

The same-realm runtime-owner structural version also increments. An M4 plugin finding
an M3 owner, or vice versa, refuses to replace it; the operator must pause/drain where
possible and restart the host so migration occurs before a new owner exists.

Disabled, active, paused, handoff-draining, handoff-drained, and handoff-staged states
migrate without changing authority. Existing handoff record format may remain
content-free and import into a version-3 owner only through current validation; an
active reconciliation operation blocks export/handoff like unresolved M3 work.

A valid historical version-2 or version-3 local-state rollback may be undetectable.
Operators must pause and revalidate local hashes, remote revisions, designation,
unresolved M3 effects, and M4 preservation/effect evidence. Restoring an old value,
running old plugin code, or clearing operations to make the state load is unsupported.
Preserve the bytes and upgrade/reconcile forward.

## Consequences

Migration is small, deterministic, and body-free, while downgrade fails closed. The
version-3 codec bound must accept the largest valid version-2 encoding plus the two
empty sparse collections; actual host quota failure still fails closed. Replacement
cannot be claimed fully transactional or fsync-safe; read-back and fail-closed startup
are the available host guarantees. Schema version 3 is required
even though most M3 records gain only empty M4 fields, because old code must not ignore
future partial-resolution state.

## Alternatives

Keeping version 2 was rejected because ignored M4 fields could authorize stale M3
work. A second side-by-side key was rejected because downgrade would load the stale
v2 key. Destructive reset was rejected because it loses unresolved authority and
effect evidence. A database was rejected because host-local bounded metadata does not
justify new infrastructure.

## Evidence / related documents

[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[M4 implementation plan](../plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[ADR 0003](0003-publishing-association-and-local-state.md), and current strict codec
`apps/obsidian-plugin/src/state/device-state-codec.ts`.
