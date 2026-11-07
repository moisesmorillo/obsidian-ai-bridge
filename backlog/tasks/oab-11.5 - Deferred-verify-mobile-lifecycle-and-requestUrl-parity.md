---
id: OAB-11.5
title: 'Deferred: verify mobile lifecycle and requestUrl parity'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T23:21:00Z'
updated_date: '2026-11-07T00:12:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
ordinal: 65000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 closes, the owner approves F5 copy-vault work, and enrollment works on test devices. Suspension, network return, and native HTTP behavior lack device evidence. Scope excludes Cloudflare changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 iPhone and iPad resume one serialized loop without concurrent cycles or lost queued operations.
- [ ] #2 Suspension stops scheduled work. Resume immediately recovers pending applies and immutable sent operations.
- [ ] #3 Native requestUrl preserves exact UTF-8 and binary bytes, conditional headers, ETag, Retry-After, and safe 401, 412, and 429 handling.
- [ ] #4 Interrupted uploads, low storage, and 25,000,000-byte transfers fail safely or recover with visible state.
- [ ] #5 Android observations remain separate from the Apple F5 gate.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan review: /tmp/oab-11-5/mobile-lifecycle-plan.md. Add failing lifecycle admission tests, keep one controller queue, separate automatic suspension from user Pause, and preserve ordered durable recovery. Request shared main.ts wiring and lifecycle-test permission through the plan gate. Complete code proofs for criteria 1 and 2. Record reported native transport evidence without extending it to unreported error cases. Defer criterion 4 and leave criterion 5 unchecked. After approval, use one implementer, task review, final branch review, bun run check, human diff review, and one pull request. Keep device criteria open.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Device evidence 2026-11-06: on a real iPhone with plugin 0.1.2, an edit made in airplane mode with Obsidian in the foreground was retained. After network return the device applied the newer remote revision at the path and published a conflict copy with the offline bytes. No concurrent cycle or lost operation was observed. App suspension, restart during offline state, and large transfers remain untested.

Owner authorization, 2026-11-06: F5 copy-vault work is authorized through the supervisor. This branch uses code and simulated ports only. No personal vault, live service, or Cloudflare action is authorized. The M5 brief reports native evidence on iPhone and iPad: exact UTF-8 text, a 163288-byte PNG, ETag, and Retry-After. Safe 401, 412, and 429 behavior remains distinct from that reported evidence. Device suspension and restart checks remain open.

Plan approval, 2026-11-06: owner approved Plannotator pn-902f64. Approval includes minimal main.ts mobile visibility wiring and related lifecycle tests. Automatic suspension remains separate from user Pause. Criterion 4 remains deferred in this branch.

Implementation evidence, 2026-11-06: focused RED first. `bun run --cwd apps/plugin vitest run test/desktop-sync.test.ts test/lifecycle.test.ts` reported 5 failures and 49 passes. The expected failures showed four cycles during suspension instead of one, missing mobile suspension, and stale lifecycle admission. Two first-pass event-gate tests timed out because their test gates waited in the wrong order. Corrected those test gates before implementation. Focused RED for awaited mobile recovery reported `resume, scan, flush, replay` instead of `resume`. Focused RED for visibility return during user Pause reported one cycle instead of two. Focused GREEN: `bun run --cwd apps/plugin vitest run test/desktop-sync.test.ts test/lifecycle.test.ts test/desktop-composition.test.ts` passed 3 files and 65 tests. The composition test recovers a pending apply before publication and asserts identical sent request method, path, body, and headers across retry.

Implementation adds a controller-owned host suspension state, guards cycle and event admission, clears timers on suspension, retains unadmitted events in order, shares resume recovery, and fences stale recovery after Pause or close. `main.ts` treats hidden documents as suspended only on mobile and checks suspension after awaited cycle stages. Desktop hidden polling remains 300 seconds. User Pause remains separate. `obsidian-api.ts` exports the existing Obsidian `Platform` capability. No dependency or protocol shape changed.

Documentation scope: changed TypeScript declarations in desktop-sync.ts, main.ts, obsidian-api.ts, desktop-sync.test.ts, desktop-composition.test.ts, lifecycle.test.ts, and test/obsidian.ts. `bun run docs:check` passed. Structural candidates reviewed: desktop-sync.ts owns lifecycle state, queue admission, timers, and recovery in one controller. main.ts owns host detection and composition-stage fences. No separate policy owner or actionable self-review finding remains.

Final `bun run check` passed: lint, docs, four workspace typechecks, 96 test files with 1,833 passed and 1 skipped, and all builds. Worker fault-injection tests printed expected network and SQLite failure diagnostics while their suites passed. No live service or device action ran. Native iPhone/iPad suspension, restart, and scheduling remain unproven. Criterion 4 stays deferred. Criterion 5 stays unchecked. Criteria 1 and 2 stay unchecked pending exact device evidence. Keep OAB-11.5 In Progress.

Branch-review correction, 2026-11-06: the final branch review reported two MAJOR lifecycle defects. I confirmed both against the committed code before the fix. RED: `bun run --cwd apps/plugin vitest run test/desktop-sync.test.ts -t 'latest resume|two batches behind'` failed 2 tests. The two-transition case admitted no retained event after the second resume. The queued-batch case observed `[B.md, A.md]` instead of `[A.md, B.md]`.

Correction: recovery work now records its lifecycle revision. A new resume at a newer revision starts a separate recovery promise instead of sharing an obsolete one. Event drains now have one active owner and keep not-yet-admitted events in the shared FIFO queue. Pause and close checks remain in place.

GREEN: the same focused command passed both regressions. `bun run --cwd apps/plugin vitest run` passed 28 files with 735 tests passed and one skipped. `bun run docs:check` passed. Final `bun run check` passed lint, docs, four typechecks, 96 files with 1,835 passed and one skipped, and all builds. Worker failure-injection diagnostics appeared as expected. No timeout change or Worker edit occurred.

The interrupted protocol runtime isolation test left `.protocol-runtime-isolation-z6HLuY/tsconfig.leaky.json`. Its exact test source creates that directory with `mkdtemp` and removes it in `finally`. I confirmed the directory held that test fixture, removed only that directory, and confirmed it was absent. No tracked or other untracked files changed. Correction evidence is appended to `.superpowers/sdd/mobile-lifecycle-plan/task-1-report.md`. Criterion states and task status stay unchanged.

Independent review closure: task review approved 5288a44. Final whole-branch review found F1 obsolete recovery ownership and F2 reversed deferred batches. Correction dd83738 adds lifecycle-keyed recovery and one shared FIFO drain. Scoped review approved final source revision 341feb501ec1eef32db05e08bb65b05c68a33e25, including the merge from origin/main 86c2259. F1 closes with the held-cycle two-transition regression. F2 closes with the two-batch FIFO regression. The review found no new actionable regression. Documentation scope includes changed TypeScript declarations and lifecycle comments. Structural candidates desktop-sync.ts and main.ts retain controller transition ownership and host composition ownership. The merge preserves upstream mobile labels and conflict-copy notices. Standalone bun run check passed after integration. Earlier unchanged runs failed with timeouts and an interrupted-test scratch fixture. Native device scheduling and restart remain unproven. The owner device script remains: airplane mode, edit a note, force-quit Obsidian, reopen, disable airplane mode. Device trigger: device available and BRAT release plugin-v0.1.0 published. Historical tag context: ai-bridge-v0.1.2 replaced the original tag scheme. Criteria 1 and 2 remain open for device evidence, criterion 4 remains deferred, and criterion 5 remains unchecked.

Human branch review pn-856ca4 approved the complete diff with no requested changes. OAB-11.5 stays In Progress because native device criteria remain open. Publication does not claim mobile acceptance.

Publication validation: merged origin/main 5befa35 without conflicts after human approval. The M5 plugin diff stayed unchanged. Full bun run check passed at e8e7ce6 with 2,085 tests passed, one skipped, lint, documentation checks, typechecks, and builds. Worker build remained dry-run only. No native acceptance claim changed.

Device evidence 2026-11-06 evening, plugin 0.1.3 with PR #80: on the iPhone the owner enabled airplane mode, edited iphone-test-1.md, force-quit Obsidian, reopened it and restored the network. The edit published as revision 6, reached the Mac (cursor 200) and the iPad, with no loss and no conflict copy. This evidences criterion 2 on one device. Criterion 1 and larger transfers remain unobserved on devices.
<!-- SECTION:NOTES:END -->
