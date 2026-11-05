---
id: OAB-10.5
title: Show safe failure classes and service measurement limits in the status panel
status: In Progress
assignee: []
created_date: '2026-11-05T20:57:00Z'
updated_date: '2026-11-05T21:17:00Z'
labels: []
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F4 trial could not distinguish admission limits from network or credential failures. OAB-10.2 leaves plugin measurement display open.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Sync failure and panel show bounded transport classes, canonical codes, retry seconds, and UTC last failure and success times without private error values.
- [ ] #2 Service measurements appear only through an existing authorized read path without new secrets. Otherwise task notes state the limit and the panel omits the section.
- [ ] #3 Real controller and panel tests cover safe failure projection, recovery, and private value exclusion. bun run check and task and branch reviews pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow the reviewed P2-plan.md. Add failing real controller, transport, projection, and panel tests. Project bounded failures and session UTC cycle times. Omit service measurements because device tokens cannot read the Access-protected owner route. Run bun run docs:check and bun run check. Complete task review, whole-branch review, Plannotator branch review, and one pull request.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief authorizes parallel P2 execution despite gate dependency order. Write scope covers status-panel.ts, sync-status.ts, sync-transport.ts, status wiring in main.ts, their tests, and this task. No personal vault or live service access. Measurement limit: /owner/measurements verifies Cloudflare Access authority. Device credentials do not grant that authority. The panel omits Service measurements and adds no endpoint or secret.

RED: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/sync-status.test.ts test/status-panel.test.ts test/sync-transport.test.ts` failed as expected. Assertions showed missing UTC timestamps, unvalidated metadata, panel metadata rendered as [object Object], and raw transport rejection leakage.

RED: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/sync-status.test.ts test/status-panel.test.ts test/sync-transport.test.ts` failed on missing UTC times, raw metadata, unrendered diagnostics, and leaked transport rejection text. The tests failed on the expected new behavior.
RED: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/sync-transport.test.ts test/startup-cycle.test.ts` exposed a second failure. `runSyncAction` replaced the original error with a generic classification after `DesktopSyncController` reported it.
GREEN: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/sync-status.test.ts test/status-panel.test.ts test/sync-transport.test.ts test/startup-cycle.test.ts test/lifecycle.test.ts` passed 84 tests. The assertions cover 429 admission_limited, 401 revoked and unauthorized, 5xx, network rejection redaction, arbitrary application errors, malformed metadata, recovery, retained UTC times, and an incomplete capture-blocked cycle.
Documentation: `bun run docs:check` passed.

RED: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/sync-transport.test.ts test/startup-cycle.test.ts` first showed the plugin cycle replaced the validated 429 diagnostic with `other` in the `runSyncAction` rejection handler. The handler now passes the caught error to projection.
GREEN: The focused suite passed 84 tests across 5 files. The 429 test uses a real `AIBridgePlugin`, `DesktopSyncController`, and `SyncTransport` with controlled host responses. The lifecycle test checks an arbitrary application failure and an incomplete capture-blocked cycle. The panel test renders the actual `SyncStatusPanel`.
FULL CHECK: `bun run check` exited 0. Biome passed for 263 files. Documentation passed. All four workspace type checks passed. Tooling tests passed 91, protocol tests passed 307, plugin tests passed 612 with 1 skipped, and worker suites passed 122, 115, and 688 tests. Protocol, plugin, and worker builds passed. Worker tests printed controlled uncaught-exception diagnostics, but all test commands exited 0.
<!-- SECTION:NOTES:END -->
