---
id: OAB-37
title: Prove AC-30 on a fresh desktop fixture
status: Deferred
assignee: []
created_date: '2026-11-04T18:03:00Z'
updated_date: '2026-11-04T18:51:00Z'
labels:
  - deferred
dependencies: []
references:
  - OAB-8.8
  - apps/plugin/tools/desktop-acceptance.ts
  - apps/plugin/test/desktop-acceptance.test.ts
documentation:
  - docs/spec.md
priority: medium
type: task
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three OAB-8.8 live tries did not complete AC-30. Suffix 04 collided locally. Suffix 05 stopped at a combined successor assertion.

Suffix 06 stopped at AC30_ASSERT_FINAL_CALL_COUNT: expected 3, observed 2. Individual call identities, statuses, and assertion-time queue data were not retained. Commit edc181e adds passing local characterization and does not reproduce the failure.

A later diagnostic-pair correction does not explain the historical missing third call. Trigger: A local regression explains that missing call and supports a reviewed tooling correction. The owner must authorize fresh disposable-vault credentials and a live fixture.

The current dev-2 client is revoked. Do not reuse historical fixture paths or infer further live authority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One authorized desktop run proves immutable retry identity and bytes, plus a distinct successor with the confirmed precondition.
- [ ] #2 Safe observations identify call counts, revisions, receipt equalities, and queue state for each final condition.
- [ ] #3 The device and service retain the intended content and restored methods, or record the exact failed condition.
- [ ] #4 No personal vault or protected historical fixture changes.
<!-- AC:END -->
