---
id: OAB-52
title: Release every isolate read slot at its hold deadline
status: Done
assignee:
  - '@pi'
created_date: '2026-11-09T21:55:00Z'
updated_date: '2026-11-10T00:28:00Z'
labels: []
dependencies: []
priority: high
type: bug
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner R3 brief reports persistent isolate read denial after parallel MCP calls. Earlier fixes did not prevent a 45-minute block despite a 60000 ms deadline. This owner-approved fix excludes personal vault access, deployment, OAB-51 README changes, and OAB-50.8 rename work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression first reproduces a read slot held beyond its deadline.
- [x] #2 Every read acquisition path frees expired local capacity, including MCP, search, preparation, abort, errors, and unread bodies.
- [x] #3 Count limits increase within a documented aggregate memory bound below 128 MB. Agent work cannot consume the device read reservation.
- [x] #4 Spec section 6.5 and affected tests match approved limits. Protocol shapes stay unchanged.
- [x] #5 Thirty parallel mixed MCP calls receive success or bounded retry while device sync succeeds. Admission waits stay bounded and idle periods create no agent timers.
- [x] #6 bun run check and semantic task and branch reviews pass before owner branch review and pull request.
- [x] #7 A synthetic 300-operation Linear migration and a 300-call spike complete through bounded retries while device sync succeeds. Append retries create no duplicates.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan gate: /tmp/OAB-52-read-slot-plan.md. Use absolute read deadlines with admission and measurement sweeps. Split read capacity into four REST and eight MCP slots. Raise body and MCP ceilings to eight with weighted memory admission: 64 MB shared MCP/body budget plus 18 MB separate REST read allowance, leaving 46 MB of the conservative 128 MB isolate limit. MCP waits at most 2000 ms with 30 queued requests, no body demand while queued, release-triggered wakeups, and local retry delays from 2 through 60 seconds. Add RED/GREEN coverage for suppressed timers, path ownership, memory bounds, and 30 mixed MCP calls during sync. Update spec section 6.5 and affected documentation. Run docs:check and check, semantic task and branch reviews, owner branch review, rebase, and PR publication. No vault access or deployment.

Owner acceptance addition after approval: test 300 operations across ten bursts of 30, plus a 300-call spike. Use synthetic task notes, all named MCP tools, exact revisions, stable retry keys, and a test-driver retry loop for explicit admission refusals. No Linear account or vault access. Admission numbers and memory contracts stay as approved.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner additions cover memory-bounded limits, reserved device capacity, and burst-aware admission. Final values need plan approval. A read-only probe suppressed request timers and advanced Date.now by 61000 ms. A fifth acquisition failed with active_slots=4 and expired_count=0. This proves missing admission-time recovery, not the exact production trigger.

Baseline Workers read-response suite passed 30 tests. Feasibility review found fixed-count memory risk and timer-only expiry. The plan corrects its low body estimate with hashing, RPC, and heading-append costs. Live Cloudflare limits documentation confirms 128 MB per isolate on Free and Paid plans. Complete V8 heap size and the exact production trigger remain unproven. Orca setup added two unrelated lock version fields. They remain in a named Git stash and do not enter this diff.

Owner approved plan pn-f28109. The later bulk Linear migration case adds acceptance workload coverage without changing approved admission contracts. Implementation starts through one worker. Memory persistence is unavailable because the Engram runtime contract returns HTTP 404.

Implemented absolute read lease deadlines with admission and measurement sweeps, separate REST/MCP read pools, eight MCP envelope slots, and eight body count. Focused tests pass. Full weighted-byte admission, bounded MCP wait queue, bulk migration coverage, and updated legacy four-slot body tests remain incomplete; do not close OAB-52. Added OAB-53 for heap/native profiling with the approved trigger. Full check currently fails because legacy count-bound tests still expect four body slots, and a pre-existing wall-clock measurement test fails.

Completed the remaining approved implementation after partial commit 8f83d1f. Weighted admission now enforces 64 MB shared MCP/body bytes and 18 MB separate REST read bytes. Logical read expiry frees counts. Physical bytes remain held through started work, cancellation, response cleanup, and writer shutdown. Late successful reads cannot publish and keep durable outcomes uncertain. Eligible FIFO waiting has a 2000 ms bound, 30 queued requests, and no queued body demand. New regressions cover suppressed timers, stale releases, cancellation, fairness, maximum envelopes, strict prototype keys, and idle timer cleanup. The real-router waves30 and spike300 fixtures each complete 300 mixed operations with concurrent device reads and no duplicate appends. Fixture retries accept only explicit admission refusals. Production mutation retries remain unchanged. Semantic self-review corrected early REST byte release and the hardcoded four-slot owner card. Full bun run check passes: 2381 tests pass, one test skips, and no tests fail. Formatting and docs:check also pass. OAB-53 keeps the approved heap/native profiling limit. OAB-52 stays In Progress for parent task review, branch review, rebase, owner review, and publication.

Coverage exception: maximum-envelope and lease-unit tests passed when first added. Kept the existing implementation and added these coverage tests. Separate RED runs reproduced late EOF, suppressed entry timers, native cancellation release, strict prototype-key validation, owner count display, and early fixed-writer byte release before their corrections.

Task review round 1 corrections: the fixed pump now owns physical lease completion after expiry. Source and durable cleanup cannot bypass pending writer abort.

MCP read refusal now uses the earliest active MCP lease deadline. The estimate uses whole seconds rounded upward, with a 2..60-second bound. Unknown physical completion keeps the two-second fallback.

RED reproduced early byte release and fixed retry values. Sixty focused tests and the full check pass with 2393 passed, zero failed, and one skipped. OAB-52 stays In Progress for parent re-review.

Final branch review correction from base c18a4f7: blob reads retain and join the first native cancellation promise. Source cleanup settles before response owner transfer and MCP byte release. The real-router regression covers resolved and rejected cleanup, source settlement, durable settlement, queued replacement admission, and zero final accounting.

Spec section 6.5 now distinguishes full logical MCP deadline estimates from unknown physical-byte completion. Focused tests pass 19 cases. The rebased full check passes 2384 tests, with zero failures and one skip.

Corrective semantic self-review closes F1 and F2. Main deletion of docs/api/f2.md stays intact. OAB-52 stays In Progress for parent scoped re-review and owner branch review.

Parent review record at code revision 128bb3a. Task review fef8fb2b found early fixed-writer byte release and a missing known-deadline retry estimate. Commit 97ae7e4, now c18a4f7 after rebase, fixes both. Scoped review 0a685419 approved. Whole-branch review a972cf80 found first blob-cancellation promise loss and incomplete retry documentation. Commit 128bb3a fixes both with router-level RED/GREEN evidence. Scoped review 6ab82e0d approved. All actionable findings have evidence-based closure. Stateful review covered scheduler, leases, body owner, response pump, MCP HTTP, blob source, and meaningful declarations. The auxiliary history.ts AST diagnostics do not establish semantic defects because decoders catch parse failures and canonical schemas validate boundary unknown values. Main through 9fc7e64 is rebased. Its deletion of docs/api/f2.md remains intact. Final bun run check at 128bb3a passes 2384 tests, zero failures, one skip, docs, types, lint, and dry-run builds. The 300-call schedules pass with concurrent device reads. Application admission reserves at most 82 MB with 46 MB arithmetic headroom, not proof of total heap safety. OAB-53 and the unknown production trigger remain explicit limits. Owner branch review remains pending.

Owner approved the complete branch diff in Plannotator pn-6a990e with no changes requested. Plan approval was pn-f28109. Code revision 128bb3a passed the final full check and scoped semantic review. Current main remains 9fc7e64 with no unincorporated commits. All seven acceptance criteria have direct regression or review evidence. No vault access, deployment, Cloudflare resource change, new dependency, or production mutation retry occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Recovered logical read capacity through absolute deadlines and protected four REST read slots from eight MCP read slots. Added eight body and envelope ceilings with weighted byte admission, a 2000 ms MCP wait, thirty waiters, and useful bounded retry delays. Kept physical bytes until source, cancellation, response, and writer cleanup end. Synthetic 300-operation migration and 300-call spike tests preserve device reads and exact append results. Final full check passes 2384 tests with zero failures and one skip. Task, branch, scoped corrective, and owner reviews pass. OAB-53 defers complete heap profiling. The exact production trigger remains unproven. No deployment occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
