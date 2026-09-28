# Automatic multiwriter rollout proposal

This plan implements [proposed ADR 0016](../decisions/0016-automatic-multiwriter-mirror.md)
without defining M7 or marking a milestone `NEXT`. It does not enable a
production writer or authorize a personal-vault installation. The existing
single-writer contract remains active until the final cutover.

## Independently reviewable changes

1. **Read-only association status and provisioning.** Add an owner-authorized,
   create-only association record and authenticated status that distinguishes
   connected/read-only from writer-ready. Preserve all current mutation denial.
   Test concurrent first provisioning, malformed state, nonempty namespace, and
   read-only grants. Rollback removes additive routes; the immutable control
   record is retained, and note authority is unchanged.
2. **Server mutation admission.** Accept distinct cooperating device IDs only
   under the new association contract. Keep OAuth permission policy, conditional
   writes, recovery receipts, and MCP checks. Test same-generation races, stale
   deletion, revoked grants, and old clients. Rollback to the prior Worker must
   deny new-protocol writes.
3. **Versioned local state and join policy.** Migrate v5 state without dropping
   ACKs, operations, or reviews; fail closed on downgrade. Test the pure decision
   matrix for exact bytes, different bytes, tombstone, local-only, remote-only,
   legacy/invalid state, and ambiguous observations. Join never mutates content.
4. **Plugin admission and publishing.** Compose joining into the runtime, retain
   whole-mirror consent, request the full `read`, `write`, `delete` grant through
   browser authorization, and admit writes only after durable per-path evidence.
   Replace manual writer ID UI with connected, joining, blocked, and active
   status. Test two disposable instances, restart, iCloud delay/absence, and an
   MCP remote change. Rollback disables the mirror and retains evidence.
5. **Synthetic live qualification and cutover.** Verify create/update/delete,
   recovery, conflict preservation, revocation, unknown outcomes, and rollback
   denial on an isolated association. Only then deploy the new contract and
   consider the personal vault, one installation at a time.

Every code PR must be independently fail-closed and include behavior tests,
documentation, `mise run check`, and semantic review. Estimate its production
file/line scope before implementation and split a change crossing the repository
limit by real behavior rather than compressing code or tests.

## Evidence required before a personal vault

- Two installations establish an exact-content baseline without copying UUIDs
  or tokens between them.
- The first device can bootstrap a proven empty association after explicit
  consent; a later device cannot publish initial local-only notes automatically.
- Stale local bytes cannot replace newer remote content after restart, iCloud
  delay, or an MCP write.
- Initial/local absence cannot delete remote content; saved runtime deletion
  tombstones only an acknowledged exact generation.
- A remote tombstone cannot be silently recreated by an out-of-date device.
- Failed conditions, lost responses, storage failure, and revoked grants do not
  produce optimistic success or lose review/receipt evidence.
- Old-client and rollback paths deny ambiguous mutations. Qualification uses
  synthetic notes only; R2 remains a mirror, not a complete backup.
