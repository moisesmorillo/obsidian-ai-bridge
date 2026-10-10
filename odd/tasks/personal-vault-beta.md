# Personal vault beta scope

Objective: make a narrow, opt-in personal-vault beta the sole NEXT milestone after the completed synthetic M9 demonstration.

Problem: M9 proves automatic sync only in disposable Desktop vaults. The owner wants to beta-test in an existing iCloud-backed vault soon, starting with one new Markdown note, without repeating large-scale synthetic profiles.

Authorized scope: documentation-only M10 transition and implementation-ready beta contract. No code, Cloudflare operation, production deployment, or personal-vault access in this task. The owner authorized the beta direction, not broad activation or iCloud replacement.

Constraints: preserve M1–M9 delivered behavior; use a separate private beta endpoint and storage namespace; admit one exact new Markdown path first; preserve exact-base conflict behavior; no broad vault scan, deletes, renames, mobile claim, or zero-iCloud-effect claim. G1–G6 remain open for general production and full real-data support. Define focused safety gates for this owner-approved bounded exception.

Route: delegated direct. Mapping required README, architecture, roadmap, current state, M9 and activation-gate documents (4+ files); writing spans multiple non-trivial docs. TDD: preferred RED/GREEN/REFACTOR for new behavior from repository `AGENTS.md`, runner `mise run test`; this documentation-only transition has no behavior test. Full gate `mise run check` and link/diff checks. RDD: on globally per `gentle-ai review mode status`; assess the committed work unit. Engram mirror pending because runtime identity is unavailable; do not write agent-attributed memory.

Delivery: `ask-on-risk`, one documentation work-unit commit on `docs/personal-vault-beta-scope`; push/PR/merge remain owner decisions. Forecast about 250–350 authored changed lines, below the advisory 400-line delivery threshold. No production files.

Acceptance: M10 is the only NEXT milestone, has focused functional deliveries and beta entrance/rollback criteria, and affected top-level docs point to it without changing M9 completion or implying current personal-vault readiness. Checks are recorded truthfully.

Tasks:
- [x] BETA.1: define bounded M10 beta contract, one-note first run, privacy/iCloud effects, prerequisites, rollback, and small functional slices. Route: delegated writer. Check: semantic consistency with existing M9 and G1–G6. Evidence: `docs/milestones/m10-personal-vault-beta.md`; existing G1–G6 gate text was retained with a narrow exception note. No activation implied.
- [x] BETA.2: update roadmap, README, architecture, current-state, rollout plan and ADR references; keep historical evidence intact. Route: delegated writer. Check: local links and diff check passed; `mise run check` passed (2,305 fast tests; 53 storage; 17 smoke passed with one existing skip; 95.01% statement coverage; typecheck/lint/build/dry-run passed). Initial sandboxed run could not write build artifacts; escalated rerun passed.
- [ ] BETA.3: review and commit documentation transition. Route: delegated writer. Check: independent semantic review, native RDD assessment, Conventional Commit, clean tree.

Progress: tracker was created before the first documentation write. The M10 spec, ADR 0023 narrow exception and active references are drafted. First `mise run check` attempt was blocked by sandbox write permissions for build artifacts, not a source failure; escalated full check passed. Independent semantic review returned APPROVE after the ADR/plan reconciliation, with no remaining documentation inconsistency. No beta implementation or remote operation has occurred.

Next step: documentation work-unit commit and native RDD assessment. Mirror pending (runtime identity unavailable).
