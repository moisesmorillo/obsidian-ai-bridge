---
id: OAB-11.4
title: 'Deferred: verify mobile enrollment and credential storage'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T23:20:00Z'
updated_date: '2026-11-06T21:40:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: F4 closes and the owner approves the F5 copy-vault scope with an isolated service authority. Mobile browser return and credential persistence lack device evidence. Scope covers iPhone, iPad, and an Android compatibility probe. No mobile support claim follows from API types alone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Native browser consent returns through the registered URI on iPhone and iPad without direct callback injection.
- [ ] #2 State mismatch, replay, expiry, wrong-vault return, and process loss reject safely and allow a fresh connection.
- [ ] #3 Per-platform records show app and OS versions, capability presence, write verification, restart persistence, and the fallback warning without secret values.
- [ ] #4 Android availability and persistence results remain distinct from the Apple F5 exit evidence.
- [ ] #5 Device labels remain distinct after settings sync without copying journal IDs or credentials between devices.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan review: /private/tmp/M4D-mobile-authorization-plan.md. Add failing tests first. Return the prepared URL with live consent fences. Render a direct authorization control and fixed safe failures. Guard automatic launch. Use Platform.isMobile for text only. Bump plugin to 0.1.1. Run bun run check, task and branch reviews, human branch review, and publish one PR. Keep device criteria open.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Promoted at F4 closure, 2026-11-06. DRAFT-4 still needs isolated service authority from the owner. DRAFT-5 still needs the BRAT release plugin-v0.1.0 and devices.

Owner authorization, 2026-11-06: F5 copy-vault code work through the supervisor. M4D limits this branch to criterion 1 launch and visible failure. The owner observed no browser or error after Connect on iPhone with plugin-v0.1.0. The likely cause is browser launch after asynchronous preparation, plus a silent settings catch. No personal vault, live service case, or Cloudflare action is allowed. Device criteria stay unchecked. Only the owner device run can prove the native fix.

Supervisor device observation, 2026-11-06: after Connect, the owner iPhone shows Status: connecting and Sync status: disconnected, without a browser. Discovery and registration succeeded. This narrows the cause to browser launch after the asynchronous gap. The scope remains launch and visible failure only.

M4D implementation: prepared consent URL stays in memory and getAuthorizationUrl checks the current generation and expiry. Automatic browser launch errors do not clear consent. Settings show a native Open authorization page link, fixed safe preparation errors, and platform-specific instructions. Fake tests prove URL retention, callback completion removal, link attributes, and safe UI messages. Supervisor observation remains: iPhone showed Status: connecting and Sync status: disconnected after Connect, while discovery and registration succeeded. Device acceptance criteria remain unchecked and task stays In Progress. Local fakes do not prove iPhone or iPad browser launch or URI return.

Review correction test-first record: the prior M4D focused test command passed instead of producing RED, and production edits were already underway. This is the repository test-first exception. In this correction, the RED command was: bun run --cwd apps/plugin test -- settings.test.ts; result=$?; echo OBSERVED_RED_EXIT=$result; test $result -ne 0. It exited 1 because tests found obsolete cancellation instructions and a missing pending link after settings rerender. The GREEN focused command was: bun run --cwd apps/plugin test -- settings.test.ts device-session.test.ts. It passed 37 tests.

Review finding closure: settings tests store and invoke anchor click handlers. A live URL preserves browser default behavior. Cancellation and replacement prevent default. The expired session getter rejects the URL, and the settings link rejects it at the click boundary. A fake-clock test covers session expiry. Separate discovery and registration transport failures return one fixed safe error. Settings refresh clears obsolete instructions after cancellation, callback completion, and expiry. A rerender shows one pending link. Desktop fallback text and exclusion of the consent URL from settings data are covered.

Final review fix: settings gives each rendered view and Connect action a generation. Async success, error, and button restoration act only while the view, action, and session still match. A deferred-promise regression reproduced an old action rejection after a rerender and newer successful authorization. RED showed the old error replacing current instructions. The generation fence preserves the newer message and its expiry cleanup. The action-race finding is closed. OAB-11.4 stays In Progress and device criteria stay unchecked.

Final branch-review finding closed: added a deferred connection test that starts action A, rerenders settings, completes action B with new consent, then rejects A. Before the fix, A replaced B instructions with a safe error. Settings now fence success, error, and finally UI updates using the current view generation, Connect-action generation, and session identity. After correction, the current consent text remains and refresh clears it when consent ends. RED command was bun run --cwd apps/plugin test -- settings.test.ts; result=$?; echo OBSERVED_RED_EXIT=$result; test $result -ne 0 and produced one failing race regression test. GREEN command bun run --cwd apps/plugin test -- settings.test.ts passed 11 tests. Final bun run check passed with 722 plugin tests passed and 1 skipped. Task remains In Progress. Device criteria remain unchecked.

Delivery review, 2026-11-06: reviewed product revision e12b49c00ed7b26817f34ae39f71c35765e3b646. Independent task review approved the corrections. Whole-branch review found one UI action race, and the scoped final review approved its regression test and fence. Documentation review covered changed TypeScript declarations and tests. DeviceSession owns consent generation and expiry. Settings owns presentation and direct link navigation. Both remain cohesive. Worker validation passed bun run docs:check and bun run check. Owner approved plan pn-9acf4e and branch diff pn-d04fcd without changes. Native iPhone and iPad launch and callback remain unproven. The supervisor creates plugin-v0.1.1 only after merge.

Device evidence 2026-11-06: with plugin 0.1.2 on a real iPhone, Connect prepared the consent, the owner tapped Open authorization page, Safari completed the Access PIN and consent, and the obsidian callback returned the device to connected status. Credentials survived app use through the day. iPad and Android remain untested. Criterion 1 stays unchecked until the iPad run.
<!-- SECTION:NOTES:END -->
