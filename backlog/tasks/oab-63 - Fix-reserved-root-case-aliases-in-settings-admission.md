---
id: OAB-63
title: Fix reserved-root case aliases in settings admission
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-11T02:04:00Z'
updated_date: '2026-11-11T03:46:00Z'
labels: []
dependencies: []
references:
  - OAB-56
documentation:
  - docs/spec.md
priority: low
type: bug
ordinal: 103000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-56 confirms one low-severity defect at revision 66ff86a. A remote .OBSIDIAN/app.json blob reaches a dummy local binary-effect call while settings sync is disabled. Raw reserved-root comparisons disagree with canonical lowercase path identity. No evidence proves real host writes or code execution. This is the single fix task for all confirmed audit findings. Keep the existing non-atomic settings-write limit unchanged. No production, Cloudflare, real vault, device, or OAB-57 work belongs to this task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Case aliases of .obsidian follow the same settings consent, category, and hard-exclusion policy as canonical paths.
- [ ] #2 Case aliases of .trash and .vaultwire remain excluded, and ordinary eligible files retain their original path spelling.
- [ ] #3 Reconciliation, apply, and the vault adapter reject disabled or hard-excluded settings aliases before any local file-effect call.
- [ ] #4 Regression tests fail before product changes, then pass with enabled-category controls and reserved-root alias cases.
- [ ] #5 bun run docs:check and bun run check pass. Independent task and whole-branch reviews close actionable findings.
- [ ] #6 The branch includes project audit skills in a separate commit. The task and pull request name their source repositories. No audit reports or evidence enter Git.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
One branch plan: ~/workspace/moisesmorillo/vaultwire-security-audit/fix-plan.md. Preserve the current settings-write race and every revision guard. Write failing classifier, reconciliation/apply, and adapter regressions first. Use canonical path identity for reserved-root and settings-prefix decisions, but preserve original path spelling. Run focused tests, bun run docs:check, and bun run check. Commit project skills separately from the product fix. Use one whole-task worker, independent task review, final whole-branch review, and one owner branch review. After approval, push, open one pull request, remove the worktree, and stop. Await owner plan approval before product changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The owner asks for one fix task and one plan for this branch. OAB-63 covers the only confirmed finding. The branch also contains the separately committed project skills: security-audit from cloudflare/security-audit-skill. workers-best-practices and durable-objects from cloudflare/skills. entry-point-analyzer, sharp-edges, supply-chain-risk-auditor, variant-analysis, semgrep, and sarif-parsing from trailofbits/skills. The global copies remain installed. static-analysis is a plugin, not an installable skill. insecure-defaults has no SKILL.md and remains unavailable. entry-point-analyzer excludes this non-smart-contract project. No plan approval or product implementation exists yet.

Owner approved ~/workspace/moisesmorillo/vaultwire-security-audit/fix-plan.md through Plannotator pn-8153db. Approval settles all listed defaults and starts implementation. Use one whole-task worker. Keep the skill commit separate and all audit artifacts outside Git. No external action authority follows from approval.

Implementation evidence: RED command `bun --filter @vaultwire/plugin test -- enrollment-scope.test.ts reconciliation.test.ts text-apply.test.ts text-vault.test.ts` observed exit 1. It reported 12 failing assertions across 334 tests, including `.TRASH/private.md`, `.VAULTWIRE/private.md`, `.OBSIDIAN/app.json` and `.ObSiDiAn/app.json` returning `text` or `blob`, disabled `.OBSIDIAN/app.json` reconciliation calling one binary mutation, and direct apply reaching binary apply without capabilities. GREEN focused command passed 6 files and 424 tests after publication alias cases were included. `bun run docs:check` passed. `bun run check` passed: lint, documentation, 4 workspace typechecks, 30 plugin test files (896 passed, 1 skipped), protocol (314 passed), tooling (107 passed), worker tests (63 files/871 tests, then 9 files/138 tests, then 10 files/150 tests), and 3 builds. Biome reported existing warnings in plugin transport tests and worker tests. No new dependency or spec change. No live Obsidian, device, vault, or production test ran. The settings adapter retains its documented non-atomic write window. External audit limits remain unchanged.

Project skill sources installed without content edits: `security-audit` from `cloudflare/security-audit-skill`; `workers-best-practices` and `durable-objects` from `cloudflare/skills`; `entry-point-analyzer`, `sharp-edges`, `supply-chain-risk-auditor`, `variant-analysis`, `semgrep`, and `sarif-parsing` from `trailofbits/skills`. `insecure-defaults` remains unavailable because no installable `SKILL.md` exists. `static-analysis` is a plugin, not a skill. `entry-point-analyzer` does not apply to this non-smart-contract project.

Self-review: reviewed the complete task diff against `fix-plan.md`, `docs/spec.md` sections 5.1, 7.1, 7.6, and 7.8, source call paths, and changed test fixtures. No actionable finding. `text-vault.ts` remains a cohesive adapter. Enrollment scope owns canonical root/category/exclusion policy. Apply and publication consume that policy at admission boundaries. Text apply transition and revision guards did not change. Documentation scope covered the new canonical-root helper and changed classification contracts. Structural candidates: enrollment classifier and stateful text apply. The classifier remains a cohesive path policy. Text apply remains the policy owner for serialized local effects and recovery. State dimensions, effects, observed revisions, and conflicts remain unchanged. Limits: no external independent review or host runtime evidence in this worker scope.

Validation note: Biome now excludes only `.agents/skills` from checks. The installed upstream audit skills contain source-format and rule faults, and the plan forbids edits to their source content. The project check still covers all application and repository source. The exclusion lets the unchanged vendor content and canonical checks coexist. This config change does not affect runtime behavior.
<!-- SECTION:NOTES:END -->
