# M9 automatic host-instance qualification

Date: 2026-10-10. Scope: the generated remote experimental plugin loaded in
two isolated simulated Obsidian host instances, with filesystem-backed
disposable vaults and a local Miniflare Worker/R2. This is **not** an Obsidian
Desktop run or a Cloudflare deployment. No personal vault was opened.

The source-bound scenario is
[`apps/obsidian-plugin/tests/artifact/demo.test.ts`](../../apps/obsidian-plugin/tests/artifact/demo.test.ts),
using the host double in
[`demo-host.ts`](../../apps/obsidian-plugin/tests/artifact/demo-host.ts).
It never invokes `Sync now`.

## Observed result

The focused scenario passed in 74.57 seconds:

```text
node node_modules/vitest/vitest.mjs run --config apps/obsidian-plugin/vitest.smoke.config.ts -t 'automatically reconciles'
```

- A→B, B→A and REST→B reconciled automatically. Each destination's saved
  bytes, revision and SHA-256 recognized base matched the source head.
- A targeted reload retained B's recognized base and its separate automatic
  opt-in. The persisted feed cursor remained canonical and each lane sequence
  was monotonic; equality was not required because a live poll can advance it.
- Disabling A's opt-in stopped A-authenticated traffic during an observed
  interval longer than the accelerated timer. B remained active.
- For a deterministic conflict, B was unloaded, REST made a competing edit,
  and B was edited locally before reload. After reload, B entered attention,
  kept its local bytes, saved one excluded copy of the remote version, and
  did not advance its recognized base or pre-conflict cursor.
- The scenario asserted at most 32 requests in the first A phase, 32 in the
  first B phase, 128 in the REST phase, and 300 total. The full gate recorded
  182 requests: A 90, B 64, and REST 28 across the whole scenario. These
  participant totals include later polls and retries; they are not per-pass
  counts. The harness cannot isolate the 32-request cap of each individual
  internal scheduler pass.

`mise run check` passed: 2,303 fast tests, 53 storage tests, and 17 plugin
smoke tests; one existing smoke case was skipped. Statement coverage was 95%
(13,388/14,092). Independent review found no actionable issue in this
artifact scenario. The focused run above passed before a nonbehavioral
sanitized request-count log was added; the full gate then passed with that log.

The first unaccelerated diagnostic had A pending at 120 seconds: one
`current:200:error:storage_unavailable` and five
`mutate:200:error:operation_pending` responses. The original operation
remained durable without a false acknowledgment or cursor advance. The Worker
journal was slow but progressing. A test-only accelerated VM clock then
shortened plugin timers of at least four seconds to 1.5 seconds of real time
and advanced only the plugin VM's `Date.now()` by the skipped interval. This
also accelerates the VM transport deadline. The local Miniflare Worker and R2
keep real wall time. This run proves the eventual automatic behavior in the
isolated harness; it does not measure real Desktop latency or qualify the real
HTTP deadline and R2 same-key write floor.

This host-instance run alone did not close the Desktop criterion. A later,
separately authorized [real disposable Desktop demonstration](m9-disposable-desktop.md)
passed automatic REST→A/B, A→B, B→A, targeted Force Reload with direct local
checkpoint persistence evidence, and conflict preservation. M9 is COMPLETE
for that bounded synthetic scope; G1–G6 remain open for production and real
data. This historical report still measures only the isolated harness.
