---
id: OAB-10.5
title: Show safe failure classes and service measurement limits in the status panel
status: Done
assignee: []
created_date: '2026-11-05T20:57:00Z'
updated_date: '2026-11-05T22:06:00Z'
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
- [x] #1 Sync failure and panel show bounded transport classes, canonical codes, retry seconds, and UTC last failure and success times without private error values.
- [x] #2 Service measurements appear only through an existing authorized read path without new secrets. Otherwise task notes state the limit and the panel omits the section.
- [x] #3 Real controller and panel tests cover safe failure projection, recovery, and private value exclusion. bun run check and task and branch reviews pass.
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

Owner decision after branch review: extend P2 write scope to oauth-transport.ts, oauth-transport.test.ts, and a composed real DeviceSession regression test. Add only a bounded network failure marker at the host boundary. Keep endpoints, credential values, and authentication policy unchanged. Branch findings: Resume catches erase diagnostic metadata. A session rejection does not prove network failure. Both need regression tests and correction before publication.

BRANCH REVIEW FIX RED: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/lifecycle.test.ts test/startup-cycle.test.ts test/sync-transport.test.ts test/oauth-transport.test.ts test/device-session.test.ts` failed as expected. Resume and device-name reconfiguration both lost `admission_limited` and retry `30`. A real DeviceSession credential-persistence failure was incorrectly marked `SyncNetworkError`. A rejected requestUrl call had only generic OAuth failure text.
BRANCH REVIEW FIX GREEN: `bun run --filter @obsidian-ai-bridge/plugin test -- --run test/lifecycle.test.ts test/startup-cycle.test.ts test/sync-transport.test.ts test/oauth-transport.test.ts test/device-session.test.ts test/status-panel.test.ts` passed 108 tests in 6 files.
FINDING CLOSURE — Resume classification: both `resumeSync` and `resumeControllerIfOwned` pass caught errors to `reportSyncFailure`. Real plugin/controller tests exercise Resume and device-name reconfiguration, then inspect final status after all catches settle. Both retain 4xx, `admission_limited`, and retry value 30.
FINDING CLOSURE — Network provenance: `ObsidianOAuthTransport` creates `DeviceSessionNetworkError` only when the host `requestUrl` call rejects. `DeviceSession` preserves that marker across refresh handling. `SyncTransport` no longer maps all session rejections to network. A composed real DeviceSession test proves credential persistence failure makes no protected request and does not become network. OAuth boundary and plugin/controller tests prove safe network classification without private host detail.
FIX CHECKS: `bun run docs:check` passed. `bun run check` passed with exit code 0, including lint, docs, all workspace type checks, tests, and builds.

Owner decision: production auth/device-session.ts also joins P2 scope. Keep its bounded network marker and refresh-error propagation. Authentication status behavior stays unchanged. Corrective scope confirmation follows commit ba7cbf9 and precedes acceptance.

Reviews: task compliance approved at abbc234. Whole-branch review found two major diagnostic defects. Corrective review at ba7cbf9 confirms both addressed with direct regression evidence and no new fix-wave defect. Documentation scope includes all changed declarations, tests, panel copy, and this task. Structural candidates main.ts, sync-transport.ts, and OAuth/session boundaries retain explicit diagnostic ownership. No hosted CI or live-vault evidence is claimed. Active diagnostics probe returned auxiliary AST findings in existing code. Semantic review found no new defect from those findings.

Final acceptance: human branch review pn-56b1a4 approved without changes. Reviewed implementation ba7cbf9 maps to 45f22c7 after rebase onto b5210f5. Parent bun run check passed on rebased c5c03dc with exit 0, including lint, documentation, types, workspace tests, and dry-run builds. Both major branch findings have explicit regression-backed closures and corrective approval. No actionable finding remains. Service measurements remain absent because device tokens lack owner Access authority. Session-only timestamps are not persisted. No vault or Obsidian window action occurred.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added bounded sync failure classes, canonical codes, retry seconds, and session-only UTC failure and success times. Real controller, session, transport, and panel tests cover privacy, recovery, Resume, reconfiguration, and credential failure provenance. Project checks, independent reviews, and human diff review passed. Device credentials cannot read owner measurements, so the panel omits that section. No live-vault evidence is claimed.
<!-- SECTION:FINAL_SUMMARY:END -->
