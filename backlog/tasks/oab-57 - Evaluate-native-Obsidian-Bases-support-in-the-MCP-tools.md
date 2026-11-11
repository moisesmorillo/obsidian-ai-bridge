---
id: OAB-57
title: Evaluate native Obsidian Bases support in the MCP tools
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-10T03:43:00Z'
updated_date: '2026-11-11T03:29:00Z'
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
- [x] #1 A written evaluation in the task notes covers the official .base format, the spec changes for sync scope and file kinds, and the effect on devices and search
- [x] #2 The evaluation proposes the smallest design that reuses the existing etag, idempotency, scope and path rules, and says if query_base is in or out
- [x] #3 The owner approves or rejects the design, and the approved work becomes subtasks with failing-test-first acceptance criteria
- [x] #4 No code changes before the owner approval
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan: docs/superpowers/plans/2026-11-11-obsidian-bases.md. Await owner approval before product changes or subtask creation. Proposed order: native sync, bounded structural validation, six MCP tools. One branch and pull request. Each subtask needs RED evidence, bun run check, and a fresh task review. Complete branch review and human diff review precede publication.
<!-- SECTION:PLAN:END -->

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

## Native Bases evaluation (2026-11-11)

Official sources: https://help.obsidian.md/bases and https://help.obsidian.md/bases/syntax.
Readable content came from the official obsidianmd/obsidian-help repository after the help pages returned no readable body.

Format: A .base file is YAML configuration, not a database. Known sections are filters, formulas, properties, summaries, and views. Filters are expression strings or recursive and/or/not lists. Views can hold names, types, filters, order, groupBy, summaries, and plugin-specific settings. Markdown frontmatter remains the authority for note properties. File properties also cover attachments. Obsidian supplies expression evaluation and contextual this behavior.

Current blockers: Spec 7.8 excludes .base files. packages/protocol/src/codecs/files.ts recognizes only Markdown and Canvas. Plugin enrollment and protocol manifest/blob validators also need Base support. Worker storage already uses the classifier and indexes Markdown only.

Smallest design: Add base classification without a new persistence kind. Use text through 1,000,000 bytes and existing blob storage above that limit through 25,000,000 bytes. Keep Bases outside full-text search. Add Base-only listing and raw revision-pinned reading, create-only writes, exact-ETag updates, exact-ETag deletes, and structural validation. Reuse current epoch checks, path identity and exclusions, authorization scopes, idempotency receipts, feed, history, admission budgets, and response ownership. No new table, query index, transport, or storage service.

MCP tools: list_bases, read_base, create_base, update_base, delete_base, validate_base. Read and validate use vault:read. Create and update use vault:write. Delete uses vault:delete. Every result carries current epoch. Validate content before Base writes. Bound validation and MCP Base writes to 65,536 UTF-8 bytes. Keep larger file sync and bounded reads. Add yaml as a protocol runtime dependency because Bun-only YAML parsing cannot run in Workers. Reject alias expansion, anchors, custom tags, duplicate keys, multiple documents, depth above 32, and syntax trees above 16,384 nodes.

Compatibility: Preserve raw YAML and unknown plugin settings. Treat expression strings as opaque. Structural validation does not prove expression correctness or Obsidian runtime compatibility. Do not invent a new Bases dialect or assume Kanban availability. For one-view edits, read raw content, preserve other views and settings, then replace with the observed ETag. No separate patch API is necessary. A Base mutation never changes note files.

Devices and plugin: Updated devices enroll .base files and reuse normal text/blob publication, application, and conflict recovery. Old plugins still exclude them, so every device needs an upgrade. No data migration or forced conversion of existing blobs. Test legacy blob reads and history.

Search: Keep Markdown-only FTS and existing search_notes behavior. list_bases supplies prefix-based Base discovery. Existing list_notes retains its Markdown/Canvas selection. Note tools keep their contracts.

query_base is OUT. A Worker clone cannot reproduce Obsidian functions, plugin extensions, links, types, metadata, and display context. Only Obsidian evaluates Bases. Validation never presents a partial engine as compatible.

Proposed implementation subtasks after approval: (1) protocol/storage/plugin sync support, (2) bounded structural validation, (3) six MCP tools and public documentation. Each subtask starts with failing tests, then implementation, bun run check, fresh code review, and commit. One branch and PR. The plan contains all owner decisions and validation limits.

No product code changes precede owner approval. No personal vault or Cloudflare changes. Native Obsidian UI execution remains unproved unless an approved disposable runtime exists. Record a deferred OAB-57 subtask with that runtime as its trigger if necessary.

Design review closure before owner review: (1) fixed in plan with explicit new inline/blob policy, large marker, legacy small-blob exception, and tests. (2) fixed with six-tool scope, admission, owner, and cancellation table. validate_base holds Worker read-slot and envelope ownership without a dummy durable read admission. (3) fixed with incremental yaml@2.8.1 Lexer/Parser bounds before composition, iterative CST checks, and bounded diagnostics. Planning probe accepted a normal view in 23 tokens and refused 20,000-level flow/block inputs after 35/66 tokens without composition or stack errors. This proves the parser seam under Bun, not Worker runtime or Obsidian UI compatibility. No product code changes. Owner approval remains pending.

Owner approved plan in Plannotator pn-761c39 on 2026-11-11. Approval covers all Owner decisions and the three implementation subtasks. No product changes preceded approval.

Final branch review covered 66ff86a..841f020 and requested four corrections: F1 durable settlement loss, F2 malformed known filter siblings, F3 raw parser diagnostics, F4 duplicate list policy. Owner directed all findings fixed in this branch. Worker fixed F1-F4 in cb7c617. Scoped reviewer confirmed each closure. Follow-up comment-only ebeb667 documents completion certainty and received approval. Documentation audit covered protocol schemas/types/codecs, application policy, transport registrations, spec and API guide. Structural candidates remain cohesive after explicit settlement ownership and one list-budget owner. Full bun run check at cb7c617 passed with 2611 tests and one skip. Comment-only checks at ebeb667 passed formatting, docs:check and Worker typecheck. Existing unrelated lint warnings remain. Native UI proof remains intentionally deferred to approved OAB-57.4, not a review finding. Human branch review remains pending.

Formula policy audit 2026-11-11: official Bases syntax at https://help.obsidian.md/bases/syntax and https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md states formula properties are always stored as strings in YAML (repository source checked at commit 24a31567c8a124aaaf95192fa49683bd35305dde). Keep formulas and summaries as z.string(). Add numeric literal rejection coverage. This concerns serialized YAML scalars only and makes no claim about expression evaluation.
<!-- SECTION:NOTES:END -->
