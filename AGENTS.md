# Agent rules

Sources of truth: `docs/spec.md` says what the product does; `Backlog.md` says what is in progress and what is deferred. There is no roadmap, no milestone marker, no qualification report. This file is read natively by Claude Code and by pi; there is no `CLAUDE.md`.

Per task: pick a Backlog.md task; write the failing test first; implement; run `bun run check`; run the code-review skill; close the task. Evidence is a passing test, not a document.

Invariants no change may break: every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions.

Never: touch the owner's personal vault; deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation; change git identity; add a dependency without stating why in the task; create demos, labs or parallel plugins. If something cannot be tested in the real code, add a deferred task with a trigger.

Conventions: English in the repo; Conventional Commits; Biome formatting; Zod schemas in `packages/protocol` are the only place protocol shapes are defined.

Maintainability and documentation rules:
- Keep contracts and public API documentation outside transport handlers; document future API operations separately from their handlers without inventing operations before they exist.
- Keep Zod schemas canonical and derive TypeScript contract types from them.
- Preserve dependency direction: transport may depend on application; application remains independent of platform SDKs; infrastructure sits behind only the small ports actually needed; composition code wires dependencies only.
- Do not create empty layers or one interface per function. A review should ask whether a contract/documentation-only change improperly forces unrelated implementation edits.
- Use repo-relative or `~/` paths in durable documentation and `$HOME` in shell examples; never hardcode an owner's personal home directory.

History: this repository was restarted from scratch on 2026-10-11. Any agent memory, note or document dated before that describes the legacy codebase and does not apply.

Human review: when the `plannotator` tool is available (Pi), open the plan file with it (`annotate`) right after writing a plan and wait for the feedback message before implementing; before finishing a branch, open a `review` of the branch diff against `main` and address every annotation before the pull request. Without the tool, present the plan and the diff in the conversation instead.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
