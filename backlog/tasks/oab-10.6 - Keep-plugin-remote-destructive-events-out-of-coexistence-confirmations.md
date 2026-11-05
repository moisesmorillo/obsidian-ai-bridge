---
id: OAB-10.6
title: Keep plugin remote destructive events out of coexistence confirmations
status: Deferred
assignee: []
created_date: '2026-11-05T22:05:00Z'
labels: []
dependencies: []
parent_task_id: OAB-10
type: bug
ordinal: 61000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Relayed observation, not independently verified: at origin/main b5210f5, cursor 180, on 2026-11-05 about 22:05Z, a plugin remote-tombstone apply trashed `oab-10.1/dev-2/simulated-eviction-p1-20261105-01.md`. Its delete event entered the coexistence confirmation queue and blocked sync. Trigger: the next F4 coexistence correction after OAB-8.7.1 merges. Keep this task deferred until that correction.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Proved plugin remote delete and rename applies do not create owner confirmations.
- [ ] #2 Genuine user destructive edits, including concurrent same-path edits, still capture before debounce with exact authority.
- [ ] #3 Replay and restart preserve queues, with no suppression leaks.
- [ ] #4 Failing controller integration regressions cover these cases, and bun run check passes.
<!-- AC:END -->
