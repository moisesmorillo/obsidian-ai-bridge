# M7 SyncStore qualification: remaining gates

**Qualification plan; local 0/1-head baselines and one 1,000-head profile have run.** The
[test-only harness](../qualification/m7-inventory-profile-harness.md) and
[1,000-head evidence](../qualification/m7-inventory-profile-1000.md) do not close the
maximal, fault/cleanup or remote qualification gates. PR #97 merged the private
implementation at `62696b030a817eb2c4f91af8a6986a688fcd318b`, including terminal
inventory failure correction `ed88daf`. M7 remains **NEXT**. Qualification must
close the gaps in [local evidence](../qualification/m7-private-sync-store-local.md),
not activate the store or change the current writer.

## Execution order and authorization

| Stage | Deliverable | Authorization boundary |
| --- | --- | --- |
| 1. Local harness | [Native baseline harness](../qualification/m7-inventory-profile-harness.md) provides bounded fixtures, one operation/request, checkpoints and a canonical `mise` task | Implemented locally; no real account, R2 or vault, and maximal/fault/cleanup qualification is not implied |
| 2. Local evidence | Run the reviewed harness against a pinned local workerd build; retain measurements and failure traces | Explicit local execution approval; never call arithmetic or host-process CPU a remote profile |
| 3. Remote qualification | Approved isolated Workers Free/R2 experiment and account-admission report | Separate owner approval of resources, workload, maximum cost/calls, retention and cleanup; no production bucket or personal vault |
| 4. M7 exit | Acceptance/evidence reconciliation, canonical checks, semantic review and a completion PR | Only after all specification criteria pass; no automatic activation or following NEXT milestone |

The [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md)
remains authoritative for ceilings and failure policy. This plan does not relax
its 10,000-head, 400-subrequest, write-spacing, expiry or Workers Free CPU gates.
Do not add a public sync endpoint or mount the private store to profile it. A future
isolated test entry may compose the store inside the Worker, as the existing native
fixture does; its endpoint must not enter the production bootstrap.

## Local profile matrix

Build valid synthetic heads through the actual persisted codecs, not mock summaries.
Report the largest legal encoded head/path sizes achieved separately from schema
byte ceilings; do not pad records with forbidden fields. Use deterministic IDs and
seeds. Retain both actual local R2 listing behavior and explicitly fault-injected
short/empty-page behavior: synthetic cursor injection is not native R2 evidence.

| Profile | Required observation |
| --- | --- |
| Baseline and scale: 0, 1, 1,000, 5,000, 10,000 heads | Complete verified root/count, full evidence traversal, elapsed time and memory; largest legal heads at the maximum scale |
| Worst short/empty pages and cursor history | Accepted logical page/attempt ceilings, cursor witness/journal storage, bounded per-invocation reads, no skipped or repeated verified work |
| Fresh-isolate continuation/recovery | Same inventory ID, durable reservations and floors survive fresh facades; native conditional Headers constructed inside the isolate |
| Durable chunk or failure latch before deferred manifest CAS | Read-back recovery without another LIST/head GET; malformed LIST/head and limit exhaustion persist failed; only owned slot released |
| Lost responses, throttling and competing CAS | Unknown remains unknown, original authority retained, no retry before safe floor, no peer overwrite or false complete handle |
| Stable-vector finalization and evidence paging | Changed/pending lane prevents completion; each evidence response obeys chunk/head limits; full traversal proves counts/root |
| Expiry and scratch cleanup | Canonical expired scratch only, bounded deletion/read-back, permanent no-reuse manifest retained, unrelated namespaces untouched |

The [native cleanup contract subset](../qualification/m7-native-inventory-cleanup.md)
covers canonical v2 scratch, peer-slot/manifest/sentinel preservation, injected expiry
and an injected lost DELETE acknowledgement with actual local binding calls. It does
not close owned-slot/competing-CAS/read-back-failure or real-time expiry/cleanup gates.

Count **physical binding calls**, including control GETs, LISTs, conditional PUTs,
read-backs, cleanup and refused recovery attempts, not only reserved logical credits.
For every start/step/finalization/evidence/cleanup/recovery branch compare actual calls
with its reservation and the invocation ceiling. Treat any underestimated reservation
as a blocker even when the total happens to fit under 400. Classify each native call
for later billing, and report successful work separately from retries and setup.

Use real time for the native throughput/expiry profile and honor same-key cooldowns
across requests. A virtual-clock contract run can establish transition/count bounds,
but not elapsed feasibility inside the 24-hour scan window. Stop rather than extending
expiry or suppressing defensive checks. Local CPU reporting must identify its measurement
scope; if isolate CPU is unavailable, record that limitation instead of substituting
Node/host wall time. Local workerd never satisfies the remote CPU gate.

The baseline `mise run worker:inventory-profile` task now exists; its
[harness guide](../qualification/m7-inventory-profile-harness.md) defines fixture
setup, resumable driving, call accounting, measurement scope, stop conditions and
retained outputs. It is not an implementation of every profile in this matrix. Keep costly
maximal runs separate from routine `mise run check`; retain fast regression assertions
in the canonical gate. If implementing the harness crosses repository size limits,
propose independent PR boundaries before production changes.

## Remote preflight: approval required

Before provision/deployment or any real binding call, record and approve:

- Exact isolated account/plan, Worker and empty disposable bucket; independently
  verify identities, no shared production bindings, no personal data and no plugin.
- Dated primary-source checks for [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
  [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) and
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/), with actual account
  usage/headroom. A configured binding or Free label is not operational evidence.
- Per-invocation CPU observation method with operation/profile correlation and
  disclosed sampling/precision. Aggregated averages or p95 alone cannot prove that
  every measured profile passes; missing trustworthy CPU evidence blocks exit.
- Fixed fixture sizes, repetitions and failure matrix; total request/Class A/Class B
  budgets, storage-time ceiling, monetary ceiling and a stop mechanism checked
  before another dispatch. Include retries, preflight/receipt reads, setup and cleanup.
- Disposable teardown and retained-evidence policy. No production data deletion;
  canonical scratch cleanup must retain manifest tombstones. Deleting an explicitly
  approved whole disposable bucket after evidence capture is test-resource teardown,
  not a change to the application's no-reuse rule.

The accepted specification targets **10 ms CPU per request** on Workers Free.
Reverify that target before executing; a changed platform limit or account plan
requires an explicit specification decision, not a silent substitution. Collect
CPU for start, continuation, finalization, evidence paging, cleanup and recovery,
including maximum valid bodies, cursor-history and failure-latch paths. Every measured
profile must satisfy the accepted limit. Retain sample counts, maximum and distribution,
provider errors and cancellations; do not discard slow/failed samples. Exceeding the
limit requires a bounded corrective implementation and recalculated limits/re-review,
not a Paid-tier shortcut or threshold reduction.

## Account and storage admission

CPU success alone is insufficient. State the supported workload assumptions before
claiming sustainability: vault count, scans/day (including failed restarts), mutations,
readers/evidence traversals, retries, retained versions/events and retention horizon.
Calculate whole-account request and R2 operation/storage-time demand with measured
per-scan costs, pre-existing usage and reserve headroom. Include cursor journals and
witnesses, partial failed scans, cleanup calls and permanently retained expired manifest
tombstones. Scratch expiry does not reclaim those tombstones or immutable history.
Unbounded ID creation/history cannot be called indefinitely Free-tier-safe.

If no bounded workload/admission policy supports the claim, keep the gate blocked and
seek an owner decision. This plan does not invent a limiter, deletion policy, retention
period, support claim or new infrastructure to manufacture a passing result.

## Evidence and closure checklist

Retain a content-free report plus machine-readable traces outside tracked source;
commit only sanitized reproducibility summaries. Never include tokens, account IDs,
raw authorization, private paths or vault content. Synthetic identifiers may be retained
only where needed to verify identity-bound transitions.

- [ ] Source SHA/tree, tool/runtime versions, fixture recipe/seed, legal encoded sizes
  and exact implemented `mise` task/arguments are bound to each run.
- [ ] Native versus injected behavior, local versus remote scope, real versus virtual
  clock, CPU/memory measurement scope and sampling are clearly distinguished.
- [ ] Logical/physical calls, attempts, elapsed/expiry, byte/key counts, CPU maxima,
  memory and full evidence traversal are measured against specification ceilings.
- [ ] Fault/race/cooldown cases preserve uncertainty, no-relisting and own-slot safety;
  current v2 objects/routes/writer remain unaffected.
- [ ] Workload/account admission and retry-inclusive billing/storage estimates pass
  with approved stop limits; resource teardown and evidence retention are recorded.
- [ ] All specification acceptance items map to evidence or remain explicitly blocked;
  canonical `mise install`, `mise run check` and semantic review pass on the candidate.
- [ ] Only the reviewed completion transition marks M7 COMPLETE. Later API/client
  enrollment, migration, vault cutover and activation require a separate specification
  and authorization; no following milestone is started by this plan.

**Next actionable change:** review the baseline harness/evidence, then explicitly
scope the maximal local profile and missing failure/cleanup measurements before
executing those long runs. Remote execution remains separately gated.
