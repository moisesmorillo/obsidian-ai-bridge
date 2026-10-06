# M7 native inventory cleanup: bounded local contract evidence

This is a focused workerd/R2 integration test, not a population, throughput or
remote qualification profile. M7 remains **NEXT**. Production source, codecs,
reservation policy and cleanup implementation are unchanged.

## Execution and authority

`mise run worker:storage-test` and `mise run check` include
`apps/worker/tests/runtime/inventory-cleanup.test.ts`. Each case owns a disposable
local Miniflare runtime. Setup creates a strict expired/live v1/v2 manifest, an
owned or peer slot, version-permitted canonical scratch and two
non-target sentinels. All objects are synthetic; no real vault or account is used.
The scratch payloads are intentionally opaque: cleanup authority comes from the
strict manifest and canonical key, not decoding disposable body contents.

Each cleanup request calls the existing `reapExpiredSyncInventoryScratch` once.
A wrapper counts physical GET/LIST/PUT/DELETE attempts before native dispatch,
independently of the production invocation budget. Setup and inspection are separate
requests with their own counters, never included in cleanup totals. Native
conditional writes are constructed inside the isolate. The competing-slot fault
uses the original generation to write the peer, then dispatches the original release
with its unchanged conditional options; it never refreshes CAS evidence.

| Case | Expected physical calls per cleanup request | Required storage observation |
| --- | --- | --- |
| Expired v2 scratch, peer owns slot | 3 GET + 1 LIST + 1 DELETE = 5 | Exactly one distinct scratch key removed; manifest/peer slot/non-target bytes unchanged |
| No target scratch left | 2 GET + 1 LIST = 3 | `retained`; permanent manifest and peer slot unchanged |
| Before expiry | 1 GET | `deferred`; no LIST/DELETE; all scratch remains |
| DELETE effect, injected lost acknowledgement | 2 GET + 1 LIST + 1 DELETE = 4 | `effect_unknown`, not `reaped`; later inspection proves deletion without retroactively granting certainty |
| Expired owned slot | 4 GET + 1 PUT = 5; no LIST/DELETE | Original manifest/sentinels/scratch preserved; release precedes any scratch reaping |
| Competing original-generation slot CAS | 4 GET + 2 PUT = 6 including one separately labelled fault write | `effect_unknown`; peer ownership preserved, no LIST/DELETE, no refreshed release |
| DELETE effect, lost native absence read-back | 3 GET + 1 LIST + 1 DELETE = 5 | `effect_unknown` even though later inspection sees absence |
| Real LIST, injected oversized reply | 2 GET + 1 LIST = 3 | `effect_unknown`; zero DELETE and scratch preserved |
| Historical v1 | One chunk only, then `retained` | Exact manifest/peer preserved; no invented v2 claim/witness |
| Injected v2 claim under v1 | After the permitted chunk, no DELETE for the forbidden claim | `effect_unknown`; nonhistorical claim and exact manifest/peer preserved |

These observed counts must agree with the independently counted production budget
and remain within its eight-call reservation. In the competing-slot case,
`faultWrites=1` identifies the independently counted peer PUT outside cleanup's
budget: total physical calls equal `actualCalls + faultWrites`; no call is hidden. The lost-acknowledgement scenario
injects an exception after a real local native DELETE; it is not native R2 outage
or host-transport-loss evidence.

## Explicit limitations

The injected future epoch establishes expiry policy relative to synthetic timestamps,
not real-time expiry/cooldown feasibility. The fixed 20-ms budget allowance is a
synthetic preflight input, not CPU measurement. No production call is parallelized.

The extended nine-case matrix passed canonical `mise install && mise run check`
and diff validation in `ba506c6c4`: 2,081 source, 32 native and 12 smoke cases;
coverage/thresholds remain 95/91.46/98.65/96.81 percent. Post-green author semantic
review removed a redundant single-iteration test loop; final publication checks
`be38f860e` passed with the same totals/coverage. Final author review found no
remaining actionable finding in this bounded change. This is not independent approval.
Initial GREEN attempt `bfae7d5f0` failed because its purported historical-v1 fixture
incorrectly seeded a v2 claim. The production refusal was correct. Corrected RED
`b8a9390d5` passed seven cases and failed only the uninjected slot race and forbidden
claim faults. Connected `b19f942a6` passed eight cases but failed the exact-count
assertion for the slot race: the expected count omitted the original-generation
preflight GET. Source tracing confirmed manifest/slot/preflight/read-back GETs;
`bb1c659df` then passed all nine native cases but its canonical pipeline stopped
at the SDK header boundary typecheck: host `Headers` iterators differ from
Miniflare's Undici declarations. Headers now cross that boundary as ordinary
HTTP pairs, without casts or dependency changes; `ba506c6c4` passed. No assertion limit or authority policy was weakened.

This subset does not close the complete cleanup/fault matrix: bad-key LIST results,
real-time expiry/recovery and larger-scale cleanup remain separate gates. It does not
qualify isolate memory/CPU, retry-inclusive billing/storage or Workers Free limits.
The [qualification plan](../plans/m7-sync-store-qualification.md) remains authoritative.
