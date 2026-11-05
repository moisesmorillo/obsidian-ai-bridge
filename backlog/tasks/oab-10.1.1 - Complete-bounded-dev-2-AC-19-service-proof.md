---
id: OAB-10.1.1
title: Complete bounded dev-2 AC-19 service proof
status: Deferred
assignee: []
created_date: '2026-11-05T16:52:00Z'
labels:
  - deferred
  - F4
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-10.1
ordinal: 60000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: OAB-10.1 merges and the exact-vault Obsidian CLI can return a safe result for the dev-2 service case. The supervisor accepted this external evidence limit for the OAB-10.1 PR on 2026-11-05. Dev-1 capture and reload passed. The bounded dev-2 diagnostic ended at the CLI boundary, with no eval exit record and empty stderr, although a guarded trivial eval passed. Do not repeat the current live case before this trigger. Preserve all historical work and existing synthetic service evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Record the exact CLI exit status or spawn error, bounded secret-safe stderr, and a guarded dev-2 trivial eval result.
- [ ] #2 Use one fresh oab-10.1 fixture in the exact authorized dev-2 vault. Preserve historical queue, apply, and attention identities with baseline-relative assertions.
- [ ] #3 Confirm one new durable confirmation, placeholder exclusion, and no delete or rename commit for the fixture path. Pause dev-2 after the bounded case.
- [ ] #4 Keep dev-1 paused. Do not resume, reset, clear, or publish its historical work. Record that its live proof covers capture and reload only.
- [ ] #5 Update OAB-10.1 criterion 6 and OAB-10 gate notes with actual results and remaining limits. Claim no real iCloud eviction proof.
<!-- AC:END -->
