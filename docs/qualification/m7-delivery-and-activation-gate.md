# M7 delivery report and mandatory preactivation gate

**M7 delivers the private isolated store, not permission to use real data.**
[ADR 0020](../decisions/0020-private-sync-store-delivery-and-activation-gate.md)
closes implementation delivery when this documentation transition merges. Every
pending requirement below remains an activation blocker. No following milestone is
NEXT and no 1,000-note limit is adopted. The [boundary feasibility review](m7-delivery-boundary-feasibility.md)
is ready for documentation delivery only, not for activation.

## Delivered evidence and limits

The latest `main` inspected was `ddefc4fdee08914f7c02814336cdc1b35d0dfc46`.
#97 (`62696b0`, corrected source `ed88daf`) delivered the private nine-method
`SyncStore`, durable mutation/feed recovery, v2 inventory witnesses/evidence and
canonical scratch cleanup. Its canonical checks and independent semantic review
passed; [implementation evidence](m7-private-sync-store-local.md) records exact scope.
#99–#103 added local profiling and native subsets; #106 (`6b10c5e`) adopted
proportional execution, not operational qualification.

| Local evidence | Retained result | Limitation |
| --- | --- | --- |
| Maximum 5,000 heads, `bd1c2313b`, source `1fd41cb` | 5,000 verified summaries/chunks; 306,955 binding calls; max 135/request | Local, not isolate CPU/memory or account admission |
| Maximum 10,000 heads, `b8dda57f7`, source `1fd41cb` | 6 h 13 min 48.760 s; 10,000 summaries/chunks; 613,359 calls; max 135/request | No worst sparse-page or real R2 claim |
| Copied 5,000 cleanup, `b895a92ee`, source `5bc02a3` | 14,998 scratch deletions; 85,621 calls including audits; max 5/cleanup; manifest/slot/heads/original retained | Injected expiry, not 24-hour expiry |
| Small continuation on `ddefc4f` | 3 native bad-key cleanup cases, 10 focused contract cases and 1 adapter rename case passed; typecheck passed | Tests-only local overlays, patches/logs retained locally, not merged regressions or independent approval |
| Bounded finalization/release candidate from `def2985b` | [0/1-head native regression fixture](m7-native-inventory-finalization.md) covers changed/pending final vectors, interrupted completion/release and original-generation peer-slot CAS | Candidate validation/review recorded in its report; fresh facades, injected clock, local R2 only; not full G1 or independent activation acceptance |

The small cleanup cases preserve manifest/slot/scratch/sentinels and issue no target
GET/DELETE for foreign, peer or noncanonical keys. The rename case uses the real
adapter with a deterministic bucket/injected clock: destination ACK, fresh facade,
exact replay, competing source edit and stale tombstone refusal preserve both copies.
Its first expectation wrongly asked `readCurrent` for bytes; corrected assertions use
`readVersion`. This was a test error, not a corrected production defect.

Historical profile originals were under `.worktrees/`, absent in the inspected
checkout. Merged summaries, Git source and task stdout survive; no original seal/root
was reaudited or reconstructed. Unpublished LIST/chunk cohorts `cf3769c`/`e0cc4da`
remain historical local evidence, not newly merged tests. Historical reports may retain
the NEXT status at their execution checkpoint; ADR 0020 and this report own the
current delivery/activation distinction. No long run was repeated.

### Actual-day expiry: incomplete, not approved

Task `b2812efb2`, source `7cfefe4`, started 2026-10-06 00:36:00.461 UTC and was
killed during Pi shutdown at 14:35:41.274 UTC: **13 h 59 min 40.813 s**, not 24 hours.
The log reports SIGTERM; no approved actual-expiry report or copied R2 state is
available here. A default baseline log is not the expiry result. G2 remains open;
no restart is authorized by this report. The cancelled 20,001-page sparse run
`bd3a3c495` likewise has no complete handle/final traversal and remains unqualified.

## Criterion reconciliation

Numbers retain the original [M7 acceptance criteria](../milestones/m7-versioned-sync-protocol-and-r2-store.md#acceptance-criteria).
“Delivered” means reviewed private implementation, not every original test passed.

| Criterion | Delivery disposition | Undemonstrated requirement / activation owner |
| --- | --- | --- |
| 1. Schemas/identity/bounds | Delivered strict contracts/codecs; no new exhaustive audit | G1: candidate regression/hostile-input evidence; G4: actual resource limits |
| 2. CAS/conflict/replay/uncertainty | Reviewed implementation and focused tests | G1: complete native cross-instance/race matrix |
| 3. R2 preservation/isolation | Local native subsets; no real R2 | G1 and G3: exact bytes, retention and v2 noninterference |
| 4. Feed fairness/expiry | Unit/review evidence, not complete native matrix | G1: hot-lane fairness, continuation, invalid/future/expired cursors |
| 5. Inventory/replay/limits/expiry/cleanup | Local 5k/10k and small subsets retained | G1, G2, G3, G4, G5; sparse worst case deferred, not passed |
| 6. Every crash/claim/floor/429 boundary | Reviewed state machines; incomplete native matrix | G1 and G3: exact original authority, no false success, no lost recovery/current evidence |
| 7. Destination-first rename | Small adapter scenario; not client/native restart qualification | G1 and G6: destination ACK loss, interruption/replay and changed-source preservation |
| 8. v2 coexistence/migration fence | Private namespace unchanged; migration contract only | G3 and G6: candidate regression and implemented binding fence before migrated exposure |
| 9. No activation/access/deployment | Preserved; zero runtime changes in this PR | G6: reviewed exposure/client admission and explicit owner activation |
| 10. Checks/docs/final review | Historical checks/review credited; this transition reconciles docs | G1/G6: candidate canonical checks and semantic/security review before use |

## Mandatory blockers before activation or real-data use

**All rows are OPEN.** They are neither optional follow-ups nor passed by M7 closure.
Rows also apply to server-only real-data use; client/import requirements additionally
apply when that capability is exposed. Synthetic remote experiments require their own
approval and cannot bootstrap permission to use real data.

| Gate | Required evidence to close | Current gap |
| --- | --- | --- |
| G1 — Safety conformance | Source-bound native tests for feed fairness/continuation/expiry; inventory start/reservation/LIST/head/chunk/witness/manifest/final-vector/completion/slot/cleanup interruption; changed/pending vectors; partial/corrupt evidence; same/different-ID races; original-generation CAS; unique claim ownership, late writes, unavailable/divergent read-back, cooldown/floor/429; rename ACK-loss/replay/source edit; candidate canonical checks and independent semantic/security review | Unit tests, native subsets and author overlay checks do not establish the complete matrix. Missing safety rows must be enumerated and tested, never waived as scale-only |
| G2 — Real expiry/no-reuse | Completed real 24-hour refusal, bounded scratch cleanup, exact retained manifest and same-ID rejection; truthful unknown DELETE/read-back handling | Real-day run killed; injected clocks do not close it |
| G3 — Real R2/trusted storage | Separately authorized synthetic real-binding create/CAS/read-back/race/preservation/noninterference and cleanup conformance; verified private binding/namespace, vault identity and Worker-only authority for journals/refusal receipts; failure/teardown evidence | No M7 real R2 qualification; local emulation is insufficient |
| G4 — Runtime feasibility | Dated verified applicable Workers Free/R2 limits plus trustworthy per-invocation CPU maxima, memory evidence and actual binding counts for start/step/finalization/evidence/cleanup/recovery and mutation/content paths at legal maxima; exhaustion fails closed | 10-ms CPU is the accepted target, not a freshly verified platform claim; isolate CPU/memory and applicable provider limits unverified |
| G5 — Workload/account admission | Explicit bounded scans/mutations/readers/retries/retention workload; measured retry-inclusive requests, Class A/B, storage growth, current headroom, cost and enforceable pre-dispatch stop reservations | No sustainable Free-tier/account claim; immutable history and permanent manifests are unbounded without admission/retirement policy. The proposed experiment packet is not executable approval |
| G6 — Exposure/client/migration/cutover | Reviewed bounded API/grant/vault authorization; no implicit scope gain; candidate v2/API/MCP regressions; immutable migration binding/v2 fence before imported exposure; verified create-only import and rollback; exact-base client reconciliation/persistence, observation-gap/alias/absence fences and local preservation; supported-host disposable tests; independent backup/restore and explicit owner cutover approval | No public sync composition, engine, import/fence or real-device sync qualification. Existing M5/OAuth evidence does not close these future requirements |

The full adversarial target remains 10,000 heads/20,001 pages, including retries and
cursor history. Large stress execution is deferred by owner scope. Before activation,
either supply its required evidence or obtain an explicit bounded supported-workload
specification change with fail-closed admission; deferral alone cannot close G1/G4/G5.
No smaller population is inferred. Neither expiry nor data-safety requirements may be
removed through a capacity adjustment.

## Next bounded implementation work — not a new milestone

The **test-only 0/1-head native finalization/release fixture** is now supplied by the
[bounded regression candidate](m7-native-inventory-finalization.md): changed/pending
final vectors, interrupted completion/owned-slot release, physical store-call counts,
original-generation peer-slot CAS and exact peer/v2 preservation across fresh facades.
Its transition becomes canonical on merge; it does not close G1 or approve activation.
No production behavior, public endpoint, plugin, remote resource or long profile changes.

Next enumerate the remaining G1 rows and scope another bounded fixture before
implementation; no following milestone or broad implementation is preauthorized.
Before any remote experiment, qualify a lower-polling
request schedule and recompute G4/G5 against verified limits and authorized workload.
API/enrollment/client production work still needs a separately approved bounded spec.
Do not define M8, start the complete rollout or install into a vault by inertia.
