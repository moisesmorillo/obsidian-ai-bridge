# M4 corrective qualification — listener gaps and effect authority

**Result:** bounded disposable-host qualification passed for the scenarios below. This
is corrective safety evidence, not full M5 qualification, platform support, or a
production-readiness claim.

## Scope and environment

- Obsidian **1.13.7** with an isolated user profile and disposable synthetic vault.
- The generated `ai-bridge` plugin artifact built from the ADR 0013 corrective change.
- A loopback-only Worker/API fixture and synthetic note/state data; no personal vault,
  production credential, deployed Worker, or production storage was used.
- The run was limited to v4→v5 startup migration, a reviewed complete-group ownership
  transfer, and fail-closed behavior after a detached edit.

## Scenarios and observations

1. **Startup migration and activation:** Loaded seeded historical device state. The
   plugin completed the same-key v4→v5 migration/read-back path, started the disposable
   configured writer, attached Vault listeners after layout readiness, and established
   normal operation only after startup event handling completed.
2. **Reviewed gap transfer:** Presented fresh evidence for the complete reserved group
   and completed an explicit reviewed transfer. The persisted predecessor remained
   gap-fenced and linked to a fresh successor in the atomic state transition; the
   permitted successor action created the synthetic local note. No absence-derived
   delete authority was used.
3. **Edit while detached:** Detached the plugin, changed the synthetic note, and
   reattached. The predecessor and successor remained gap-fenced. A subsequent review
   treated the changed path as unreviewable and retained reservations instead of
   settling or releasing authority. The run did not attempt an automatic overwrite.

The host-side result supports the narrow claim that this tested transfer path remains
fail-closed across a later listener gap. Source-level deterministic tests cover the
broader state matrix, dispatch-gate refusal, overflow/drain failures, and atomic
validation; this host run does not replace those tests.

## Limits

This did not test a 5,000- or 10,000-note vault, iCloud event ordering/hydration,
mobile or background iOS execution, Worker/R2 deployment, full M5 failure and recovery
procedures, every local/remote dispatch interleaving, host-local crash durability, or
all possible queue-overflow timings. It does not establish general Obsidian rendering,
Fetch/CORS/abort, supported-platform, or production guarantees. M5 remains NEXT, and
its full qualification sequence is still required.

## Related evidence

- [ADR 0013 — listener-ready effect authority and observation-gap recovery](../decisions/0013-listener-ready-effect-authority-and-observation-gap-recovery.md)
- [M4 specification](../milestones/m4-remote-to-local-reconciliation-and-conflict-resolution.md)
- [Plugin development and qualification boundaries](../plugin-development.md)
