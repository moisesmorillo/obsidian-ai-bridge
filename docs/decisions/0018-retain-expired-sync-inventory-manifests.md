# ADR 0018: Retain expired sync-inventory manifests as no-reuse tombstones

## Status

Accepted by the owner for no-reuse retention; superseded **only** for v2 manifest size and expired scratch allowlist by [ADR 0019](0019-resumable-r2-inventory-cursor-witnesses.md). Not a sync-activation, deployment, or Workers Free qualification decision. Canonical when merged.

## Context

The historical v1 inventory has a caller-supplied stable scan ID, an 8,192-byte-maximum manifest, immutable page chunks, and a shared active slot. R2 DELETE has no ETag condition. A reaper can read an expired manifest, pause, and then delete a newly created manifest with the same ID after another reaper removed the old one. Re-reading immediately before DELETE cannot close that race. A focused synthetic test reproduced deletion of the new manifest.

## Decision

- After proving exact manifest expiry and that this scan does not own the active slot, the original v1 cleanup may delete **only canonical chunks** under that scan's isolated `sync/v1/vaults/<vault-id>/inventories/scans/<inventory-id>/chunks/` prefix, one bounded deletion and absence read-back per invocation. It never deletes the manifest or any note, version, recovery, feed, or other scan object.
- Keep the expired manifest permanently as the no-reuse tombstone. `startInventory` with the same ID returns `inventory_expired`; callers must use a new ID for a new scan. There is no implicit expiry repair or ID recycling.
- When the chunk prefix is empty, cleanup reports `retained` rather than claiming all scratch objects were removed. If slot release, expiry, listing, deletion, or read-back is uncertain, do not claim cleanup.

## Consequences

The historical v1 retained body costs at most **8,192 × N bytes** for N v1 admitted scans; ADR 0019 extends this to **9,216 × N2 bytes** for N2 new v2 scans, plus R2 keys and metadata, with no global quota or manifest reaper in M7. A quota failure is a typed non-success, not authority to delete tombstones or reuse IDs. This is a storage-safety trade-off, **not** evidence that the account can indefinitely retain manifests or that Workers Free CPU is qualified. Operational storage budgets and any later safe retirement protocol need a separate design and owner decision before activation.

## Alternatives

- Delete the expired manifest after checking its ETag: rejected; R2 DELETE is unconditional and a later generation can appear between check and deletion.
- Introduce per-scan retired markers or a new cleanup fence: deferred; it adds authority, cross-object races, extra reads/writes and cleanup lifecycle beyond this bounded correction.
- Leave all expired chunks indefinitely: safe but unnecessarily retains large evidence objects while the permanent manifest already prevents ID reuse.

## Evidence / related documents

- Regression: `apps/worker/tests/unit/infrastructure/sync-r2-inventory-cleanup.test.ts` reproduces the same-ID replacement race and verifies no-reuse after cleanup.
- Implementation: `apps/worker/src/infrastructure/sync/sync-r2-inventory-cleanup.ts` and `sync-r2-inventory-runner.ts`.
- [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md); [ADR index](README.md).
