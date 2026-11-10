---
id: OAB-58
title: Stop truncated feed bodies and REST read-slot exhaustion under MCP load
status: Done
assignee:
  - '@claude'
created_date: '2026-11-10T12:08:00Z'
updated_date: '2026-11-10T16:33:00Z'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 98000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Production incident 2026-11-10 04:09Z, Worker 1.0.2, during a ChatGPT Linear migration of about 4k MCP calls. The Mac plugin stayed at cursor 591 for 20 min. The plugin keep-alive connection got intermittent 429 admission_limited on /v1/vault and a 200 /v1/changes body cut at 499 of 774 bytes (content-encoding zstd), so sync failed with 'Sync response is not valid JSON'. A renderer fetch with the same token got 200 and valid JSON. The owner console showed one isolate with 4 held read slots and 1 incomplete read response at the lease deadline. A redeploy (run 42754212586) cleared it. OAB-52 limits (4 REST, 8 MCP, 60 s hold) did not prevent it. The lazy JSON reads (/v1/changes, /v1/manifest, /v1/vault) lack Cache-Control: no-transform, which files, blobs, history and content reads already send. Hypothesis: the edge compresses the stream, and when the Worker errors the body at the lease deadline, the edge ends the zstd frame cleanly, so the client sees a short 200 instead of a network error.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression first shows that every JSON read route sends Cache-Control: no-transform, and the routes then pass.
- [x] #2 A regression first reproduces the production condition that holds all four REST read slots during MCP load, and the fix then keeps device reads admitted.
- [x] #3 A body that the Worker stops at its lease deadline can never reach the plugin as a complete 200 JSON page; the plugin classifies a short or malformed body as a retryable transport failure.
- [x] #4 The owner measurements page shows held read slots per pool (REST, MCP) and the route of the oldest held lease, so the next incident has evidence.
- [x] #5 Spec sections that describe read admission, feed responses and measurements match the change. Sync and MCP protocol shapes stay unchanged; the only protocol change is additive optional owner measurement fields (owner approved 2026-11-10).
- [x] #6 bun run check, task review and branch review pass before the pull request.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Root cause (verified in code): tryAcquireReadSlot reserves 4.5 MB of the 18 MB rest_read pool (read-budget.ts:154-158). expire() frees only the logical lease; bytes return only through lease.complete() (read-budget.ts:202-210), which waits for late DO work and source cancellation with no timeout (read-budget.ts:96-100, read-response.ts:129-133). Four reads whose work never settles leave the REST pool full for the isolate lifetime: persistent 429 for devices while logical counters look healthy. Lazy JSON reads have no Cache-Control: no-transform, so a body errored at the deadline can reach the client as a short 200 through edge zstd.
1. RED apps/worker/test/read-slot-expiry.test.ts: four /v1/changes reads stall on a never-resolved readBatch gate; advance past the deadline plus grace; /v1/vault must answer 200 (today 429, rest_read_bytes 18000000). GREEN: a physical reclaim deadline (lease deadline + 60 s grace) releases the byte reservation of unsettled work once and counts it as reclaimed_unsettled. Late settlement after reclaim releases nothing twice.
2. RED: every JSON read and read failure response (/v1/vault, /v1/manifest, /v1/changes, /v1/history, /v1/search, failureResponse) sends Cache-Control: no-transform. GREEN: one shared JSON response header helper.
3. RED apps/worker/test/read-response.test.ts: lease expiry after the first chunk makes reader.read() reject, never close cleanly.
4. RED plugin SyncTransport test: a 200 with truncated JSON raises a retryable transport failure class, not a plain Error classified as other. GREEN in sync-transport.ts parseJson callers.
5. Measurements: owner page and JSON show held REST and MCP leases per pool, REST and shared reserved bytes, reclaimed_unsettled count, and the route plus age of the oldest held REST lease. Route label passes into tryAcquireReadSlot.
6. Spec 6.5 and the measurement section match. Protocol shapes unchanged. bun run check, code-review skill, task review, branch review, PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Step 1 RED: read-slot-expiry.test.ts 'unsettled REST read reclaim > admits a device read after four stalled feed reads pass their grace' failed with 'AssertionError: expected 429 to be 200' (/v1/vault after deadline + 60 s, rest_read_bytes 18000000). GREEN: READ_SLOT_RECLAIM_GRACE_MS lazy reclaim in sweepExpiredReadSlots, no new timer; late complete() does not double-release.

Step 2 RED: http/reads.test.ts 'sends no-transform on every JSON read and read failure' failed on /v1/vault with cacheControl null (expected 'no-transform'). GREEN: transport/json-read-headers.ts jsonReadHeaders used by reads.ts (pages, scalar reads, failureResponse) and search.ts (body and failures). No earlier shared helper existed; content, file, blob, and history routes keep their inline header.

Step 3 exception (AGENTS.md): read-response.test.ts 'errors, never closes, a body whose lease expires after its first chunk' was green without an earlier failing test; ownedReadResponse already errors the controller at expiry. Kept the test. Mutation check: replacing controller.error with controller.close in expire() and the stopping branch made it fail with 'promise resolved { value: Uint8Array[], done: true } instead of rejecting'; source restored.

Step 4 RED: plugin sync-transport.test.ts 'raises a retryable network failure for a truncated {vault,manifest,changes} 200 body' (4 cases) failed with 'AssertionError: expected Error: Sync response is not valid JSON to be an instance of DeviceSessionNetworkError'. GREEN: parseJson throws the existing DeviceSessionNetworkError, which main.ts reportSyncFailure classifies as network. SyncTransportError was not reused because its 2xx statusClass maps to other in main.ts.

Step 5 RED: read-budget.test.ts 'reports physical holds per pool and the oldest REST lease route' failed with 'AssertionError: expected { …(7) } to match object { held_rest_slots: +0, …(4) }'; owner-pages.test.ts 'renders measurements with explicit unknowns…' failed with 'expected ... to contain Held leases: REST 4, MCP 1'. GREEN: optional additive worker_isolate fields in packages/protocol (ReadSlotRouteSchema enum, held_rest_slots, held_mcp_slots, rest_read_bytes, shared_bytes, reclaim_grace_ms, reclaimed_unsettled_count, oldest_rest_lease); route label passed by vault, manifest, changes, history, search, files; new card and About text on the page; snapshot updated for the new card and the unknown line.

Validation: bun run check exit 0 (protocol 314, tooling 107, plugin 873 + 1 skipped, worker 835 + http 134 + f2 149 tests). bun run docs:check green. Deviations: (a) reclaim is lazy in sweepExpiredReadSlots, not a timer, so existing zero-timer assertions hold and every admission and measurement applies it; (b) measurement fields required additive optional fields in packages/protocol MeasurementResponseSchema.worker_isolate plus a new ReadSlotRouteSchema enum; (c) truncated JSON uses the existing DeviceSessionNetworkError, not SyncTransportError; (d) fileFailureResponse (file content read failures, shared with mutations) does not send no-transform, out of the listed routes. AC 6 left for parent review.

Review fixes (reviewer minors, owner wants no deferrals):
1. MCP reclaim RED: read-slot-expiry.test.ts 'releases shared bytes of eight stalled MCP reads after their grace' failed with shared_bytes 32116416 (expected 0) after deadline + grace, while held_mcp_slots 0 and reclaimed count 8. GREEN: tryAcquireReadSlot takes an optional reclaimable reservation; mcp-http passes the MCP envelope reservation; reclaim releases it once, caller release stays idempotent. A new MCP read is then admitted (200); before the grace a ninth read got 429.
2/5/6. Reclaim counter TSDoc now covers REST and MCP; defensive expiry comment reworded; MCP leases use route 'mcp', added to ReadSlotRouteSchema, TSDoc no longer REST-only.
3. MCP no-transform RED: same test, 'expected no-store to be no-store, no-transform'. GREEN: encodedResponse sends no-store, no-transform.
4. File failure RED: http/reads.test.ts no-transform case /v1/files/missing.md got cacheControl null. GREEN: fileFailureResponse uses jsonReadHeaders (applies to file read and mutation failures).
7. Plugin truncated readPinned, readCurrent, put, rename, delete 200 bodies: green without earlier failing test (parseJson fixed in dd3e4bc); mutation check with the old plain Error made all 9 truncated cases fail; source restored.
8. Spec 6.5 and 12 updated.
Validation: bun run check exit 0 (protocol 314, tooling 107, plugin 878 + 1 skipped, worker 836 + http 134 + f2 149); docs:check green. AC 5 wording unchanged pending owner decision on deviation (b).

Re-review minors: (1) RED read-slot-expiry.test.ts 'admits a REST write after stalled MCP envelopes pass their grace' (8 padded MCP reads, about 59 MB shared held, PUT before grace 429) failed with 'expected 429 to be 201' for the PUT after the grace with no read or measurement between. GREEN: tryAcquireBodySlot calls sweepExpiredReadSlots first; body-budget -> read-budget is application to application, no cycle. (2) MCP reclaim test now calls readNote(10) before any snapshot, so MCP admission alone reclaims. bun run check exit 0 (protocol 314, tooling 107, plugin 878 + 1 skipped, worker 837 + http 134 + f2 149).

Production check 2026-11-10 after PR #156: Worker 1.0.3 deployed by Release Please run 42855445110. /v1/vault from the Mac plugin returns Cache-Control: no-transform. The owner measurements page shows held leases per pool, reserved bytes, oldest REST lease and the 60000 ms reclaim count. Mac at cursor 600 = head, settled, no failure.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Read leases that never settle now release their byte reservation once at lease deadline + 60 s, for REST and MCP pools. REST read, MCP and body admission sweep first. All JSON read, read-failure and MCP responses send Cache-Control: no-transform. The plugin treats a short or malformed 200 sync body as a retryable network failure. The owner measurements page shows held leases per pool, reserved bytes, the reclaim count and the oldest REST lease. Verified by RED/GREEN tests, bun run check, task and branch review, and a production check on Worker 1.0.3. Risk: reclaimed work can still use memory after the grace (owner decision D1). The edge zstd truncation cause stays a hypothesis.
<!-- SECTION:FINAL_SUMMARY:END -->
