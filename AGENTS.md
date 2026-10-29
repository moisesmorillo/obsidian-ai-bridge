# Agent rules

Sources of truth: `docs/spec.md` says what the product does; `Backlog.md` says what is in progress and what is deferred. There is no roadmap, no milestone marker, no qualification report. This file is read natively by Claude Code and by pi; there is no `CLAUDE.md`.

Per task: pick a Backlog.md task; write the failing test first; implement; run `bun run check`; run the code-review skill; close the task. Evidence is a passing test, not a document. If an implementation arrives green without an earlier failing test, keep it. Add the missing test and record the exception in the task notes. Do not delete and rebuild. Do not commit evidence, progress, or review-record documents; a passing test and the pull request are the record.

Invariants no change may break: every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions.

Never: touch the owner's personal vault; deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation; change git identity; add a dependency without stating why in the task; create demos, labs or parallel plugins. If something cannot be tested in the real code, add a deferred task with a trigger.

Conventions: English in the repo; Conventional Commits; Biome formatting; Zod schemas in `packages/protocol` are the only place protocol shapes are defined. Within the monorepo, use the `@protocol/*`, `@worker/*`, or `@plugin/*` aliases for workspace-local source imports; `@plugin-tools/build` is test/tooling-only. Across workspaces, consume only published package exports such as `@obsidian-ai-bridge/protocol`, never another workspace's private aliases. A negative control that must fail is wrapped so the command exits 0 and records the observed exit code; the assertion runs on that output, so only real failures surface as failed tasks.

Maintainability and documentation rules:
- Keep contracts and public API documentation outside transport handlers; document future API operations separately from their handlers without inventing operations before they exist.
- Keep Zod schemas canonical and derive TypeScript contract types from them.
- Preserve dependency direction: transport may depend on application; application remains independent of platform SDKs; infrastructure sits behind only the small ports actually needed; composition code wires dependencies only.
- Do not create empty layers or one interface per function. A review should ask whether a contract/documentation-only change improperly forces unrelated implementation edits.
- Use repo-relative or `~/` paths in durable documentation and `$HOME` in shell examples; never hardcode an owner's personal home directory.

## Session start

Run `backlog instructions overview`. Find the gate task with status In Progress. Run `backlog task list --plain --ready -p <gate>` and take the first subtask. Read the gate task notes. They hold the standing authorizations for the phase. Read the notes of the previous subtask. Read the spec sections and the acceptance cases that the subtask names. Update `main` before you create the worktree.

Create the worktree with the harness command when one exists: `orca worktree create` inside Orca, `herdr worktree create` inside Herdr, `git worktree add` elsewhere. Set the subtask In Progress with the CLI. Write one plan and open it for review. Implement after the approval. Open the branch review, open the pull request, remove the worktree, report, and stop. The owner merges. A kickoff of one line is enough: "Pick the next ready subtask of the In Progress gate and do it."

Inside Orca, the built-in browser automates OAuth consent against the deployed service. Load the `harness-browser` skill. Owner-manual steps are the Access PIN login and the ChatGPT account.

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

Root `@tooling/*` imports serve the private development tooling workspace only.
Other workspaces consume its public `@obsidian-ai-bridge/tooling/vite-aliases` export through development dependencies.
Production source must not import tooling or its Node and parser dependencies.

History: this repository was restarted from scratch on 2026-10-11. Any agent memory, note or document dated before that describes the legacy codebase and does not apply.

Human review: when the `plannotator` tool is available (Pi), open the plan file with it (`annotate`) right after writing a plan and wait for the feedback message before implementing; before finishing a branch, open a `review` of the branch diff against `main` and address every annotation before the pull request. Without the tool, present the plan and the diff in the conversation instead. Open one review per plan and one per branch, not one per task. Batch open decisions into one `ask_user_question` per plan.

## Subagent execution

Use subagents to complete approved tasks, not individual edits. Give each implementer a clear scope, contracts, and acceptance criteria.

Implementers own their edits, debugging, RED/GREEN cycles, and task validation, including `bun run check`. They report actual commands, results, and remaining risks. The parent coordinates dependencies, reviews completed diffs and evidence, and manages acceptance and publication.

Do not pause for routine edits, formatting, or comments. After an edit mismatch, read the current file and repair only the remaining changes. Ask only for real blockers, conflicting instructions, scope changes, or actions that need owner approval.

Group questions and report progress at task boundaries. Do not ask the parent to approve each intermediate edit. Use independent subagents in parallel only when dependencies and write isolation allow it.

Keep one writer per worktree. Preserve failing evidence and all mandatory checks. Do not weaken tests to finish faster.

Stop and report agent-launch or runtime failures. Do not switch execution modes or models without approval, except the escalation that the global instructions pre-authorize. Mandatory human review and deployment restrictions remain in force.

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

## Subagent execution

The worker owns the whole task: failing test, implementation, `bun run check`, and the commit. The parent does not approve each step and does not re-run the worker's tests between steps. The parent reviews once per task with one reviewer subagent and once per branch before the pull request. Escalate to the owner only a real blocker, a scope change, or a decision the plan does not settle. Do not write a workflow controller inside a product task. Use the native `subagent` async run plus one reviewer. If a scripted workflow fails, add a deferred Backlog task.
