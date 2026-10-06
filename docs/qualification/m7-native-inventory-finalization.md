# Native inventory finalization and owned-slot recovery

**This is a bounded local G1 subset, not activation approval.** The test-only
fixture runs nine scenarios with both zero and one synthetic head through the
private store, strict codecs and in-isolate native local R2 predicates. Every
store invocation constructs a fresh facade. G1–G6 remain OPEN.

## Source and reproduction

Baseline: `def2985bd099170af5383d3bdf23e1c22d69cd9b`, the merged #107 private-delivery
transition. Candidate source is the commit introducing these files:

- `apps/worker/tests/runtime/fixtures/inventory-finalization.worker.ts`
- `apps/worker/tests/runtime/inventory-finalization.test.ts`

Run `mise run worker:storage-test -- tests/runtime/inventory-finalization.test.ts`.
The canonical `mise run check` discovers the fixture through the existing runtime
configuration; no profile task or new production entry point is introduced.

## Exact conformance rows

Each row runs at 0/1 head. Vector changes occur in lane 63 **after** start-vector
capture and the terminal LIST step, before finalization. Boundary writes use the
actual storage adapter's original observed predicate, not a host-proxied Headers
object. Independent audits decode persisted manifest/slot authority.

| Injected boundary | Required observation |
| --- | --- |
| Final committed vector changed | `effect_unknown`; scanning manifest and own slot unchanged; repeat cannot complete or release |
| Final lane has a pending reservation | Same refusal/preservation; no completion manifest PUT |
| Completion PUT rejected before applying | Unknown; exact scanning manifest/slot retained; fresh continuation finalizes, then releases |
| Completion applied, binding response lost, readable read-back | Progress only; persisted complete manifest; fresh continuation releases only own slot and returns complete |
| Completion applied, response and read-back unavailable | Unknown, never a complete handle; persisted completion recovered by a fresh facade |
| Own-slot release rejected before applying | Unknown; complete manifest and own active slot retained; fresh continuation releases it |
| Own-slot release applied, response lost, readable read-back | Complete only after exact empty-slot confirmation; subsequent continuation makes no PUT |
| Own-slot release applied, response/read-back unavailable | Unknown despite persisted empty slot; fresh continuation establishes completion without another PUT |
| Peer takes slot after release preflight, before original-generation CAS | Native CAS returns null; boundary and fresh continuation remain unknown; exact peer slot generation survives, with no refreshed retry PUT |

Every scenario preserves exact bytes, ETag, uploaded timestamp and custom metadata
of a peer's permanent manifest and a strict format-2 live-current sentinel under
`vault/`. The peer-race case additionally preserves the peer-owned slot generation.
Successful recovery traverses all tiny inventory evidence and asserts exact counts,
finality and the synthetic path/revision. Changed/pending vectors and peer takeover
produce no readable complete handle.

## Measurements and verification

Two counters distinguish **store binding attempts** (including injected rejection)
from **actual native forwards**. Seeding, competing fixture writes and audit GETs
are outside both store-invocation counts; neither is an account/billing total.
Literal attempt assertions are 132 GETs/0 PUTs for final-vector refusal,
134 GETs/1 PUT for completion and 6 GETs/1 PUT for release. A before-apply fault
forwards zero native PUTs; unavailable read-back forwards one fewer native GET.
Lost-response and peer-CAS cases otherwise forward all counted store calls to R2.
Already-empty recovery uses 4 native GETs/0 PUTs. Every invocation is checked against
the existing 400-call ceiling; the maximum tested attempt count is 135. These tiny
rows do not establish reservation sufficiency for other branches or isolate CPU/memory.
A scenario drives several public store calls within one local fixture HTTP request;
these are per-store-method counts, not a Free-tier per-HTTP-request qualification.

Verification on 2026-10-06:

- `mise install` and focused typecheck passed; the focused native run passed 18/18.
- Final `mise run check` passed in 56.23 seconds, including the final native-forward
  telemetry: 114 fast files/2,085 tests, 8 native files/52 tests (this fixture's 18
  included), 12 plugin artifact tests, static diagnostics and dry-run builds.
- Coverage stayed at 95% statements, 91.46% branches, 98.65% functions and 96.81%
  lines; native workerd tests are separate from the V8 fast-suite measurement.
- 155 local file/anchor links and Git whitespace checks passed.

Initial failures were fixture errors (`absent` versus sync `never_seen`, internal
`pathKey` versus public `path`, an overly broad helper return union and missing
fixture JSDoc tags), not production defects. No production, configuration,
dependency or coverage-threshold change was made. Final author semantic review is
recorded below; it is not independent activation acceptance.

### Semantic review boundary

The project code-review workflow reviews the complete candidate against `def2985b`,
including the tests, evidence and gate/roadmap links. The fixture owns fault timing,
measurement and persisted audits; literal host assertions are separate from
production state classification. Core types, protocol builders and strict Worker
codecs remain authoritative. The unchanged runner owns final-vector and owned-slot
policy; the object adapter owns original-generation CAS and exact read-back certainty.
Fresh facade recovery does not refresh a refused peer-slot predicate.

The stateful review follows scanning/complete manifest × own/empty/peer slot × stable/
changed/pending vector × before-apply/applied-readable/applied-unavailable evidence.
Only the nine listed rows are demonstrated. The fixture is cohesive as one bounded
native experiment, with no reusable production contracts or extra semantic owner.
No actionable findings remain after the final author review; independent candidate
semantic/security acceptance before activation remains a G1 requirement.

## What remains blocked

This is fresh-**facade** recovery in one disposable workerd process, not process
termination, delayed in-flight PUT or durable reload qualification. It uses an
injected future clock/CPU allowance, not real cooldown, 429, 24-hour expiry or
Workers Free feasibility. Native local R2 is not a real Cloudflare binding.

G1 still needs the remaining source-bound feed, inventory admission/LIST/head/chunk/
witness/cleanup, corrupt/partial/divergent evidence, claim/late-write/floor/429,
same/different-ID race and rename ACK-loss/restart rows, plus independent candidate
semantic/security acceptance. This report supplies regression evidence only for the
rows above when their candidate checks pass and the PR merges; it is not independent
activation acceptance. G2–G6 are unchanged; see the authoritative
[activation gate](m7-delivery-and-activation-gate.md#mandatory-blockers-before-activation-or-real-data-use).

Next: enumerate and scope the remaining G1 rows before selecting another bounded
fixture. No following milestone, remote experiment, deployment, vault access or
sync activation is authorized. Rollback removes only this test fixture, its host
assertions and their documentation/evidence links; the private store is unchanged.
