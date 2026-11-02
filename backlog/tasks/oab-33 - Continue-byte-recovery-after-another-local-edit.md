---
id: OAB-33
title: Continue byte recovery after another local edit
status: Deferred
assignee: []
created_date: '2026-11-02T16:17:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/text-apply.ts
type: enhancement
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b accepts the current safe attention stop after another local edit during named byte recovery. Local bytes remain intact and durable recovery identity stays pending. Automatic continuation remains deferred. Trigger: OAB-8.7 recovery controls or repeated-edit evidence during OAB-8.8 qualification. This task covers both the safety stop and continuation. Do not create a separate safety-stop task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A regression stops after a named byte plan, changes local bytes again, and proves safe continuation preserves both observed versions before replacement.
- [ ] #2 Continuation retains existing visible copy identities and verifies pre-apply bytes, stat guards, remote revision authority, and readback before base advancement.
- [ ] #3 Repeated edits, corrupt copies, refused effects, and lifecycle close never cause an unguarded overwrite. Unsafe continuation retains pending work or attention.
<!-- AC:END -->
