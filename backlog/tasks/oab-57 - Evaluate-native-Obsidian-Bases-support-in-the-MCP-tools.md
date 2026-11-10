---
id: OAB-57
title: Evaluate native Obsidian Bases support in the MCP tools
status: To Do
assignee: []
created_date: '2026-11-10T03:43:00Z'
updated_date: '2026-11-10T03:44:00Z'
labels: []
dependencies: []
references:
  - https://help.obsidian.md/bases
  - https://help.obsidian.md/bases/syntax
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A ChatGPT user case asks for Obsidian Bases (.base files) as MCP resources: list, read, create, update, delete, validate and maybe query. Supervisor check on 2026-11-09 found two blockers. Spec 7.8 sync scope includes only **/*.md, **/*.canvas and listed attachments, so a .base file never syncs to devices. The protocol codec (packages/protocol/src/codecs/files.ts) classifies only markdown and canvas, and the MCP tools are note-only. query_base would need a copy of the Obsidian filter and formula engine, which is a large risk of false compatibility. The original request text is in the task notes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A written evaluation in the task notes covers the official .base format, the spec changes for sync scope and file kinds, and the effect on devices and search
- [ ] #2 The evaluation proposes the smallest design that reuses the existing etag, idempotency, scope and path rules, and says if query_base is in or out
- [ ] #3 The owner approves or rejects the design, and the approved work becomes subtasks with failing-test-first acceptance criteria
- [ ] #4 No code changes before the owner approval
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Original request (ChatGPT user case, 2026-11-09, summary)

- Tools: list_bases, read_base, create_base, update_base (etag), delete_base (safeguards), validate_base, query_base (only if feasible, and say if Vaultwire or Obsidian evaluates it).
- Raw .base content and structured operations: multiple views, filters, visible properties, sort, group, change one view without replacing unrelated configuration.
- Safety: epoch and etag concurrency, atomic writes, path validation, idempotency, no silent overwrite, existing scopes, explicit delete safeguards. A Base never changes the underlying notes.
- Compatibility: native .base format, YAML frontmatter properties, current search, MCP tool discovery. No parallel database or own format. Do not invent Bases syntax or assume a Kanban view.
- Tests: CRUD, valid and invalid configs, multiple views, stale etag, missing and duplicate files, path traversal, unrelated config kept, Unicode and nested paths, note tools unchanged. Integration case: a Base over Freelance/Career Ops/Opportunities/ filtered by pipeline, status, priority, applied and archived.
- Docs: tool catalog, schemas, example .base files, limits against the Obsidian engine, concurrency and authorization.
- Acceptance: discover, create, read and validate, change one view safely, detect conflicts, open in Obsidian without errors, notes unchanged.
<!-- SECTION:NOTES:END -->
