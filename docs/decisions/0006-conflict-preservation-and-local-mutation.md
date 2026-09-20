# ADR 0006 — Conflict preservation and bounded local mutation

## Status

**Accepted and implemented by M4.** Slices 1–5 establish preservation contracts,
the narrow local port/adapter, and core effects; Slices 6–7 compose the reviewed user
workflow; Slice 8 qualifies the packaged preservation path. M3 behavior remains
unchanged. [ADR 0009](0009-m4-history-runtime-and-device-state-v4.md) adds the
implemented step-scoped history artifact identity without weakening existing
create-only operation-scoped preservation.

## Context

M3's local-vault port is intentionally read-only. M4 must create or conditionally
replace selected local notes and must explicitly evaluate whether rename/delete/move
can be safe, but exposing Obsidian's full `Vault` to core would make application policy
unauditable. A live/live resolution can also cross the local vault
and remote Worker, which have no shared transaction. Replacing either side before a
durable competing copy exists could lose data.

Conflict copies could live only in remote recovery, only in an external download, or
inside the vault. Existing recovery covers deletion snapshots rather than arbitrary
live/live competitors. Download alone is outside the durable application workflow.
A local vault copy is available to the operator and can be verified through the same
host boundary, but it must not recursively enter the whole eligible mirror.

## Decision

### Preservation location

Before any action can replace a competing version or clean up its remote original,
M4 creates and verifies a local preservation artifact under:

```text
.ai-bridge-conflicts/<review-operation-uuid>/local.md
.ai-bridge-conflicts/<review-operation-uuid>/remote.md
```

Only the sides required by the action are created. The UUID is generated locally and
validated; remote paths never become directory components. The existing dot-segment
exclusion keeps these artifacts outside normal mirror eligibility without adding a
new scope exception. Content is plain Markdown bytes only. Traceability lives in the
content-free device ledger: operation ID, original NotePath, side, content SHA-256,
source revision when one exists, preservation path, and verified outcome. No
frontmatter, embedded command, remote metadata, token, or executable control data is
inserted into the note.

Creation is create-only. The reserved root must be outside the host's actual
configuration subtree; a configured-directory overlap blocks preservation. An
existing `.ai-bridge-conflicts` folder may be reused, but a file at that root blocks.
The operation-UUID folder must be absent when the intent is first dispatched. On
restart/unknown effect, only the same durable operation may inspect an existing folder
and adopt an exact expected side hash as effect evidence. Any unrelated existing
file/folder at that operation path, or mismatching side file, is a collision. The adapter never appends a suffix or
overwrites.
The application verifies the saved bytes after creation before recording
preservation. State validation derives every required receipt identity from the
admitted action and immutable sampled evidence: operation UUID, original path, side,
source revision/null relationship, generated preservation path, and exact content
SHA-256 must all match. A syntactically valid receipt hash is never authority by
itself. Operators own eventual cleanup after the resolution is complete. M4 does not
automatically delete preservation artifacts.

An explicit “keep both” action may additionally create the competitor at an
operator-chosen **eligible** locally and remotely absent NotePath. The resolution
creates and records its absence-only remote generation before that new note enters
ordinary M3 scope. The excluded
preservation artifact is still the safety copy until all selected actions settle.

### Dedicated local mutation port

Core defines a new `LocalReconciliationWriter` beside, not inside,
`ReadOnlyLocalVault`. It exposes only independent typed operations:

- create an eligible note if the exact destination is absent;
- atomically compare current text and replace an eligible note;
- create a preservation artifact at a generated reserved path if absent.

M4 does **not** expose arbitrary file access, a generic `write(path, body)`, local
rename, hard local delete, or move-to-archive as a substitute for conditional
deletion. Obsidian documents atomic text processing but no atomic compare-and-delete
or compare-and-move predicate. A prechecked rename could still move newly changed
iCloud/plugin bytes and therefore cannot satisfy stale-decision rejection. Operators
may rename/delete through Obsidian itself; those host events invalidate review and
require fresh evidence rather than executing under old M4 authority.

Requests carry explicit source/destination kinds, expected existence, exact transient
expected text for atomic comparison where the host supports `Vault.process`, expected
SHA-256/evidence identity, size/eligibility limits, operation ID, and collision rule.
Results distinguish confirmed, stale/refused, failed-before-effect, and unknown
effect. Host objects and filesystem types never cross the adapter.

`Vault.process` is used for a conditional replacement because the supported Obsidian
API documents it as atomic read/modify/save. Create remains create-only. Rename is not
part of the port because no documented compare-and-move predicate can reject every
stale decision. No application decision treats a precheck as a lock.

### Commit ordering

There is no cross-system atomicity. The ordering rule is:

1. persist the exact operator intent and evidence;
2. create and post-verify every required preservation artifact;
3. revalidate local, baseline, remote, lifecycle, path, and operation evidence;
4. perform at most one conditional local or remote authoritative mutation;
5. persist its effect before any dependent mutation;
6. perform the next conditional step only from the newly persisted phase;
7. update the acknowledged baseline last, after all required effects are proven.

Unknown effects stop the workflow for evidence; they do not trigger compensation or
a fresh-latest overwrite. Restart resumes from the durable phase and reconstructs
content only from an exact current local hash, an exact remote revision, or the
verified preservation artifact. The ledger stores no note-body history.

## Consequences

Competing bytes survive local-write, remote-write, persistence, restart, and stale-UI
failures. Conflict artifacts consume local vault storage and require explicit cleanup.
They are intentionally outside normal mirror scope. Keep-both with an eligible second
path is more work than merely leaving an archive, but remains an explicit choice.

The adapter must test Obsidian's documented `process` behavior and conservatively
classify create uncertainties. No rename, trash, or hard local delete is part of M4;
a live local path cannot be removed merely to accept a remote tombstone or historical
mapping.

## Alternatives

Remote recovery alone was rejected because it does not cover arbitrary live/live
remote generations or local competitors. Export-only preservation was rejected as an
unverifiable side channel. A generic Vault port and hard delete were rejected because
they broaden authority and cannot supply the required conditional semantics.
Automatic merge was rejected; an operator may edit locally, then re-review and choose
“keep local.”

## Evidence / related documents

[M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[M4 implementation plan](../plans/m4-remote-to-local-reconciliation-and-conflict-resolution.md),
[ADR 0005](0005-reviewed-reconciliation-authority.md), and
[Obsidian plugin qualification](../plugin-development.md).
