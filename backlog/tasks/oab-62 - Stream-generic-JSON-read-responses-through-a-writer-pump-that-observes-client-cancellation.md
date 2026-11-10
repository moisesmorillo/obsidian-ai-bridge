---
id: OAB-62
title: >-
  Stream generic JSON read responses through a writer pump that observes client
  cancellation
status: In Progress
assignee:
  - '@claude'
created_date: '2026-11-10T21:32:00Z'
updated_date: '2026-11-10T21:49:00Z'
labels: []
dependencies:
  - OAB-61
priority: high
type: bug
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-61 found that generic JSON read responses (feed, manifest, history, search, vault, content JSON, MCP) are JavaScript byte streams whose cancel callback the Workers runtime never calls when the client cancels across the runtime boundary. The REST read lease and its 4.5 MB reservation then stay held until the OAB-58 reclaim (about 120 s), so a few cancelled reads fill the REST pool. Fixed-length blob responses do not have this defect because their pump writes into a FixedLengthStream and sees the failed write. A quick IdentityTransformStream wrap made the cancel test pass but broke 22 existing ownership tests, so the fix needs a deliberate redesign of read-response ownership. The owner wants this fixed now, not deferred.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression first shows that cancelling a JSON feed page after its first chunk keeps held_rest_slots and rest_read_bytes above 0, and the fix then returns both to 0 promptly.
- [x] #2 JSON read bodies keep OAB-58 semantics: lease expiry errors the body and never closes it cleanly, and capacity is released once.
- [x] #3 Output bytes, chunk coalescing, one-batch-at-a-time demand, and the existing ownership tests keep passing, or each changed test records why its old expectation was wrong.
- [x] #4 MCP JSON responses get the same cancellation behaviour, with a test.
- [ ] #5 Spec §6.5 removes the known limit, and bun run check, task review, and branch review pass before the pull request.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. RED: http/reads.test.ts cancels GET /v1/changes limit=1000 after the first chunk across SELF and expects held_rest_slots 0 and rest_read_bytes 0 within 2 s; f2 mcp-reads cancels a read_note response after its first chunk and expects the MCP lease and shared bytes back.
2. Probe native IdentityTransformStream semantics in the test runtime (write resolution vs consumer reads, writer.ready, reader.cancel effect on writer) before choosing the gate.
3. GREEN: generic responses return the readable side of a native IdentityTransformStream driven by a pump: demand one source chunk only after the previous write is consumed, coalesced chunks unchanged, rejected write = consumer cancellation (cancel source, settle settled, complete lease once), expiry aborts the writer (error, never close), EOF settles the owner before writer.close. Shares the fixed-length pump shutdown/release ordering.
4. Run read-response.test.ts and every ownership test; for each failure decide real guarantee (keep, fix pump) vs pull-model artifact (change test, record why in notes).
5. Spec §6.5: remove the known limit, describe the pump. TSDoc. bun run docs:check and bun run check. Commit logically, append notes, check AC 1-4.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED 1: http/reads.test.ts 'returns REST read capacity promptly after a client cancels a feed page' (GET /v1/changes since=0 limit=1000 over SELF, read one chunk, cancel, poll 2 s) failed with 'AssertionError: expected 4500000 to be +0' (rest_read_bytes; held_rest_slots stayed 1).
RED 2: f2/mcp-reads.test.ts 'returns MCP read capacity promptly after a client cancels a read_note response' (1 MB note, read_note over SELF, read one chunk, cancel, poll 2 s) failed with 'AssertionError: expected 1 to be +0' (held_mcp_slots).

Runtime probe (vitest-pool-workers, workerd compat 2025-07-12), native IdentityTransformStream: a write resolves only after the consumer reads the chunk; writer.ready and desiredSize stay resolved/1, so they give no demand signal; reader.cancel() rejects a pending write with the cancel reason and fails later writes ('This WritableStream has been closed'); with no write pending writer.closed stays pending, so cancellation shows at the next write (same as FixedLengthStream, OAB-36); writer.abort(reason) makes a pending read reject with the reason, and a read started after the abort rejects with 'Network connection lost.'; a pending read on a cancelled native stream rejects ('Stream was cancelled') where a JS stream resolved done. An empty write resolves without a read. Probe file not committed.
Design (faee5fc): ownedReadResponse returns IdentityTransformStream.readable for generic framing and FixedLengthStream.readable for positive lengths; one pump drives both. Demand: next() -> write -> await consumption -> next(), so one source demand at a time and at most one chunk waits in the pump (source chunks are the existing 16 KB coalesced JSON chunks, flushed at batch boundaries; output bytes unchanged). Rejected write = consumer cancellation -> settleOwner(cancel, settled) -> source cancel joined -> release once -> post-pump chain joins settlement and writer shutdown, then lease.complete() once (idempotent). Generic EOF: settle owner, complete lease, then writer.close() (old generic order: lease completion before the consumer sees EOF). Expiry: abortWriter(deadline error), so the body errors and never closes. waitUntil keep-alive unchanged. Zero-byte known length keeps its gated JS byte stream (unchanged).
GREEN: both RED tests pass. The 22 tests that broke (same count as the OAB-61 wrap) and their disposition:
A) await cancel no longer joins cleanup (11): metadata-read-response 'shares read capacity across router instances, clients, and vault hosts' and 'joins a pending batch before cancellation releases' x3 (/v1/manifest, /v1/history/files/a.md, /v1/changes); http/reads 'shares read slots across content, exact content, and metadata routes'; http/read-recovery 'settles real durable admissions only after metadata and content response EOF or cancellation' and 'shares metadata slots with current, exact, whole-blob, and range responses across vault hosts'; aggregate-body-work 'holds eight routed PUT and four metadata slots until response cleanup settles'; f2 mcp-mutations 'keeps durable mutation failure ownership through response cancel'; f2 mcp-reads 'keeps real durable admission until MCP response EOF and cancellation' and 'reuses read capacity before delayed durable cleanup'. Old expectation wrong because: the in-process body.cancel() promise joined cleanup only through the JS cancel callback, which a real client across the runtime boundary never triggered (the defect). A native readable's cancel resolves at once; cleanup follows at the pump's failed write. Each test now waits (vi.waitFor) for the same observable end state (settled admissions, freed slots, no active DO admissions); every intermediate 'still held' assertion is unchanged. The pending-batch drain also catches the rejected pending read.
B) pending source work + cancel (4): read-response 'joins pending producer work and cancellation before durable cleanup and slot reuse' and 'preserves joined outcome certainty for known producer / unknown producer / unknown cancellation'. Old expectation wrong because it required source.cancel during a pending next(); the native body observes cancellation only at the next write, as the existing fixed-length test 'joins a pending read before fixed-body cancellation cleanup' already requires (cancellationWasPrompt false). Tests now settle the pending work first, then await source cancellation; no release before work and cancellation settle, and the joined certainty outcomes (settled / uncertain / uncertain) are unchanged.
C) empty or unread sources at the deadline (5): read-response 'counts expiry after capacity release and fails the unfinished response once', 'fails an undrained response at the deadline and rejects late source completion', 'joins unread response cancellation after expiry, failure false/true'. Old expectation wrong because the pull model demanded nothing before the first read, so an empty source stayed unfinished until the deadline. The pump reaches producer EOF of an empty source at once and settles before the deadline, which spec 6.5 allows (production ends at producer EOF). The tests now give the source one chunk that the consumer never reads, so the response is unfinished at the deadline; they still require the error, the uncertain outcome, and byte retention until cleanup. 'fails an undrained response' now expects demands 1 instead of 0: one chunk ahead of the consumer is the pump bound (same as the fixed path). 'joins unread response cancellation after expiry' checks rejects.toThrow() instead of the 'deadline' message, because a read that starts after writer.abort gets 'Network connection lost.' from the native stream; only the error, not its message, crosses the runtime boundary.
D) f2 mcp-reads 'rejects byte-heavy matching prefixes without partial rows' (1): removed the 'active' admission assertion right after the response headers. The one-chunk result_too_large body reaches producer EOF as soon as the runtime takes the chunk, so admission can already be settled; spec 6.5 says producer EOF does not prove client receipt. The result shape and the final [] assertion stay.
E) mcp-http-admission 'uses absolute MCP read deadlines after 60000 ms' (1): kept unchanged. It found a real ordering guarantee (no lease timer left once the consumer sees EOF); fixed in the pump by completing the generic lease before writer.close().
Mutation check: replacing writer.abort with writer.close in abortResponseWriter made 12+ read-response expiry tests fail (including 'errors, never closes, a body whose lease expires after its first chunk'); source restored.
Validation: bun run docs:check green; bun run check exit 0 (protocol 314, tooling 107, plugin 879 + 1 skipped, worker 867 + http 137 + f2 150). Uncaught-exception log lines in the worker runs are identical to the pre-change baseline (12 request-stream disconnects, 8 network-lost, 2 injected SQLite faults). Spec 6.5: known limit replaced by the pump description (8a8e5e7).
Remaining risks: (1) proven with the SELF boundary and the in-process runtime, not a real socket or production; (2) zero-byte known-length responses still use a JS byte stream (no data, settle-gated) and REST mutation failure bodies (transport/mutation-response.ts) are JS pull streams too, so a cancel across the boundary there still waits for its owner or reclaim; out of this task's scope; (3) one chunk (<= 16 KB JSON, <= 64 KB blob) can be produced ahead of the consumer, and an unread body still holds its lease until the deadline.

Precision on risk (2): the zero-byte and mutation-response cancel gap is inferred from their JS pull-stream code and the OAB-61 probe; no test measured it in this task.
<!-- SECTION:NOTES:END -->
