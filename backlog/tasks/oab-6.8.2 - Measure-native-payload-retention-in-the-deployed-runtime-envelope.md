---
id: OAB-6.8.2
title: Measure native payload retention in the deployed runtime envelope
status: Deferred
assignee:
  - '@pi'
created_date: 2026-10-20 23:27
updated_date: '2026-11-04T23:15:00Z'
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
Execute approved S3 item 3 with existing-deployment read paths only. Inspect available telemetry and auth without creating clients or grants. Observe concurrency 1, 2, and 4 with at most three repetitions, slow consumption, and cancellation. Bound each request at 30 seconds. Record response bytes, time, status, runtime facts, and limits in task notes. Do not upload, deploy, change resources, or infer native memory from timing. Leave unmet criteria open and return the task to Deferred when native attribution is unavailable. Review the notes and publish PR 3 if task changes need a branch.
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
<!-- SECTION:NOTES:END -->
