# Agent rules

Sources of truth: `docs/spec.md` says what the product does; `Backlog.md` says what is in progress and what is deferred. There is no roadmap, no milestone marker, no qualification report. This file is read natively by Claude Code and by pi; there is no `CLAUDE.md`.

Per task: pick a Backlog.md task; write the failing test first; implement; run `bun run check`; run the code-review skill; close the task. Evidence is a passing test, not a document.

Invariants no change may break: every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions.

Never: touch the owner's personal vault; deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation; change git identity; add a dependency without stating why in the task; create demos, labs or parallel plugins. If something cannot be tested in the real code, add a deferred task with a trigger.

Conventions: English in the repo; Conventional Commits; Biome formatting; Zod schemas in `packages/protocol` are the only place protocol shapes are defined.

History: this repository was restarted from scratch on 2026-10-11. Any agent memory, note or document dated before that describes the legacy codebase and does not apply.
