---
id: DRAFT-3
title: 'Deferred: verify iOS placeholder safety in copy vaults'
status: Draft
assignee: []
created_date: '2026-11-05T23:21:00Z'
labels:
  - F5
  - Deferred
dependencies: []
parent_task_id: OAB-11
type: task
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Trigger: the owner approves isolated iCloud copy-vault tests after F4. Current detection recognizes two .icloud filename forms only. iOS File Provider event and metadata behavior remain unknown. No personal-vault or shared-service fixture action is authorized.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Records show native iOS and iPadOS eviction, hydration, metadata, and event order without source content.
- [ ] #2 Unavailable files publish no delete or rename without the existing exact-revision confirmation contract.
- [ ] #3 Fixtures cover filename placeholders, absent files without placeholders, read failures, hydration races, and restart.
- [ ] #4 Any native behavior outside current detection has a failing test before a scoped correction.
- [ ] #5 Mobile coexistence policy is explicit before any real-vault proposal.
<!-- AC:END -->
