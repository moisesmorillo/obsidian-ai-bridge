---
id: OAB-61
title: Fix capacity, overload, and feed latency limits found by the OAB-53 load runs
status: Done
assignee:
  - '@claude'
created_date: '2026-11-10T20:51:00Z'
updated_date: '2026-11-10T21:32:00Z'
labels: []
dependencies: []
references:
  - backlog/tasks/oab-53 - Profile-Worker-admission-heap-and-native-memory.md
priority: high
type: bug
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The OAB-53 production load runs on 2026-11-10 (Worker 1.0.4, Workers Paid, see OAB-53 notes) found four defects. (1) A client that cancels a 25 MB blob read leaves its REST read lease and 4.5 MB reservation held for about 120 s (lease plus reclaim grace, READ_SETTLEMENT_FAILED in local logs); a few cancels fill the REST pool and later reads and uploads get 429. OAB-36 records that FixedLengthStream exposes cancellation only at the next write. (2) Twelve parallel 1 MB text uploads made the Vault Durable Object answer 'Durable Object is overloaded. Requests queued for too long.', which reached clients as HTTP 500 instead of a retryable refusal. (3) GET /v1/changes from seq 0 with limit 1000 took 5 to 15 s median and up to 32.6 s. (4) Locally the Miniflare Vault DO failed its startup schema check on the Miniflare-internal table __miniflare_do_name after a restart. The owner asked to fix all four now instead of deferring them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression first shows that a cancelled blob read keeps REST capacity held, and the fix then releases the read capacity promptly after client cancellation without double release or loss of native Content-Length.
- [x] #2 A regression first shows that a Durable Object overload error becomes HTTP 500, and the fix then returns a retryable refusal (503 or 429 with Retry-After) on REST and an equivalent retryable MCP error.
- [x] #3 The cause of slow full-feed pages is identified with a measurement, and a fix or bounded change brings a 1000-entry page well below the observed 5 s median, with a test that guards the change.
- [x] #4 The startup schema check accepts the Miniflare-internal __miniflare_do_name table without weakening production schema validation, with a test.
- [x] #5 Spec sections match the change and bun run check, task review, and branch review pass before the pull request.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Root causes verified before code (details in notes).
1. Cancelled blob read: Workers cancel every task of a request whose client disconnects unless it is registered with waitUntil. ownedReadResponse never registers its pump/settlement, so after a disconnect the FixedLengthStream pump never sees its failed write, never cancels the R2 source, and the lease and 4.5 MB reservation stay until lazy reclaim (deadline + grace = 120 s). RED: http/blobs.test.ts cancels a 25 MB read after one chunk and expects rest_read_bytes 0 within 2 s. GREEN: ownedReadResponse registers a work-settled promise with waitUntil (cloudflare:workers) resolved when the lease completes. Keep the REST byte reservation for blob streams (owner may revisit); no change to native framing or OAB-36 ordering. No compatibility flag change (enable_request_signal is opt-in until 2026-11-17 and not needed).
2. DO overload: a composition decorator converts DO stub errors with overloaded === true into VaultOverloaded (FileOperationDenied admission_limited, Retry-After). REST maps it to 429 admission_limited with Retry-After at every unknown-error site that today returns 500; MCP tool errors carry code admission_limited. Protocol unchanged. Plugin already retries 429 honoring Retry-After (existing tests); no plugin change unless a test shows otherwise. RED: HTTP fixture injects an overloaded RPC error; PUT and feed reads return 500 before the fix.
3. Slow full feed: JSON encoder yields each token as its own response chunk (54,017 chunks for a 1,000-entry 219 KB page, ~470-800 ms locally per page; each chunk crosses the runtime pipe in production). GREEN: coalesce encoded parts into 16 KB chunks, flushing at each storage batch boundary so batch demand stays one at a time. Guard test bounds the chunk count and checks exact JSON.
4. Schema check: allow exactly the Miniflare table __miniflare_do_name with its exact DDL in both the fresh-vault detection and unexpected-object rejection. Test restart with that table and a lookalike rejection.
5. Spec 6.5 (and 6.2/8 if needed) updated; bun run docs:check and bun run check; logical commits; check AC 1-4.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Item 1 root cause probe (Miniflare 4.20251011.1, real HTTP socket, compat date 2025-07-12): a FixedLengthStream pump whose client disconnects never observed its failed write and never ran later I/O without ctx.waitUntil; with waitUntil the write rejected promptly and later timer and KV I/O ran. With enable_request_signal the abort listener fired, but awaited pump work still did not continue without waitUntil. Cloudflare docs: the flag defaults on only from 2026-11-17.
Item 1 RED: http/blobs.test.ts 'returns REST read capacity promptly after a client cancels a large blob read' (25 MB blob, read one chunk, cancel, poll 2 s) failed with 'expected 4500000 to be +0'. GREEN: ownedReadResponse registers a work-settled promise with waitUntil from cloudflare:workers, resolved at lease completion; worker core 837, http 135, f2 149 passed.
Item 3 measurement (local, http suite, 1,000 seeded feed rows, GET /v1/changes since=0 limit=1000, 218,965 bytes): before 54,017 response chunks (about 4 bytes each), 778-812 ms with a chunk reader and 467-487 ms with text(); after coalescing 38/30/33 ms with text(), Worker emits about 19 chunks (16 KB plus one flush per 64-row batch; the local service binding re-chunks to 4,096 bytes). 17 DO batch RPCs per page are unchanged. RED: http/reads.test.ts 'streams a full 1,000-entry feed page in coalesced bounded chunks' failed with 'expected 54017 to be less than or equal to 64' (bound later set to 128 for the 4,096-byte local re-chunking).

Item 4 RED: vault-storage.test.ts 'accepts the exact Miniflare instance-name table on restart and on a fresh store' failed with 'Error: Unexpected vault table: __miniflare_do_name'. The lookalike rejections (extra column, __miniflare_other) passed before and after, as intended guards. GREEN: isPlatformCatalogObject allows only that name with the exact stored DDL from the Miniflare do-wrapper, in fresh detection and unexpected-object rejection. Commit 765cc13. Items 1 and 3 committed as 2752e30 and 3bfc0ab.

Item 2 RED: new apps/worker/test/vault-overload.test.ts injects an Error with overloaded === true into one Vault RPC of a plain gateway object (as production composes it). Before the fix 14 cases failed: ten REST cases (PUT at beginMutation, authorize, commitText; vault; feed open; feed batch; manifest batch; content read; history; search) with 'expected 500 to be 429', four MCP tool cases (read_note readText, create_note beginMutation and commitText, list_notes readBatch) with 'expected internal_error to be admission_limited'. A later case for the MCP request epoch check failed with 'expected 500 to be 429'. GREEN: application/vault-overload.ts (VaultOverloaded = FileOperationDenied admission_limited, Retry-After 5; refuseVaultOverload gateway proxy; unexpectedFailure helper). createWorker wraps resolveVault for REST and MCP. Catch-all sites in transport/reads.ts (first lazy batch), mcp-notes (settleMcpRead, readMcpNote), mcp-mutations, and mcp-http outer catch (HTTP 429 with retry-after) map it. Unknown errors still return 500 (guard case). Protocol unchanged: admission_limited already exists with Retry-After.
Coalescing side effect: f2 mcp-reads 'keeps real durable admission until MCP response EOF and cancellation' failed after 3bfc0ab with 'expected 1 to be greater than 1'. Cause: earlier tests fill the shared vault, so list_notes answered a 212-byte result_too_large error, which token-sized chunks had split. Fixed in 6f1cd3c by listing the seeded prefix; the test now streams its 256 rows. Order note: 3bfc0ab alone fails that f2 test; 6f1cd3c follows it.
Plugin: no change needed. publication.ts handleFailure retries 429 admission_limited with Retry-After (max of backoff and Retry-After). Exception (AGENTS.md): new publication.test.ts 'retries a Worker overload refusal after its Retry-After without attention' passed without an earlier failing test; mutation check adding admission_limited to the rejection list made it fail ('expected undefined to match object'); source restored.

Validation: bun run docs:check passed. bun run check exit 0 (protocol 314, tooling 107, plugin 879 + 1 skipped, worker 861 + http 136 + f2 149). Spec: section 5 schema paragraph (startup check ignores the exact Miniflare table), section 6.5 (waitUntil keep-alive for owned read responses, 16,384-byte JSON chunk coalescing with measurements, overload refusal 429 admission_limited Retry-After 5 for REST and MCP). Commits: 2752e30, 3bfc0ab, 765cc13, 6f1cd3c, 3bbf0c3, cb98669, 1b29d97. AC 1-4 checked with the RED/GREEN evidence above; AC 5 left for the parent (task review, branch review, PR).
Deviations: (a) item 1 keeps the 4,500,000-byte REST reservation for blob streams; the defect was the missed cancellation, not the charge; changing blob accounting is an owner decision. (b) no compatibility flag change: enable_request_signal is not needed for the fix. (c) item 3 keeps 64-row storage batches (17 DO RPCs per 1,000-entry page); the chunk count was the measured cost. Production latency after deploy is not yet measured. (d) The overload refusal uses the existing 429 admission_limited code, not a new 503 code, so protocol shapes stay unchanged.
Risks: waitUntil keeps the invocation alive until lease completion; a response that nobody consumes or cancels stays bounded by the lease deadline and platform waitUntil limits. The real-network disconnect path is proven with a local Miniflare socket probe and the SELF cancel test, not in production. A refused overloaded mutation can still have reached the object; retries stay conditional.

Review round 1 (rebased onto origin/main f7d003f).
F1 RED: vault-overload.test.ts now asserts remaining admission states. Seven cases failed with 'expected [] to deeply equal [uncertain]': REST blob PUT at commitBlob, vault read, content read, history read, search; MCP search_notes and get_history. GREEN: knownFailureCompletion keeps VaultOverloaded uncertain in application/blobs.ts, transport/content-reads.ts, application/reads.ts (finishReadFailure completion), application/search.ts; still 429 admission_limited. Commit 86bfb56. Rename (commitFileCommand), PUT authorize/commit, update_note and create_note commit already stayed uncertain (F4 cases added there, green on first run).
F2 RED: read-response-keepalive.test.ts (mocks cloudflare:workers waitUntil). Against the previous read-response.ts: 'expected [Promise] to have a length of +0' (keep-alive registered before the RangeError) and 'expected false to be true' (keep-alive still pending 5 s after a deadline whose cancellation never settles). GREEN: length validated first; expire() ends keep-alive when finish settles or after READ_SETTLEMENT_DEADLINE_MS (now exported). Commit 8ec0f9a.
F3 BLOCKED: a cancel-after-first-chunk test for GET /v1/changes limit=1000 fails with 'expected 4500000 to be +0' even after 15 s (held_rest_slots 1, route changes). Instrumentation: the generic JS byte stream gets 3 pulls and its cancel callback never runs after the SELF consumer cancels, with or without waitUntil and with or without type bytes. Miniflare 4 (workerd 1.20251011) socket probe: default-type streams got cancel with waitUntil, byte streams did not. Piping the generic stream through IdentityTransformStream made the test pass but broke 22 existing ownership tests (expiry errors, demand, cancellation joins), so it was reverted. No test committed; spec 6.5 states the known limit. Needs an owner decision: a writer-pump redesign of generic responses (separate task) or a deferred task with a runtime trigger.
F5: spec schema version 9 (blob_gc table and metadata, OAB-13, 0e390af) in 802558c.
bun run check exit 0 (protocol 314, tooling 107, plugin 879 + 1 skipped, worker 867 + http 136 + f2 149); docs:check green.

Round 2 review: approve. Finding 3 (cancelled JSON byte streams keep their lease until reclaim) moves to OAB-62, which starts right after this branch. Spec §6.5 and the keepResponseWorkAlive TSDoc reference it.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Cancelled blob reads now release REST capacity promptly (waitUntil keeps response work alive after disconnect, bounded 5 s after the lease deadline). Durable Object overload errors become 429 admission_limited with Retry-After 5 on REST and MCP, keeping the admission uncertain. Full feed pages coalesce JSON into 16 KB chunks (about 470 ms to 33 ms per 1000-entry page locally). The startup schema check accepts the exact Miniflare __miniflare_do_name table. Spec schema version is 9. Cancelled JSON byte streams still hold their lease until reclaim; OAB-62 fixes that.
<!-- SECTION:FINAL_SUMMARY:END -->
