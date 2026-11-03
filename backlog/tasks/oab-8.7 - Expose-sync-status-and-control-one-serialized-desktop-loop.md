---
id: OAB-8.7
title: Expose sync status and control one serialized desktop loop
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-11-03T00:01:00Z'
labels: []
dependencies:
  - OAB-8.6
  - OAB-8.9
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the complete synchronizer usable from Obsidian without falsely claiming settled state. One focused PR. decision-1 adds the device revocation obligation. Owner-interactive proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One serialized loop uses 15, 60, and 300 second polling, two-second event debounce, immediate load/resume/Sync now, and at most four network requests.
- [ ] #2 Status panel shows section 7.9 states and per-path reasons with labelled keyboard controls. Settled needs empty queues, confirmed cursor/head equality, and persisted state.
- [ ] #3 AC-08 device tests show revoked, stop publishing and applying, preserve files and queued work, and offer Reconnect. Pause preserves queues and stops effects.
- [ ] #4 Panel reports unsupported files, storage failures, operation failures, and server backup/capacity state without treating absent telemetry as success. Unload releases host resources.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Approved plan: .pi/plans/oab-8.7-desktop-loop.md. One worker implements the serialized lifecycle controller and truthful status panel. Preserve shared effect owners and exact revision authority. Run RED/GREEN tests, docs:check, and bun run check. Independent task review, whole-branch review, and owner branch review precede publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision 2026-11-02: close the OAB-8.9 journal successor fix before the status panel. OAB-8.9 is now a direct dependency so the launcher takes it first.

Owner approved plan pn-b379a1. Retain Rebuild local index only through full spec 7.3 reconciliation: absence never deletes and dirty paths receive conflict copies. Add one Deferred backup telemetry task with F3b export delivery as its trigger. Baseline bun run check passed exit 0 at 83f6048. No live service or vault access.

Added lifecycle and status tests before implementation. Source checks first found missing controller and status modules, but the focused test runner did not record a behavioral red before implementation. Focused tests passed: 33 plugin tests. bun run docs:check passed. bun run check passed with 93 test files and 1607 tests. Self-review confirmed one lifecycle queue, shared apply engine, validated revocation classification, full manifest rebuild, and unknown backup telemetry. Real service and vault checks remain reserved for OAB-8.8. Unsupported and excluded path lists render only on request.
<!-- SECTION:NOTES:END -->
