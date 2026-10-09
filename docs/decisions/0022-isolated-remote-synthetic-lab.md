# ADR 0022 — Isolated remote synthetic sync lab

## Status

Accepted for **local implementation** by the owner's current request. Canonical on functional delivery merge. Every Cloudflare operation remains separately unauthorized until the exact recipe is approved.

## Decision

Extend ADR 0021 only with a temporary synthetic remote exception: separate Worker, private new R2 bucket, three fresh principals, exact HTTPS endpoint and new experimental plugin state. Preserve the local demo and all SyncStore, recovery and conflict invariants. G1–G6 remain OPEN for production and real data.

Use 100 create-only R2 transport-ticket claims per participant (300 admissions), a 512 binding-call and 1 MiB submitted PUT-byte ceiling per invocation, and maximum one-hour lifetime. A ticket is consumed before store dispatch; lost replies consume it without permission to retry the ticket. Store-operation replay uses the original tuple and a fresh transport ticket. This requires no Durable Objects, KV or new dependencies. Claims are not store receipts and never establish commit certainty.

A second account is **optional**. Prefer a separately scoped session/token and explicit new-resource allowlist. Verify the actual API permission granularity only after authorization; if adequate isolation cannot be achieved in the selected account, stop rather than inspect or borrow production credentials. Shared account quotas/billing remain shared even when object bindings are isolated.

The 300 slots cap admitted effects, not arbitrary HTTP traffic. Duplicate authenticated claims cost one PUT; unauthorized requests use no R2. The remote approval recipe separately budgets denied claims, HTTP/OPTIONS, binding attempts, teardown and Free account quota contention. Monitoring is not a hard billing cap; no claim of malicious-client availability or sustainable operation is made.

## Consequences

Two functional deliveries carry documentation/tests with Worker and plugin behavior. No preparatory/test-only PR sequence, rollout, public unauthenticated storage, personal-vault installation, migration or production cutover. The plugin is manual and newly armed; it cannot adopt the old namespace/credentials/state by default.

Stop blocks new requests and does not claim cancellation/rollback of dispatched effects. Preserve uncertain ledgers and versions before teardown. Remove only the explicitly approved Worker/bucket/secrets and revoke the dedicated administration credential. No generic application DELETE capability is introduced.

## Alternatives

- Durable Objects global counter: unnecessary for fixed single-use admission slots; adds infrastructure without eliminating unauthenticated edge quota costs.
- Isolate counters: unsafe across restarts/concurrent isolates.
- KV counter: no strong single-use CAS.
- Deploy local demo unchanged: rejected by its loopback-only contract.

## References

- [Contract and budgets](../milestones/m8-remote-synthetic-lab.md)
- [Implementation units](../plans/m8-remote-synthetic-lab.md)
- [Activation gates](../qualification/m7-delivery-and-activation-gate.md)
