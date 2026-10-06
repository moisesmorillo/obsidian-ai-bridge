# ADR 0020 — Private SyncStore delivery and mandatory activation gate

## Status

**Accepted by the owner; documentation transition becomes canonical on merge.**
This supersedes only the M7 exit/qualification coupling, not the storage authority
contracts in ADRs 0017–0019 or the proposed product direction in ADR 0016.

## Context

The isolated implementation merged in #97 and local qualification continued through
#106. The consolidated report distinguishes reviewed implementation, local profiles,
unpublished small tests and missing operational evidence. Requiring all operational
qualification to call the private store delivered conflated two different boundaries.

## Decision

Close M7 as delivery of the **private, isolated and unactivated store**. Keep every
undemonstrated safety or operational requirement as a mandatory
[preactivation gate](../qualification/m7-delivery-and-activation-gate.md), not a pass,
optional follow-up or permission to use real data. The completion transition is this
single documentation PR; it does not create a following NEXT milestone.

Keep the implemented 10,000-head ceiling and the measured local 5,000/10,000 profiles
with their limits. No 1,000-note support limit, deployed capacity claim or changed
TTL, CAS predicate, codec, retry floor, retention or security policy is introduced.

Before real-data use or public protocol exposure, all applicable gate rows must have
source-bound evidence and explicit reviewed owner acceptance. Newly discovered defects
still block use. A later API/client/migration change requires a bounded specification,
not inference from M7 COMPLETE. Remote synthetic qualification also requires separate
resource/cost/credential authorization; this ADR grants none.

## Consequences

M7 COMPLETE means implementation delivery, not Workers Free qualification, real R2
conformance, backup, whole-vault/mobile support or synchronization readiness. The
incomplete real-day expiry remains pending. Current v2 routes and writer stay unchanged.
The price of this boundary is a visible activation blocker register and a separate
reviewed activation decision; forgetting a gate must never become permission.

## Alternatives

- Keep delivery blocked on every operational experiment: rejected by the owner.
- Lower scope to 1,000 notes or mark local results operationally approved: rejected.
- Defer safety to optional follow-up or automatically define M8: rejected.

## Evidence / related documents

- [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md)
- [Consolidated criterion report and blockers](../qualification/m7-delivery-and-activation-gate.md)
- [Qualification execution plan](../plans/m7-sync-store-qualification.md)
- [Rollout plan](../plans/bidirectional-vault-sync-rollout.md)
