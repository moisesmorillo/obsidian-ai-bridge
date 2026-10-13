# Backlog Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for this single tracking-only maintenance task. No delegation or future-phase implementation is required.

**Goal:** Make completed F0, committed future phase gates, and trigger-based deferrals distinguishable before selecting F1 work.

**Architecture:** Keep `docs/spec.md` as product authority and Backlog as progress authority. Add the owner-approved `Deferred` status, preserve all existing task identities, dependencies, triggers and future acceptance cases, and correct the README's stale F0 summary. This is one metadata/documentation deliverable, not a roadmap or product change.

**Tech Stack:** Existing Backlog.md CLI and YAML configuration; existing Bun frozen-install/check pipeline. No new dependency.

**Spec:** `docs/spec.md` §§14, 16, 17; maintenance task OAB-23; owner explicitly selected a separate Deferred status in this conversation.

## Global Constraints

- Start from merged `main` commit `feee0e1cdb65ee4d216a8bbe8d45046b1c2c4b2a` in `~/.worktrees/obsidian-ai-bridge/chore/backlog-reconciliation`.
- All task changes use Backlog CLI. Its config-set command does not support statuses; only the existing `backlog/config.yml` status list is edited directly.
- Keep `To Do`, `In Progress`, `Done` and the default status unchanged; add `Deferred` without a dependency sweep or invented phase.
- No application source, test semantics, dependency versions, spec contract, resource, deployment, personal vault or F1 implementation changes.
- Do not close unimplemented deferrals or check their future acceptance cases. Complete only the reconciliation task after verification and human diff approval.
- English and portable paths; no additional roadmap, milestone or qualification document.

## Review Focus

- A trigger-based item must not be mistaken for an immediately scheduled phase deliverable.
- A future seam (for example blob references) must not promote its deferred feature (GC) into F1.
- Native CLI readiness is dependency-based; verify behavior rather than promising the raw `--ready` flag understands every custom status.
- A metadata edit must not silently change IDs, dependencies, triggers, seams or unchecked future acceptance criteria.
- README must report actual merged foundation/CI evidence without claiming synchronization, deployment or all 44 product acceptance cases.

---

### Task 1: Reconcile OAB-23 metadata and current-status documentation

**Files:**
- Modify: `backlog/config.yml` (one status-list change).
- Modify through CLI: OAB-6–12 (phase labels/type/clarifying notes), OAB-13–21 (Deferred status and trigger classification notes), OAB-22 (F0 label), OAB-23 (tracking/evidence).
- Modify: `README.md` (current status and phase/deferral navigation).
- Test: ignored `.superpowers/backlog-reconciliation/verify.mjs`, using actual CLI JSON plus a before snapshot. This is a scoped audit, not a new product test suite.

**Interfaces:** Consume native `task list/view --json`, configured statuses, and spec phase/deferral tables. Produce explicit phase-gate and Deferred classifications, unchanged original obligations, and a truthful README. Do not change Backlog's installed implementation.

- [ ] **Step 1: Write the failing metadata audit.** Snapshot task descriptions/dependencies/acceptance criteria before implementation. Assert the status list contains Deferred; OAB-13–21 are Deferred with `deferred` and `trigger-based` labels and no phase label; OAB-6–12 have `phase-gate` and respectively F1/F2/F3/F3b/F4/F5/F6; completed F0 tasks including OAB-22 remain Done with F0 labels. Assert every original description/dependency/future acceptance case is unchanged, using notes for clarification. Assert README no longer states F0/remote CI are pending. Collect specific failures rather than accepting any nonzero command as RED.
- [ ] **Step 2: Run the audit before classification changes.** Parent `bg_run`: `node .superpowers/backlog-reconciliation/verify.mjs`. Expect failures only for missing Deferred/classifications and stale README, not parser/CLI errors. Finish the independently running merged-source frozen/full baseline before claiming baseline GREEN.
- [ ] **Step 3: Apply the approved classification.** Add Deferred to the status list. Through CLI, give phase gates their exact labels and type `task`; move the nine §16 items to Deferred, preserving descriptions/AC/dependencies and adding `trigger-based`. Add F0 to OAB-22. Add notes that phase dependencies never authorize implementation/deployment and deferrals have no committed phase: activate only after the documented trigger is evidenced and researched/planned. Preserve the F1 gate as To Do; GC's execution remains deferred, while its preserved seam is not a separate ready task.
- [ ] **Step 4: Correct README current status.** Record merged PR #3, 49 passing tests and actual successful remote CI; state the Worker still has no API routes and plugin is inert. Document `backlog task list --status 'To Do' --labels phase-gate --plain`, eligible phase selection with additional `--ready`, and `backlog task list --status Deferred --plain`. Explain that OAB-23 is maintenance, not an unassigned product phase. Explicit status filtering is intentional; do not fabricate dependencies to hide optional items.
- [ ] **Step 5: Verify actual classification and graph.** Run the audit GREEN plus `backlog doctor`; verify the explicit To Do/phase-gate/ready query returns only OAB-6 and the Deferred query returns exactly OAB-13–21. Inspect raw custom-status readiness and describe any tool limitation honestly. Confirm no future AC/status was marked completed and no existing dependency changed.
- [ ] **Step 6: Verify and review.** Parent `bg_run`: frozen installation, `bun run check` with Worker metrics disabled, and `git diff --check`; expect 49 tests and all local checks/builds. Run the code-review skill directly for this documentation/configuration diff. Open the branch diff against `main` in Plannotator and address annotations before publication.
- [ ] **Step 7: Finalize tracking and publish.** After objective evidence and owner approval, check OAB-23 criteria and close it via CLI, commit with a Conventional Commit, publish an English PR and verify actual CI. Never merge locally or start F1 as a side effect. Retain records needed for follow-up.
