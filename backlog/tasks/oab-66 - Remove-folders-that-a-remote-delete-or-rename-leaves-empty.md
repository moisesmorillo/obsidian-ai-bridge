---
id: OAB-66
title: Remove folders that a remote delete or rename leaves empty
status: Done
assignee: []
created_date: '2026-11-11T15:31:00Z'
updated_date: '2026-11-11T15:39:00Z'
labels: []
dependencies: []
priority: medium
type: bug
ordinal: 109000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner report 2026-11-11 (iPad screenshot): after a remote delete, the files go away but their folders stay (_vaultwire-bases-test, _vaultwire-loadtest/large, small, uploads). Folders have no sync identity, so the receiving plugin never removes them. Fix: after a remote delete or rename settles, remove each ancestor folder of the vacated path while it is empty on disk. Stop at the first folder with any entry, at the vault root, and at paths outside the Obsidian index. Best effort: a failure never changes the durable journal.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 After a remote delete settles, empty ancestor folders of the deleted path are removed up to the first non-empty folder
- [x] #2 After a remote rename settles, empty ancestor folders of the source path are removed
- [x] #3 A folder that holds any file or subfolder on disk, including hidden entries, is never removed
- [x] #4 No folder is removed while the apply is still pending or became a conflict
- [x] #5 A pruning failure does not fail the apply or change the journal
- [x] #6 bun run check passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: 5 engine and adapter tests failed before the implementation (pruneEmptyParents missing, no prune after delete or rename). Independent review found one MAJOR: echoes of this device's own delete or rename would remove folders the user kept. Fix: prune only when the vacated path existed before the apply, pending_apply is empty, and the path is absent after. Negative control: the own-delete echo, own-rename echo and absent-file tombstone tests fail when presentBefore is forced true. Re-review: all findings closed.
Known limits, harmless (only leave an empty folder or remove an empty one non-recursively): a crash after trash but before journal settle skips pruning on resume; a local delete of the same file during an unrelated remote apply can prune its empty parent.
Design effect: folders have no sync identity. A sender that deletes only the last file keeps its folder, while receivers remove it.
Existing empty folders on devices from earlier deletes are not cleaned; the owner removes them by hand.
Check: tooling 108, protocol 343, plugin 921+1 skipped, worker 883/138/162.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Receiving devices now remove folders that a remote delete or rename emptied, never on echoes of their own changes.
<!-- SECTION:FINAL_SUMMARY:END -->
