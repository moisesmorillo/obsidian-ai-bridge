---
id: OAB-52
title: Release every isolate read slot at its hold deadline
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-09T21:55:00Z'
updated_date: '2026-11-09T22:13:00Z'
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
- [ ] #1 A regression first reproduces a read slot held beyond its deadline.
- [ ] #2 Every read acquisition path frees expired local capacity, including MCP, search, preparation, abort, errors, and unread bodies.
- [ ] #3 Count limits increase within a documented aggregate memory bound below 128 MB. Agent work cannot consume the device read reservation.
- [ ] #4 Spec section 6.5 and affected tests match approved limits. Protocol shapes stay unchanged.
- [ ] #5 Thirty parallel mixed MCP calls receive success or bounded retry while device sync succeeds. Admission waits stay bounded and idle periods create no agent timers.
- [ ] #6 bun run check and semantic task and branch reviews pass before owner branch review and pull request.
- [ ] #7 A synthetic 300-operation Linear migration and a 300-call spike complete through bounded retries while device sync succeeds. Append retries create no duplicates.
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
<!-- SECTION:NOTES:END -->
