# Local native inventory profiling harness

**Implemented tooling, not M7 operational qualification.** The private test entry
runs one seed batch or one `SyncStore` method per actual workerd request. It uses
real time and the native local R2 binding; conditional Headers stay inside the
isolate. Production source, routes, writer and plugin are unchanged. The owner
accepted one PR beyond the 400-line review budget for this cohesive harness.

## Run and resume

Install pinned tooling/dependencies with `mise install` and `mise run install`.
Use a fresh ignored output directory for each independent profile:

```bash
M7_PROFILE_HEADS=0 M7_PROFILE_OUTPUT="$PWD/.pi/inventory-profiles/zero" mise run worker:inventory-profile
M7_PROFILE_HEADS=1 M7_PROFILE_OUTPUT="$PWD/.pi/inventory-profiles/one" mise run worker:inventory-profile
```

`M7_PROFILE_HEADS` defaults to zero and admits canonical integers through 10,000.
Larger values are parameter support, **not measured scale evidence**. Do not start
long maximal runs or remote experiments merely because a task now exists; follow
[separate execution gates](../plans/m7-sync-store-qualification.md). There is no
remote mode or production binding configuration in this harness.

Repeat the same command/output directory to resume its checkpoint. The local R2
state, checkpoint and recipe must remain together. The recipe binds the compiled
Worker, host driver/state/policy/contracts and runtime/compiler versions. Different
counts or recipes are refused; use a fresh directory rather than rewriting old
artifacts. A completed checkpoint is an existing run, not a new scan. One exclusive
`run.lock` prevents concurrent drivers. A content seal (`pair.json`) binds the
checkpoint, trace, compiled fixture and exact emulator bytes after runtime disposal.
Missing/replaced state or an unpaired directory is refused before retained artifacts
are changed. A hard process kill leaves no valid seal: retain that run as interrupted
and use a fresh directory; removing a stale lock does not restore restart authority.
The seal detects accidental artifact mismatch, not malicious coordinated rewriting.

The host waits outside the Worker for safe response floors; request-local metrics
exclude that wait. Progress alternates start/continue so an interrupted `starting`
manifest is resumed without assuming it became `scanning`. Observed failures stop
without advancing work and retain the maximum known/observation cooldown floor.
Atomic rename prevents partial checkpoints. Gracefully settled interruptions can
resume their sealed pair; a forced kill or failed disposal is deliberately fail-closed.
A finite request cap and 24-hour overall
run deadline stop work without changing the application's expiry or defenses.

## Evidence outputs

| Artifact | Meaning |
| --- | --- |
| `checkpoint.json` + `r2-state/` + `pair.json` | Content-bound resumable state and persistent disposable emulator after native disposal; not a vault installation |
| `trace.jsonl` | Pre-dispatch intents and linked observed replies: actual method, timestamps, status, physical attempted GET/LIST/PUT calls, body bytes and explicitly host-only RSS |
| `report.json` | Traversal completion/count/root handle, unique summaries, elapsed times, observed calls/maxima, unresolved attempts/accounting completeness, largest seeded head, recipe/source identity and versions |
| `worker.mjs` | Exact native fixture bundled for the run |

`completed` certifies traversal only. `accountingComplete` additionally requires a
reply for every retained dispatch intent; `calls` and `maxCallsPerRequest` explicitly
cover observed replies only. Missing replies never mean zero calls. Each unresolved
intent has an unobserved-call upper bound of 400 (including a possible never-sent
intent), not inferred exact counts or bytes. The operator profile task requires both
completion and complete accounting. Graceful interruption before reply parsing
preserves an unknown interval; interruption after trace but before checkpoint retains
its measured calls even when the same operation is replayed. Resumption conservatively
waits a fresh cooldown when any unresolved interval remains.

Seeding is idempotent create-only/byte verification, at most 32 heads per request,
and is separately labeled in traces. Heads use actual strict codecs with 720-byte
paths and portable-sized segments. These are synthetic metadata fixtures: bodies,
immutable historical versions and mutation/publication are **not** being qualified.
Report the achieved encoded head size, not the schema ceiling. PUT body byte metrics
count attempted bodies, not proven retained storage; list metadata/control-envelope
bytes and complete account storage are not inferred from them.

CPU and isolate memory are **unavailable** and stay explicitly unqualified. Wall
time and host RSS are not substitutions. The fixture's 20-ms preflight allowance is
an injected synthetic admission estimate, not a measurement or change to the accepted
Workers Free CPU gate. The driver independently refuses a 401st binding dispatch;
the store retains its original physical-credit preflight. This baseline does not
claim exhaustive worst-branch reservation verification.

## Observed local baseline

The corrective 0/1-head task after canonical validation completed successfully
with these local results. Both runs retained a verified persistence pair, 22 dispatch
intents and 22 observed replies, complete accounting and zero unresolved attempts:

| Heads | Verified summaries | Observed replies | Maximum calls/request | GET / LIST / PUT | Largest encoded head | Host elapsed |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 22 | 135 | 614 / 1 / 9 | 0 bytes | 5,119 ms |
| 1 | 1 | 22 | 135 | 616 / 1 / 10 | 1,184 bytes | 5,126 ms |

Both reports identify recipe
`ddc1ab4d4c6d398efbcb0403d6c6f53febd330878b882924db367b28b475cda2`,
Node 24.21.0, Bun 1.4.2, Miniflare 5.20260908.0-alpha and workerd 1.20260908.1.
They were generated from the dirty harness overlay on base
`c7f59c95399759e9b17582c9608ab3dc8c0ad015`, not a published commit. The recipe
identifies the actual compiled fixture and driver. Counts include separately labeled
seeding and real-clock polling; they are not worst-case upper bounds. CPU/isolate
memory, full storage footprint and remote account qualification remain unavailable.
Later harness edits require a fresh recipe/run rather than adopting these artifacts.

## Validation and remaining work

Independent corrective code review approved the local harness; design review found
it ready with a bounded follow-up. Before authorizing a large-scale run, measure host
seal/journal processing and bound or stream it if needed: verification/sealing hash
all retained bytes, while trace classification reads the full journal. Peak host
memory can include the largest native persistence file and full trace. The 0/1-head
results do not establish maximal host resource feasibility. This follow-up is deferred
because large-scale execution is outside this PR's authorized baseline scope.

Fast policy/state tests and native 0/1-head traversal/restart tests run in canonical
`mise run check`. The focused profile task is separate and never launches 10,000
heads as part of normal CI. The full maximal native run, injected short/empty-page
and fault matrix, cleanup profiling, reliable CPU/isolate-memory measurement,
retry-inclusive billing/account admission and remote Workers Free qualification
remain pending. M7 stays **NEXT**; no activation, deployment or real R2/vault access
is implied. Retain reports outside tracked source; commit only sanitized summaries.
