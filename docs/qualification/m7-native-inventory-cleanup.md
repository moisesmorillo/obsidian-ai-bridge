# M7 native inventory cleanup: bounded local contract evidence

This is a focused workerd/R2 integration test, not a population, throughput or
remote qualification profile. M7 remains **NEXT**. Production source, codecs,
reservation policy and cleanup implementation are unchanged.

## Execution and authority

`mise run worker:storage-test` and `mise run check` include
`apps/worker/tests/runtime/inventory-cleanup.test.ts`. Each case owns a disposable
local Miniflare runtime. Setup creates a strict expired/live v2 manifest, a slot
owned by a different inventory, canonical chunk/claim/witness scratch and two
non-target sentinels. All objects are synthetic; no real vault or account is used.
The scratch payloads are intentionally opaque: cleanup authority comes from the
strict manifest and canonical key, not decoding disposable body contents.

Each cleanup request calls the existing `reapExpiredSyncInventoryScratch` once.
A wrapper counts physical GET/LIST/PUT/DELETE attempts before native dispatch,
independently of the production invocation budget. Setup and inspection are separate
requests with their own counters, never included in cleanup totals. Native
conditional Headers are constructed inside the isolate.

| Case | Expected physical calls per cleanup request | Required storage observation |
| --- | --- | --- |
| Expired v2 scratch, peer owns slot | 3 GET + 1 LIST + 1 DELETE = 5 | Exactly one distinct scratch key removed; manifest/peer slot/non-target bytes unchanged |
| No target scratch left | 2 GET + 1 LIST = 3 | `retained`; permanent manifest and peer slot unchanged |
| Before expiry | 1 GET | `deferred`; no LIST/DELETE; all scratch remains |
| DELETE effect, injected lost acknowledgement | 2 GET + 1 LIST + 1 DELETE = 4 | `effect_unknown`, not `reaped`; later inspection proves deletion without retroactively granting certainty |

These observed counts must agree with the independently counted production budget
and remain within its eight-call reservation. The lost-acknowledgement scenario
injects an exception after a real local native DELETE; it is not native R2 outage
or host-transport-loss evidence.

## Explicit limitations

The injected future epoch establishes expiry policy relative to synthetic timestamps,
not real-time expiry/cooldown feasibility. The fixed 20-ms budget allowance is a
synthetic preflight input, not CPU measurement. No production call is parallelized.

This subset does not close the complete cleanup/fault matrix: owned-slot CAS release,
competing writes, bad-key LIST results, read-back failure, v1 historical behavior,
real-time expiry/recovery and larger-scale cleanup remain separate gates. It does not
qualify isolate memory/CPU, retry-inclusive billing/storage or Workers Free limits.
The [qualification plan](../plans/m7-sync-store-qualification.md) remains authoritative.
