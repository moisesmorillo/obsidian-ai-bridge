# Agent rules

Sources of truth: `docs/spec.md` says what the product does; `Backlog.md` says what is in progress and what is deferred. There is no roadmap, no milestone marker, no qualification report. This file is read natively by Claude Code and by pi; there is no `CLAUDE.md`.

Per task: pick a Backlog.md task; write the failing test first; implement; run `bun run check`; run the code-review skill; close the task. Evidence is a passing test, not a document.

Invariants no change may break: every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions.

Never: touch the owner's personal vault; deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation; change git identity; add a dependency without stating why in the task; create demos, labs or parallel plugins. If something cannot be tested in the real code, add a deferred task with a trigger.

Conventions: English in the repo; Conventional Commits; Biome formatting; Zod schemas in `packages/protocol` are the only place protocol shapes are defined. Within the monorepo, use the `@protocol/*`, `@worker/*`, or `@plugin/*` aliases for workspace-local source imports; `@plugin-tools/build` is test/tooling-only. Across workspaces, consume only published package exports such as `@obsidian-ai-bridge/protocol`, never another workspace's private aliases. A negative control that must fail is wrapped so the command exits 0 and records the observed exit code; the assertion runs on that output, so only real failures surface as failed tasks.

Maintainability and documentation rules:
- Keep contracts and public API documentation outside transport handlers; document future API operations separately from their handlers without inventing operations before they exist.
- Keep Zod schemas canonical and derive TypeScript contract types from them.
- Preserve dependency direction: transport may depend on application; application remains independent of platform SDKs; infrastructure sits behind only the small ports actually needed; composition code wires dependencies only.
- Do not create empty layers or one interface per function. A review should ask whether a contract/documentation-only change improperly forces unrelated implementation edits.
- Use repo-relative or `~/` paths in durable documentation and `$HOME` in shell examples; never hardcode an owner's personal home directory.

## Documentation and semantic review

Load the `code-review` skill before reviewing implementation, tests, or executable configuration.
Load its TypeScript profile for TypeScript work.
Review the complete branch before task closure.

Document named semantic declarations with useful TSDoc.
Include internal functions, named function bindings, methods, classes, interfaces, types, schemas, and meaningful constants.
Document constructors when they create resources, change state, validate persistence, or can fail.

Explain authority, invariants, units, effects, nullability, and failure behavior where these details matter.
Do not accept comments that only repeat declaration names.
Check comment truth against implementation, callers, tests, and the current contract.

The mechanical gate checks named declarations in tracked and non-ignored new TypeScript files.
It also checks tooling, configuration, and named test helpers.
Its sole generated-file exemption is `apps/worker/src/infrastructure/sqlite/schema.generated.ts`.

Imports, re-exports, anonymous callbacks, ordinary local variables, trivial literals, and obvious fields need no mechanical comment.
Field semantics and implementation-specific effects still need manual review.
Visibility and small size do not exempt a semantic contract.

Run `bun run docs:check` during correction and `bun run check` before closure.
A green parser checks syntax and comment presence, not semantic truth.
Do not treat green automation as a substitute for the review skill.

Use `some` for existence, `find` for a matching item, `filter` for selection, and `map` for transformation.
Keep loops for ordered effects, retries, and clear early exits.
Do not use `map` for discarded effects or `forEach(async ...)` when settlement order matters.

Prefer clear guards for independent preconditions.
Do not replace readable conditionals solely to reduce branch counts.
Use exhaustive handling when it makes a closed state policy easier to audit.

Record the reviewed revision, documentation scope, structural candidates, validation results, and limits.
Give each actionable finding an explicit evidence-based closure entry.
Do not close a finding solely because nearby tests pass.

Root `@tooling/*` imports serve development tooling only.
Production source must not import root tooling or its Node and parser dependencies.

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
