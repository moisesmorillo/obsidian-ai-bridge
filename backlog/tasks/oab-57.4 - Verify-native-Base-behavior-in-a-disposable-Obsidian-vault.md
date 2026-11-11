---
id: OAB-57.4
title: Verify native Base behavior in a disposable Obsidian vault
status: Done
assignee: []
created_date: '2026-11-11T02:37:00Z'
updated_date: '2026-11-11T11:42:00Z'
labels: []
dependencies: []
references:
  - docs/superpowers/plans/2026-11-11-obsidian-bases.md
documentation:
  - docs/spec.md
parent_task_id: OAB-57
type: task
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository tests prove YAML structure and raw-text preservation, but no approved Obsidian runtime can prove UI behavior. Trigger: an owner-approved disposable Obsidian vault and runtime become available. Keep all work inside that disposable vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Open representative Bases in the Obsidian UI and record the tested Obsidian version.
- [x] #2 Change one view and verify comments, unknown settings, other views, and note properties remain unchanged.
- [x] #3 Record UI findings without accessing a personal vault or changing Cloudflare resources.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner scope change 2026-11-11: run the check in the real vault inside a dedicated, deletable folder (_vaultwire-bases-test/) instead of a disposable vault. AC #3 is satisfied under that exception: no other vault path was read or changed, and no Cloudflare resource changed.

Run 2026-11-11 on the Mac: Obsidian 1.15.0, plugin 1.1.0, Worker 1.1.0.
- Created 3 notes with properties and Proyectos.base (comment, unknown top-level setting x-vaultwire-unknown with inline comment, table and cards views). Cursor 902 to 906, no pending ops, no conflict copies.
- MCP list_bases and read_base returned the Base byte-identical. validate_base accepted it and rejected a view without type.
- MCP update_base changed only the table sort (ASC to DESC) at ETag .1. The Mac received it byte-identical. Comment, unknown setting, cards view and all three note hashes stayed unchanged.
- Stale ETag returned precondition_failed. update_note and delete_note on the .base path returned invalid_request.
- Obsidian UI opened the file as view type bases: Tabla, 3 results, order Beta (3), Gamma (2), Alfa (1). Opening the view did not rewrite the file.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Verified Bases sync, MCP tools and Obsidian 1.15.0 rendering in a deletable folder of the real vault.
<!-- SECTION:FINAL_SUMMARY:END -->
