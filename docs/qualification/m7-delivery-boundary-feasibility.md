# Feasibility review: M7 private delivery versus activation

**Verdict: ready for this documentation-only delivery boundary; not ready for
activation or a remote experiment.** Author self-review, not independent review.
Target: ADR 0020, reconciled M7 spec/roadmap/state/rollout and G1–G6 against
`origin/main` at `ddefc4f`. No runtime, codec, cap, retry or permission changes.
This review precedes opening the PR; it does not replace candidate code/security
review required by G1/G6.

## Authority and resource budget

The owner accepts private delivery, not a support-tier claim. No new operation is
introduced: this PR makes **zero Worker requests, R2 calls, writes, data copies or
vault effects**. Its feasibility does not depend on an assumed Cloudflare tier.
For later use, retain the accepted Workers Free target without treating it as a
verified current limit. Existing sources below were **not retrieved in this review**,
honoring the no-Cloudflare-access instruction; applicable limits/prices/headroom/
telemetry remain unknown and block G4/G5 rather than being guessed.

| Operation/resource | Aggregate accepted bound / observation | Consequence before use |
| --- | --- | --- |
| Inventory data reads | `2 × 20,001 LIST + 2 × 10,000 head GET = 60,002`; control, claim, witness, retry/read-back and cleanup are additional | This is not a whole-account call/billing bound; G1/G4/G5 require actual traces |
| Per invocation | Inventory ≤400 physical calls; mutation ≤64; analytical inventory reservations: step 32, start 136, final 134, evidence 18, cleanup 8 | No provider compatibility inferred. 400 vs historical 1,000 internal-call limit suggests nominal 600 headroom only; actual applicable limit and caller calls must be verified |
| Evidence bodies | `10,000 × 1,536 + 20,001 × 256 + 20,001 × 8,192 = 184,328,448` bytes; `192 MiB = 201,326,592`, margin 16,998,144 | Journals/witnesses, keys and metadata are extra; body arithmetic is not heap evidence |
| Scratch/cleanup | Up to 60,001 canonical v2 scratch objects; journal/witness bodies ≤17,920,000 bytes. At 8 credits/cleanup, `60,001 × 8 = 480,008` reserved calls before retries/setup/audits | Not measured worst sparse cleanup; G1/G5 open. Only expired canonical scratch, never manifest/head/feed/version/recovery |
| Evidence traversal | `ceil(20,001 / 16) = 1,251` successful page calls; retries additional | Count/root must finish; intermediate/empty continuation is not absence |
| Permanent growth | At most `8,192 × N1 + 9,216 × N2` manifest body bytes plus metadata; immutable versions/feed/receipts also grow with workload | No finite lifetime account claim without admission/retention policy; G5 open |
| Time/per-key writes | 1,100-ms successful-write/response/uncertainty floors; unchanged 24-hour expiry. Measured local 10k took 6 h 13 min 48.760 s | Cannot extrapolate sparse/retry worst case or real expiry; fail expired/incomplete, never extend TTL to pass G2/G4 |
| CPU/memory/content | Accepted Free CPU target 10 ms/request; legal content ≤1 MiB, head ≤2,048 bytes, v2 manifest ≤9,216 bytes | Host RSS/wall time and injected CPU allowance prove neither isolate CPU nor heap. G4 open for all relevant operation profiles |

Primary sources still requiring dated verification before a separately approved run:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[observability](https://developers.cloudflare.com/workers/observability/).
The [experiment packet](../plans/m7-workers-free-approval-packet.md) remains **not
ready/executable**; its provisional cost calculation does not establish current rates.

## Counterexamples and closure

| Counterexample / prior concern | Disposition and fence |
| --- | --- |
| Treat COMPLETE or local 10k as permission for a real vault | Fixed in this documentation boundary: G1–G6 stay open; separate reviewed owner acceptance required; no composition/route changes |
| Replace original exits with a fabricated 1k envelope | Rejected by owner; 10k implemented ceiling and 5k/10k local observations retained, no supported-population inference |
| Pi died after ~14 h but wall calendar later exceeds 24 h | Still open G2: no approved expiry report; no success inferred and no run restarted |
| Lost claim/write response, peer slot CAS or changed final vector falsely completes | Unit/native subsets are not every crash/race. Still open G1/G3; exact predicates, claims, read-back and no-false-completion invariants unchanged |
| Cleanup deletes retained identity then stale same-ID admits a new scan | Permanent manifest no-reuse rule retained; real-time/real-binding verification still open G2/G3 |
| Worst empty pages or repeated failures exceed daily requests/storage/CPU | Still open G4/G5; large execution deferred, not approved. Require evidence or explicit supported-workload reconciliation with fail-closed admission |
| Later v2 writer creates an invisible revision after import | Still open G6; immutable binding/v2 denial before migrated exposure, explicit import verification/rollback required |
| Server delivery implies automatic local deletes or accepts a client observation gap | Still open G6; exact-base/absence/alias/gap/preservation, host and backup/restore requirements precede client/cutover use |

No new blocking finding for **private delivery**: isolation means no unresolved
platform budget or security gap is exercised by this PR. Operational unknowns are
blocking, not waived, and cannot receive a ready verdict. The next small native
fixture closes only named G1 rows; no complete next milestone or remote authority
is created. Review all changed current-state links together; historical NEXT/old
exit text is explicitly superseded, not rewritten into fabricated passed tests.
