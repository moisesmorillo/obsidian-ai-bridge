---
id: OAB-62
title: >-
  Stream generic JSON read responses through a writer pump that observes client
  cancellation
status: To Do
assignee:
  - '@claude'
created_date: '2026-11-10T21:32:00Z'
labels: []
dependencies:
  - OAB-61
priority: high
type: bug
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-61 found that generic JSON read responses (feed, manifest, history, search, vault, content JSON, MCP) are JavaScript byte streams whose cancel callback the Workers runtime never calls when the client cancels across the runtime boundary. The REST read lease and its 4.5 MB reservation then stay held until the OAB-58 reclaim (about 120 s), so a few cancelled reads fill the REST pool. Fixed-length blob responses do not have this defect because their pump writes into a FixedLengthStream and sees the failed write. A quick IdentityTransformStream wrap made the cancel test pass but broke 22 existing ownership tests, so the fix needs a deliberate redesign of read-response ownership. The owner wants this fixed now, not deferred.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A regression first shows that cancelling a JSON feed page after its first chunk keeps held_rest_slots and rest_read_bytes above 0, and the fix then returns both to 0 promptly.
- [ ] #2 JSON read bodies keep OAB-58 semantics: lease expiry errors the body and never closes it cleanly, and capacity is released once.
- [ ] #3 Output bytes, chunk coalescing, one-batch-at-a-time demand, and the existing ownership tests keep passing, or each changed test records why its old expectation was wrong.
- [ ] #4 MCP JSON responses get the same cancellation behaviour, with a test.
- [ ] #5 Spec §6.5 removes the known limit, and bun run check, task review, and branch review pass before the pull request.
<!-- AC:END -->
