# M7 local 1,000-head inventory profile

**Observed local workerd/R2 evidence, not operational qualification.** The owner
authorized one 1,000-head run and extended its process deadline from 30 to 90 minutes.
No 5,000/10,000-head, remote account/bucket/vault, deployment or activation work ran.
M7 remains **NEXT**.

## Reproduction and identity

```bash
mise install
mise run install
M7_PROFILE_HEADS=1000 M7_PROFILE_OUTPUT="$PWD/.pi/inventory-profiles/host-measured-1000-extended" mise run worker:inventory-profile
```

The shell execution had a 5,400-second process timeout; application scan expiry,
write cooldowns and invocation ceilings were unchanged. Source was the dirty
host-measurement overlay on merged base `306aa354e23d3fcd5fa32d5b30c4f8f1e82d866a`
(PR #99), not a published commit. Exact recipe:
`acc16d6eef7007de440de4f746ee5b090f8b1611c771de87903aeaa19f74ddc2`.
Versions: Node 24.21.0, Bun 1.4.2, Miniflare 5.20260908.0-alpha,
workerd 1.20260908.1. Fixtures used canonical synthetic heads, 720-byte paths and
1,184-byte encoded heads; bodies/version history were not being qualified.

Retained artifacts remain outside tracked source. `initial-report.json` and
`initial-host-resources.json` preserve first-completion measurements; reopening a
completed checkpoint must not be reported as a second scan or included in its elapsed
time. The auxiliary host file is not checkpoint/pair authority.

## Successful scan observations

| Observation | Result |
| --- | --- |
| Completed unique evidence traversal | 1,000 / 1,000 summaries; complete handle |
| Root | `28f9aba8bae4df8c6867dfe4394169dfa1933b5ff7750ca0a0e0ed016d8d615c` |
| Chunk count | 1,000 |
| Host elapsed / scan elapsed | 2,370,496 / 2,367,944 ms (about 39 min 30 s) |
| Dispatch intents / observed replies | 10,105 / 10,105 |
| Accounting / unresolved intents | Complete / 0 |
| Physical attempted GET / LIST / PUT | 69,826 / 1,000 / 6,004 |
| Total attempted binding calls | 76,830 |
| Maximum calls per request | 135 of the unchanged 400 ceiling |
| Largest encoded head | 1,184 bytes, not the 2,048-byte schema ceiling |
| Settled persistence pair | Sealed after successful runtime disposal |
| CPU / isolate memory | Unavailable; unqualified |

### Actual request classes

| Driver action | Replies | GET | LIST | PUT | Observed body bytes read | Attempted PUT-body bytes |
| --- | --- | --- | --- | --- | --- | --- |
| Seed | 32 | 1,032 | 0 | 1,001 | 2,666 | 1,184,086 |
| Start | 5,005 | 15,281 | 0 | 3 | 24,864,154 | 4,070 |
| Continue | 5,005 | 52,261 | 1,000 | 5,000 | 92,999,646 | 13,934,864 |
| Evidence page | 63 | 1,252 | 0 | 0 | 3,682,645 | 0 |

These totals include actual serial progress/polling, setup and complete evidence
traversal. They are not worst-branch reservation proofs or remote billable-unit
classification. Body counts exclude LIST/control-envelope bytes and do not establish
retained R2 storage. The long-path fixture produced one persisted head/chunk per LIST;
serial cooldowns explain sustained progress, not a hung process. No parallel scan
requests or relaxed defenses were introduced.

## Host-resource observations at first completion

The recorder uses monotonic synchronous phase wall time and Node before/after
memory snapshots. OS peak RSS covers the entire Node process lifetime, not one phase;
Bun/workerd child processes, isolate memory and CPU are excluded.

| Phase | Host wall time | RSS before / after | Node lifetime peak RSS after |
| --- | --- | --- | --- |
| Fresh-directory admission | 0.064 ms | 176,029,696 / 176,193,536 bytes | 176,193,536 bytes |
| Final journal summarization | 42.643 ms | 257,163,264 / 268,828,672 bytes | 268,828,672 bytes |
| Post-disposal pair seal | 263.345 ms | 262,815,744 / 272,678,912 bytes | 272,678,912 bytes (about 260 MiB) |

Fresh-directory admission does **not** measure hashing an existing pair. Snapshot
heap use after summarization was 69,779,400 bytes; after sealing, 56,556,016 bytes.
These are samples, not allocation maxima; garbage collection was not forced to
manufacture lower values. Auxiliary total elapsed through teardown/seal was
2,370,827.361 ms.

After disposal, the native persistence directory contained 4,011 files totaling
17,487,537 bytes; largest file 7,860,224 bytes. Trace size was 5,396,937 bytes. These
are local emulator filesystem observations (including native metadata), **not**
a remote R2 retained-storage/account budget. Full-file seal/journal operations remain
unbounded with respect to future larger histories; this run does not prove their
10,000-head or repeated-run resource feasibility.

## Reopening the completed persistence pair

The same command/output directory was then reopened once, without another scan or
binding dispatch. Recipe, root/handle, 10,105 intents/replies, physical counters and
1,000 verified summaries remained unchanged. The new invocation successfully
verified and resealed the retained pair; first-completion elapsed values above were
preserved separately rather than replaced by time since the original run began.

| Reopening phase | Host wall time | RSS before / after | Node lifetime peak RSS after |
| --- | --- | --- | --- |
| Existing-pair verification | 107.964 ms | 177,733,632 / 213,155,840 bytes | 213,155,840 bytes |
| Recovery journal classification | 38.274 ms | 214,269,952 / 250,363,904 bytes | 250,363,904 bytes |
| Report journal summarization | 31.185 ms | 260,849,664 / 272,826,368 bytes | 272,826,368 bytes |
| Settled reseal | 86.107 ms | 272,859,136 / 291,356,672 bytes | 291,356,672 bytes (about 278 MiB) |

Total host invocation time through teardown/reseal was 433.774 ms. Heap use after
reseal was 106,651,648 bytes; again this is a snapshot, not a phase/whole-machine
maximum. This measures actual verification of the 1,000-head persistence tree,
unlike initial empty-directory admission. Different process lifetime/GC/cache state
means the two samples must not be treated as a controlled memory benchmark or a
linear prediction for 5,000/10,000 heads.

## Interrupted first attempt and remaining gates

The initial 30-minute-budget task was deliberately stopped when the longer budget
was approved, because supported background tooling cannot change an existing deadline.
It had 732 persisted heads, 7,366 observed intents/replies and 50,413 GET / 733 LIST /
4,668 PUT (55,814 observed attempted calls). It is unsealed and **not complete or
certified recoverable**. No authority was repaired to adopt it. The successful fresh
run above accounts for its own calls only; both attempts together observed 132,644
binding calls, not a remote billing estimate.

Canonical validation before execution and final post-evidence `mise run check`
passed locally, including 2,081 source tests, 23 native tests and 12 artifact smoke
tests. The final local publication gate (`baf0a14ef`) also passed `git diff --check`.
Author semantic review of the complete PR diff was completed; it was **not independent**.

GitHub CI was separately verified for PR #100 head
`878d0451f5ed422cdbb2e22cbaf8882d72964247`: [Quality checks](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/37351695063)
and [Conventional PR title](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/37351695130)
both succeeded. The quality-run log confirms the same test counts and production
coverage: 95% statements, 91.46% branches, 98.65% functions and 96.81% lines.
These checks do **not** establish that CI executed the opt-in 1,000-head profile;
its measurements above come from the retained local run. CI evidence here is bound
to that explicit head, not automatically to later documentation commits.

The subsequent documentation correction head `6261c364ed401607042ed5669066a881906aea19`
also passed [Quality checks, attempt 3](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/37369632114/attempts/3)
and [Conventional PR title](https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/37369632121).
Its quality log confirms the same test counts and coverage. The first two quality
attempts were cancelled without executing steps because a hosted runner could not
be assigned; they are not test evidence. PR #100 merged as
`2d961c324cca015d22089e883a506b60b199d7c2`, whose tree was verified identical to
`6261c36`. This does not qualify later test additions or the opt-in profile in CI.

Current scope includes only local host measurements and this population.
Maximal, fault/short-page, cleanup, expiry/recovery matrices, trustworthy isolate CPU
and memory, retry-inclusive account/billing/storage admission and remote Workers Free
qualification remain pending under the [qualification plan](../plans/m7-sync-store-qualification.md).
