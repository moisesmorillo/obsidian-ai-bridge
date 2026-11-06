---
id: OAB-11.4
title: 'Deferred: verify mobile enrollment and credential storage'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T23:20:00Z'
updated_date: '2026-11-06T17:38:00Z'
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
<!-- SECTION:NOTES:END -->
