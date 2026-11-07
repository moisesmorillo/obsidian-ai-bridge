---
id: OAB-6.8.2
title: Measure native payload retention in the deployed runtime envelope
status: Deferred
assignee:
  - '@pi'
created_date: 2026-10-20 23:27
updated_date: '2026-11-07T13:33:00Z'
labels: []
dependencies: []
references:
  - OAB-6.5
documentation:
  - docs/spec.md
parent_task_id: OAB-6.8
priority: medium
type: spike
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: measure native retention in a real deployment when OAB-6.8 runtime-envelope work starts. The owner closes the remaining OAB-6.5 R1 native-retention scope as intentionally deferred. The OAB-6.5 32 MiB application limit excludes native workerd buffers, transport-retained RPC results, and fragments retained by native layers. Local actor-gate and unread-body tests do not prove a deployed heap breach or native release bound. Deployment and Cloudflare resource changes still need explicit owner authorization.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A real authorized deployment measures native payload retention during concurrent upload, RPC result, slow response, and cancellation paths.
- [ ] #2 Measurements separate active application data, native buffers, transport-retained RPC results, native response fragments, and total process observations.
- [ ] #3 The report states the deployed runtime, compatibility settings, workload, measurement method, peaks, release observations, and measurement limits.
- [ ] #4 OAB-6.8 uses the measurements for its runtime envelope without treating the OAB-6.5 application-only limit as total platform headroom.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
S4 local native-retention measurement and parent publication

Goal: document local workerd RSS observations without production content operations. Keep deployed native-retention acceptance deferred.
Spec: docs/spec.md sections 6.5 and 12. The S4 owner brief controls the workload and safety limits.

Owner decisions
- Production observation stays limited to the parent-run existing Access GET pages. No enrollment, token, OAuth client, content request, upload, resource change, or deployment.
- Local load uses Wrangler `dev --local`, temporary config without the unsupported compatibility flag, the unchanged synthetic HTTP fixture, isolated persistence, and loopback only.
- Use real application HTTP routes, Vault DO RPCs, and local R2. Stay within route limits and the 32 MiB application allowance.
- Keep scripts and samples outside Git. Make no production source, dependency, fixture, or configuration change.
- Keep all acceptance criteria unchecked and the task Deferred.
- Worker updates task notes and commits. Parent handles review, rebase, push, publication, and worktree removal.

Checklist
- [x] Inspect local bootstrap and parent production observations.
- [x] Record the actual upload, RPC, slow-read, and cancellation attempts. Record cap violations without more workloads.
- [x] Record workerd RSS samples, phase timestamps, sample misses, workload-window peak, idle peak, and limits.
- [x] Record runtime settings and separate payload byte counts from RSS.
- [x] Run `bun run check`; all suites and builds passed.
- [x] Commit the worker task-note correction.
- [ ] Parent performs the independent task and branch review.
- [ ] Parent rebases, pushes, opens the PR, removes the worktree, reports the URL, and stops.

Review focus: local-only storage, synthetic identity, cap compliance, process identity, sample coverage, route limits, cancellation outcomes, reproduction limits, and unchecked acceptance claims.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Read-only observation scope, 2026-11-04. Owner approved shared plan pn-f7baf3 and directs existing-deployment observations only. No upload, new OAuth client or grant, deployment, resource change, or vault action belongs to this task. Main source is f559c0ea36e82ab89325146e3863306c9eeb07cd after merged PR 49. CI deployment run 41930912033 completed successfully and printed Worker version dcf9d493-942f-4974-95e6-c35dcf2dd5ef at 23:06:06Z. This is deployment-log attribution, not a runtime version header from each request. The checked production configuration uses compatibility date 2025-07-12 and flag unhandled_rejection_after_microtask_checkpoint. The deployed engine build and total process identity are unavailable in these response observations.

Access and telemetry feasibility: the existing Orca browser session returned HTTP 200 for GET /owner/clients. GET /v1/vault without a bearer token returned HTTP 401. No token or cookie value was read or printed. No client or grant was created. The session did not need an owner-manual login. Only owner registry HTML was available without a new authorization flow. Source inspection found no native-heap or attribution endpoint in the current Worker routes. This does not prove that every Cloudflare telemetry method is unavailable. No existing native-process telemetry was supplied or queried. The owner console GET stores browser-bound CSRF metadata as part of its existing handler. The probe used read HTTP methods only and did not submit a form or change client, grant, or content records.

Method: browser fetch to the existing HTTPS /owner/clients route, with the existing Access session, cache no-store, redirects rejected, and a 30-second request bound. Three batches each at concurrency 1, 2, and 4, for each mode: drain, slow, and cancel. Each mode used 21 requests. Total: 63 requests, all HTTP 200, zero request failures. UTC interval: 2026-11-04T23:08:06.429391Z through 23:08:15.783572Z. Measurements used browser performance.now, not server clocks. The slow mode waited 100 ms before every read, including its EOF read. Cancellation ran after headers without consuming the body. Response bodies stayed transient in the browser and were not printed or saved. Raw numeric observations and the probe script remain in owner scratch, not this repository.

Elapsed time includes network transfer and browser scheduling. Values below are per-request observations pooled across three batches. Samples in one batch are not independent. P95 uses nearest rank and equals the observed maximum for these small groups. These numbers are descriptive samples, not a latency objective or a stable population estimate.

| Mode | Concurrency | Requests | Bytes consumed/request | Chunks/request | Median elapsed ms | P95/max elapsed ms |
| --- | --- | --- | --- | --- | --- | --- |
| drain | 1 | 3 | 4727 | 1 | 302.60 | 716.20 |
| drain | 2 | 6 | 4727 | 1 | 172.25 | 191.40 |
| drain | 4 | 12 | 4727 | 1 | 171.20 | 467.80 |
| slow | 1 | 3 | 4727 | 1 | 360.50 | 401.30 |
| slow | 2 | 6 | 4727 | 1 | 345.40 | 667.90 |
| slow | 4 | 12 | 4727 | 1 | 367.30 | 679.30 |
| cancel | 1 | 3 | 0 | 0 | 155.90 | 159.80 |
| cancel | 2 | 6 | 0 | 0 | 173.80 | 447.20 |
| cancel | 4 | 12 | 0 | 0 | 145.15 | 450.70 |

Median header time in ms, by concurrency 1/2/4: drain 302.20/171.80/171.05, slow 157.70/141.90/165.30, cancel 155.90/173.70/145.15. Client cancel-promise settlement ranged from 0.00 through 0.10 ms in all cancellation groups. Client consumption of 0 bytes does not mean zero network or server bytes. The four-request drained response-byte sum is 18,908 bytes. This is response volume, not simultaneously retained memory. Every consumed response arrived as one reader chunk. The small buffered HTML does not prove server backpressure, incomplete server production, native cancellation propagation, or last-owner release.

Attribution and acceptance limits: active application-retained data, native buffers, transport-retained RPC results, native response fragments, and total process memory all remain unmeasured. No native peak or native release time is available. Registry RPCs serve the observed owner page, but client timings cannot isolate RPC result retention from HTML, transport, TLS, browser, or GC effects. Protected content reads, maximum-size payloads, concurrent upload, and distributed-isolate fan-in were not exercised. Upload is outside the read-only authorization. A bearer-backed content workload and native attribution need a separately authorized capability, not a guessed token source or a deployment change here.

Keep all four acceptance cases unchecked. AC1 lacks upload, content-path, and direct native-retention measurement. AC2 lacks all five requested memory categories. AC3 has source/configuration and workload observations but lacks deployed engine, native peaks, and native release evidence. AC4 gains these explicit evidence limits, not native measurements for its envelope. OAB-6.8 must continue to treat 32 MiB as the approved application-only limit, never total native or process headroom. Return OAB-6.8.2 to Deferred after review. Trigger: existing authorized native telemetry plus an approved workload that can observe the missing categories and paths. Do not add instrumentation or change resources under this task scope. No product change is needed for these observations. PR 3 carries only the task notes and status.

Task review: APPROVE WITH NOTES against f559c0e and the observation diff. The reviewer checked raw numeric observations, the probe method, arithmetic, statistical limits, security boundaries, and all four unchecked criteria. Minor status finding closure: return the task from In Progress to Deferred now, as the approved plan directs. Native attribution remains unavailable. The script reads bytes transiently to count them but never prints or saves response content. Parent bun run check completed with exit 0: 1,728 tests across 98 files, lint over 242 files with no fixes, documentation checks, all four workspace type checks, and all three dry-run builds passed. Existing fault tests printed injected exceptions without failed suites. The temporary browser tab no longer exists. No product, configuration, dependency, or test changes form part of this branch.

Whole-branch review: APPROVE at a7b4b7e369f8c6558653cf633f8ad78c22036ab9 against f559c0e. The reviewer checked the complete task diff, raw numeric observations, probe script, relevant source/configuration, original deferral contract, and parent check log. Numeric summaries match. Prior status finding is fixed: Deferred, all four criteria unchecked. The earlier review statement about never reading bodies is rejected because the script reads chunks transiently without printing or saving content. Native-retention evidence stays intentionally deferred. No structural candidate applies to this notes-only branch. git diff --check passed. The reviewer confirmed 1,728 passing tests across 98 files in the parent log, but did not rerun checks or measurements. The Worker build uses dry-run. Other builds use their package-defined commands. Human branch review follows. This notes-only diff does not match automatic deployment path filters.

Owner approved human branch review pn-1fa7c8 with no changes. The observation pass is complete, but native-retention acceptance remains Deferred. Keep all four criteria unchecked. Publish notes-only PR 3. This task update neither changes the product nor triggers Worker deployment through the current automatic path filters. Stop after publication for owner merge. OAB-26 needs its separate identity-transition plan before implementation.

Overnight decision, 2026-11-06 (local UTC-6): not started.

This needs live measurements and authorized native telemetry.

The overnight scope allows tests and fakes only.

Keep Deferred.

S4 local measurement and production observation, 2026-11-07 UTC. Status: intentionally Deferred. All four acceptance criteria remain unchecked.

## Runtime and composition

Production read-only observation was run by the parent under the owner-approved Orca Access session. This worker did not access production, Cloudflare remote resources, personal vaults, or external services. The local load run used only `127.0.0.1` and separate Wrangler persistence under `/tmp`.

Local composition used the real application Worker routes, the unchanged `apps/worker/test/fixtures/http-worker.ts` synthetic identity and real Vault Durable Object RPC adapter, local SQLite, and local R2 emulation. The fixture supplied fixed synthetic client/grant identities with `vault:read`, `vault:write`, and `vault:delete`. No credential or OAuth flow was used. The alternate local config set `main` to `test/fixtures/http-worker.ts`, configured only local `VAULTS` and local R2 bindings, used compatibility date `2025-07-12`, and omitted all compatibility flags. The normal production config still names `unhandled_rejection_after_microtask_checkpoint`; no tracked production config or source changed.

Pinned local versions: Wrangler `4.45.0`; workerd `1.20251011.0`; Bun `1.4.4`; Node `v26.13.0`. A first bootstrap attempt with the globally installed Wrangler `4.156.2` / workerd `1.20261102.1` failed during DO initialization with `Unexpected vault table: __miniflare_do_name`. The package-pinned Wrangler `4.45.0` composition started and served the application successfully. This runtime difference limits comparison to the project-pinned local runtime, not a current deployed engine.

## Local workload and measurement method

Each workload used actual HTTP upload or read routes backed by DO RPC and local R2 where applicable. Workload groups ran at concurrency 1, 2, and 4, with three successful repetitions per mode and concurrency. Modes were: binary upload (`PUT /v1/files/*.bin`, 1,500,000 bytes, status 201); inline RPC result (`GET /v1/files/*.md`, 900,000 ASCII content bytes in the response, status 200); slow blob consumption (`GET /v1/files/*.bin`, 1,500,000 bytes, 15 ms delay between body reads, status 200); and cancellation (`GET /v1/files/*.bin`, read one chunk, then cancel the client reader, status 200). Inline content was below the 1,000,000-byte text route limit. Binary payloads were below the 25,000,000-byte route limit. Peak concurrent application payload accounting was at most 4 × 1,500,000 = 6,000,000 bytes, below 32 MiB. This accounting is not RSS and does not include protocol or native copies. The response content and binary bodies were not logged.

The upload, RPC-result, and slow-consumption groups ran in one local workerd process. A separate fixed-cadence sampler used `ps -p <identified-workerd-pid> -o rss=,etime=` every 250 ms. It positively identified the workerd serving the local port, PID `77286`. The raw samples contain 295 readings from `2026-11-07T13:13:25.816Z` through `13:14:44.254Z`. Observed gaps were 254–275 ms, median 267 ms. Baseline before seed/workload: 42,912 KiB. Observed peak: 50,608 KiB. The last observed post-workload sample was 50,608 KiB; RSS stayed about 50,544–50,608 KiB during the extended idle observation. No native release time can be inferred from a process RSS plateau.

Cancellation reads did not release enough local read admission for repeated runs in the same local state. An initial concurrency-2 batch after prior cancellation requests returned HTTP 429 for one request. To measure the requested concurrency levels without hidden carryover, each of the three reported cancellation repetitions at concurrency 1, 2, and 4 used a new local Wrangler process and isolated `/tmp` persistence directory. All 21 reported requests returned HTTP 200. The separate cancellation sweep recorded 144 RSS samples across nine local workerd processes; measured range was 2,448–44,560 KiB, with a 250 ms target cadence. One process startup had a 2.49 s sample gap. These restart-separated RSS readings are not comparable as a single-process baseline/release series.

Per-request elapsed summaries (median / maximum milliseconds; nearest rank is not used):

| Mode | Concurrency | Requests | Bytes per request | Status | Median / max ms |
| --- | ---: | ---: | ---: | --- | ---: |
| Upload | 1 | 3 | 1,500,000 | 201 | 32.120 / 35.829 |
| Upload | 2 | 6 | 1,500,000 | 201 | 36.667 / 45.862 |
| Upload | 4 | 12 | 1,500,000 | 201 | 43.614 / 53.829 |
| Inline RPC result | 1 | 3 | 900,000 content bytes | 200 | 39.229 / 47.707 |
| Inline RPC result | 2 | 6 | 900,000 content bytes | 200 | 28.074 / 49.686 |
| Inline RPC result | 4 | 12 | 900,000 content bytes | 200 | 56.207 / 82.059 |
| Slow blob read | 1 | 3 | 1,500,000 | 200 | 713.620 / 815.986 |
| Slow blob read | 2 | 6 | 1,500,000 | 200 | 786.435 / 891.290 |
| Slow blob read | 4 | 12 | 1,500,000 | 200 | 846.308 / 935.532 |
| Cancel after first chunk | 1 | 3 | 28,672; 36,864; 53,248 | 200 | 8.148 / 8.411 |
| Cancel after first chunk | 2 | 6 | 65,536; 57,344; 65,536; 65,536; 65,536; 40,960 | 200 | 11.252 / 13.195 |
| Cancel after first chunk | 4 | 12 | 65,536; 36,864; 49,152; 53,248; 65,536; 12,288; 24,576; 32,768; 65,536; 16,384; 24,576; 32,768 | 200 | 15.765 / 16.695 |

The successful upload/RPC/slow/cancel workloads ran in 3 repetitions at each requested concurrency. A preliminary same-process cancellation attempt also ran at concurrency 2 and returned one 429; it is reported as a setup finding, not included in the three isolated-state cancellation repetitions. The actual request response bytes or consumed bytes are payload accounting only, not simultaneous memory. Cancellation client byte counts show only the first chunk consumed, not network transfer, server cancellation propagation, or release of native owners.

## Production read-only observations supplied by parent

At about 13:08 UTC, `/owner/measurements` JSON reported partial fresh daily coverage from UTC day `1794009600000` to `1794096000000`, observed interval `1794009607451`–`1794056688925`, 965 REST requests, 0 MCP requests, and 4 daily telemetry clients. Feed response preparation p95 was 152 ms with 476/476 retained samples. DO SQLite allocated bytes were 3,170,304 and referenced R2 blob bytes were 14,783,444. Those values describe storage counters, not memory. Two page reads observed separate responding isolate IDs with 0 active reads, 4 available slots, 4-slot limit, 60,000 ms deadline, and 0 expired reads. `/owner/clients` showed 3 current clients, each with one active registry grant and no cleanup pending. The four daily telemetry clients and three current registry clients are different sets.

The production configuration source declares compatibility date `2025-07-12` and flag `unhandled_rejection_after_microtask_checkpoint`. These source settings do not identify the deployed engine build. Production pages expose no native buffers, transport-retained RPC results, native response fragments, heap, RSS, native release timing, or total process memory. Feed timings exclude lazy body production, network transfer, plugin apply, and publication delay. Isolate counters reset on restart and do not cover all isolates. No production load experiment occurred.

## Accounting, acceptance, and limits

Payload bytes and RSS were recorded as separate measures. Local RSS is total observed workerd process RSS. It cannot attribute application-owned data, native buffers, transport-retained RPC results, response fragments, allocator retention, or GC. The production storage counters also do not measure runtime memory. The local RSS numbers are not the deployed runtime envelope and are not a native release bound. The 32 MiB figure remains an application-only allowance and does not establish total platform headroom.

Keep all acceptance criteria unchecked. AC1 requires deployed native-retention evidence, which neither read-only production telemetry nor local synthetic requests provide. AC2 asks to separate five memory categories that these interfaces and process samples do not expose. AC3 lacks a deployed engine version, native memory peaks, and native release evidence. AC4 cannot use these local observations to set a deployed total-memory envelope. Remaining trigger: owner-authorized deployed workload plus native telemetry that measures the missing categories and release observations.

## Reproduction artifacts and commands

No measurement tooling or tests remain in the tracked tree. Raw artifacts and temporary scripts are under `/tmp`: `/tmp/oab-s4-workload.mjs`, `/tmp/oab-s4-cancel.mjs`, `/tmp/oab-s4-cancel-once.mjs`, `/tmp/oab-s4-cancel-sweep.sh`, `/tmp/oab-s4-results.csv`, `/tmp/oab-s4-phases.csv`, `/tmp/oab-s4-rss.csv`, `/tmp/oab-s4-cancel-restarts.csv`, `/tmp/oab-s4-cancel-restarts-rss.csv`, `/tmp/oab-s4-cancel-restarts-phases.csv`, and `/tmp/oab-s4-wrangler*.log`.

To repeat with fresh local state, create `apps/worker/wrangler.s4-local.jsonc` with name `oab-s4-local-only`, compatibility date `2025-07-12`, main `test/fixtures/http-worker.ts`, DO binding `VAULTS` to `Vault`, local R2 binding `R2_BUCKET` named `oab-s4-local-only`, and migration tag `v1` with new SQLite class `Vault`. Do not copy compatibility flags. From `apps/worker`, run `./node_modules/.bin/wrangler dev --local --config wrangler.s4-local.jsonc --persist-to /tmp/oab-s4-local-state --ip 127.0.0.1 --port 18787 --inspector-port 19387 --show-interactive-dev-session false`. Identify only the `workerd` whose command line has `socket-addr=entry=127.0.0.1:18787`, sample its RSS using `ps` every 250 ms, and run `node /tmp/oab-s4-workload.mjs`. Cancellation repetitions need fresh local processes and separate persistence paths as shown in `/tmp/oab-s4-cancel-sweep.sh`. Stop local processes and remove the alternate config after use. Never add the alternate config to Git.

S4 review corrections, 2026-11-07 UTC. This addendum supersedes the earlier cancellation totals, byte summary, RSS peak statement, and reproduction claims. No new workload or server ran during this correction.

## Evidence-based closure for review findings

### R1 — hard repetition-cap violation

The S4 brief set a maximum of three repetitions for each workload and concurrency. The cancellation runs exceeded that cap. This is a hard-cap violation. Do not treat it as a setup allowance or excuse it. No more workloads ran during correction.

The upload, inline RPC-result, and slow-consumption modes each ran three batches at concurrency 1, 2, and 4. Each mode had 21 requests: 3 at concurrency 1, 6 at concurrency 2, and 12 at concurrency 4. All recorded requests returned 201 for upload or 200 for reads.

Cancellation attempts across all executions:

| Concurrency | Batches attempted | Requests attempted | HTTP 200 | HTTP 429 | Brief cap |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 9 | 9 | 9 | 0 | 3 requests |
| 2 | 5 | 10 | 8 | 2 | 3 batches / 6 requests |
| 4 | 3 | 12 | 12 | 0 | 3 batches / 12 requests |

Concurrency 1 ran three requests in the first shared-state workload, three more in `oab-s4-cancel.mjs`, and three in the isolated-process sweep. Concurrency 2 ran one two-request batch in the first workload, one two-request batch in `oab-s4-cancel.mjs`, then three two-request isolated batches. Concurrency 4 ran only the three isolated batches. The cap was exceeded by six requests at concurrency 1 and by two batches, four requests, at concurrency 2. Concurrency 4 stayed within its cap.

Complete cancellation request inventory follows. Byte counts are bytes read before client cancellation. Times are client elapsed milliseconds. `Not recorded` means the failing request does not appear in a request CSV. Wrangler logs show its 429 response.

| Execution | Concurrency | Rep | Request | Status | Bytes | Elapsed ms | Evidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| First shared-state workload | 1 | 1 | 0 | 200 | 53,248 | 17.871 | results CSV |
| First shared-state workload | 1 | 2 | 0 | 200 | 36,864 | 14.767 | results CSV |
| First shared-state workload | 1 | 3 | 0 | 200 | 28,672 | 13.561 | results CSV |
| First shared-state workload | 2 | 1 | 0 | 429 | Not recorded | Not recorded | Wrangler log; request CSV omits failed request |
| First shared-state workload | 2 | 1 | 1 | 200 | 16,384 | 16.205 | results CSV |
| Second shared-state script | 1 | 1 | 0 | 200 | 57,344 | 8.371 | cancel-results CSV |
| Second shared-state script | 1 | 2 | 0 | 200 | 65,536 | 21.349 | cancel-results CSV |
| Second shared-state script | 1 | 3 | 0 | 200 | 28,672 | 20.596 | cancel-results CSV |
| Second shared-state script | 2 | 2 | 0 | 200 | 61,440 | 17.718 | cancel-results CSV |
| Second shared-state script | 2 | 2 | 1 | 429 | 0 | 20.175 | cancel-results CSV and Wrangler log |
| Isolated process | 1 | 1 | 0 | 200 | 45,056 | 8.411 | restart results CSV |
| Isolated process | 1 | 2 | 0 | 200 | 61,440 | 8.148 | restart results CSV |
| Isolated process | 1 | 3 | 0 | 200 | 61,440 | 8.142 | restart results CSV |
| Isolated process | 2 | 1 | 0 | 200 | 65,536 | 9.889 | restart results CSV |
| Isolated process | 2 | 1 | 1 | 200 | 57,344 | 13.195 | restart results CSV |
| Isolated process | 2 | 2 | 0 | 200 | 65,536 | 9.548 | restart results CSV |
| Isolated process | 2 | 2 | 1 | 200 | 65,536 | 12.658 | restart results CSV |
| Isolated process | 2 | 3 | 0 | 200 | 65,536 | 9.860 | restart results CSV |
| Isolated process | 2 | 3 | 1 | 200 | 40,960 | 12.614 | restart results CSV |
| Isolated process | 4 | 1 | 0 | 200 | 65,536 | 10.294 | restart results CSV |
| Isolated process | 4 | 1 | 1 | 200 | 36,864 | 16.620 | restart results CSV |
| Isolated process | 4 | 1 | 2 | 200 | 49,152 | 16.645 | restart results CSV |
| Isolated process | 4 | 1 | 3 | 200 | 53,248 | 16.695 | restart results CSV |
| Isolated process | 4 | 2 | 0 | 200 | 65,536 | 9.813 | restart results CSV |
| Isolated process | 4 | 2 | 1 | 200 | 12,288 | 15.466 | restart results CSV |
| Isolated process | 4 | 2 | 2 | 200 | 24,576 | 15.472 | restart results CSV |
| Isolated process | 4 | 2 | 3 | 200 | 32,768 | 15.523 | restart results CSV |
| Isolated process | 4 | 3 | 0 | 200 | 65,536 | 10.091 | restart results CSV |
| Isolated process | 4 | 3 | 1 | 200 | 16,384 | 16.008 | restart results CSV |
| Isolated process | 4 | 3 | 2 | 200 | 24,576 | 16.009 | restart results CSV |
| Isolated process | 4 | 3 | 3 | 200 | 32,768 | 16.068 | restart results CSV |

The first shared-state concurrency-2 failure is absent from `/tmp/oab-s4-results.csv`; the log records one 429. The second failure appears in `/tmp/oab-s4-cancel-results.csv`. The inventory counts both failures. No failed request body was consumed.

### R2 — corrected cancellation byte and timing summaries

The earlier summary mixed shared-state byte counts with isolated-run elapsed times. Ignore its cancellation rows. This table uses only the isolated-process sweep rows for those summaries.

| Concurrency | Isolated requests | Statuses | Bytes by request order | Median / max elapsed ms |
| ---: | ---: | --- | --- | ---: |
| 1 | 3 | 200 × 3 | 45,056; 61,440; 61,440 | 8.148 / 8.411 |
| 2 | 6 | 200 × 6 | 65,536; 57,344; 65,536; 65,536; 65,536; 40,960 | 11.252 / 13.195 |
| 4 | 12 | 200 × 12 | 65,536; 36,864; 49,152; 53,248; 65,536; 12,288; 24,576; 32,768; 65,536; 16,384; 24,576; 32,768 | 15.765 / 16.695 |

The shared-state cancellation attempts remain separate in the inventory above. Their byte counts do not describe the isolated-process runs.

### R3 — phase-linked RSS peaks and missed samples

The 295-sample primary RSS file covers `13:13:25.816Z`–`13:14:44.254Z`, with 254–275 ms gaps and a 267 ms median. Baseline was 42,912 KiB before seed completion at `13:13:27.982Z`.

The maximum sample inside a complete, timestamped workload phase was 49,664 KiB at `13:13:46.887Z`, during cancellation concurrency 1, repetition 1 (`13:13:46.874Z`–`13:13:46.893Z`). The next maximum, 49,904 KiB at `13:13:47.966Z`, fell between the last complete phase end (`13:13:47.725Z`) and the incomplete concurrency-2 phase start (`13:13:48.127Z`). The concurrency-2 phase has no end marker because the script stopped after the 429.

The first sample after that failed phase start was 50,544 KiB at `13:13:48.232Z`. The later idle-window maximum was 50,608 KiB at `13:14:27.439Z`. The idle maximum is not a workload peak and does not measure retention during active requests. Post-event samples stayed between 50,544 and 50,608 KiB through `13:14:44.254Z`; this does not prove release or non-release.

The 250 ms sampler missed many short phases. Upload batches lasted 7–58 ms. Samples fell inside only 2 of 9 upload batches and 3 of 9 inline RPC-result batches. Thus 13 of those 18 batches had no in-phase RSS sample. All nine slow-read batches had 2–4 samples each. Only one of the three first-script concurrency-1 cancellation phases had an in-phase sample. The failed concurrency-2 cancellation phase lacks an end marker and has no sample before its failed response. These gaps limit every phase peak.

The separate cancellation sweep recorded 144 samples from nine processes, with a 2,448–44,560 KiB range and one 2.49-second startup gap. Those processes used separate persistence. Their values do not form one baseline-to-release series and do not repair the primary phase gaps.

### R4 — reproduction limits and command sequence

The retained files do not exactly reproduce the recorded cancellation sweep. `/tmp/oab-s4-workload.mjs` runs shared-state cancellation and stops on the first 429. `/tmp/oab-s4-cancel.mjs` repeats concurrency 1, then stops at concurrency 2 repetition 2 after another 429. The captured restart phase file contains nine processes, but the retained `/tmp/oab-s4-cancel-sweep.sh` now lists only concurrency 1 repetition 3, concurrency 2 repetitions 1–3, and concurrency 4 repetitions 1–3. Its contents do not match all captured concurrency-1 repetitions. It also contains a checkout-specific absolute path, which is not copied here.

The exact original cancellation sweep script was not retained. The records do not show the edits made between attempts. The full cancellation run cannot be exactly reproduced from the retained scripts. A new exact sweep would need a repo-relative working-directory command and an explicit list of all nine `(concurrency, repetition)` pairs, each with its own persistence directory. This is a reproduction correction only. It was not run, and no workload or server ran during this review correction.

Useful local-only setup commands are:

```sh
cat > apps/worker/wrangler.s4-local.jsonc <<'EOF'
{
  "name": "oab-s4-local-only",
  "compatibility_date": "2025-07-12",
  "main": "test/fixtures/http-worker.ts",
  "durable_objects": {
    "bindings": [{ "name": "VAULTS", "class_name": "Vault" }]
  },
  "r2_buckets": [{ "binding": "R2_BUCKET", "bucket_name": "oab-s4-local-only" }],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Vault"] }]
}
EOF
cd apps/worker
./node_modules/.bin/wrangler dev --local \
  --config wrangler.s4-local.jsonc \
  --persist-to /tmp/oab-s4-local-state \
  --ip 127.0.0.1 --port 18787 --inspector-port 19387 \
  --show-interactive-dev-session false
```

The config omits compatibility flags. Identify the `workerd` process that serves port `18787`, then sample it with `ps` every 250 ms. The original workload command was `node /tmp/oab-s4-workload.mjs`. Do not rerun it as-is: its shared-state cancellation phase failed at concurrency 2. The isolated helper command was `node /tmp/oab-s4-cancel-once.mjs <concurrency> <repetition>` while its local server was available. The exact original wrapper script and its manual edits were not retained. The current sweep script needs a repo-relative path and all nine `(concurrency, repetition)` pairs to match the recorded phases. These examples describe earlier runs; no corrected script ran. Any new measurement needs owner approval.

## Review closure summary

- R1 closed in notes only: disclose the full repeated request inventory and hard-cap violation. No attempt was made to undo or excuse it.
- R2 closed in notes only: replace the mixed cancellation summary with consistent isolated-run rows and list shared-state attempts separately.
- R3 closed in notes only: report the in-phase sampled maximum, between-phase sample, first post-event sample, later idle maximum, phase times, and sample misses.
- R4 closed in notes only: state that retained scripts do not reproduce the complete capture, list the mismatch and manual edits needed, and give the local-only command sequence. No unrun correction is claimed.

Validation evidence: the completed earlier `bun run check` exited 0. It checked lint on 302 files, docs, workspace types, 2,254 tests across 126 files with one skip, and three dry-run builds. This prose-only correction did not rerun the full check. `git diff --check` will run for this correction before commit.

Acceptance: all four criteria remain unchecked. Keep status Deferred. Local RSS is not a deployed runtime envelope or native release bound. The 32 MiB limit is payload/application accounting only. It does not count native copies and does not show active application memory.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Corrected the S4 notes after task review. The notes now disclose the cancellation hard-cap violation, enumerate all recorded attempts and failures, separate consistent result sets, link RSS samples to phases and gaps, and state reproduction limits. The task remains Deferred with all four criteria unchecked. Parent review and publication remain pending.
<!-- SECTION:FINAL_SUMMARY:END -->
