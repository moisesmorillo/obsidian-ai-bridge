---
id: OAB-29
title: Classify delete feed rows without repeated manifest scans
status: Done
assignee:
  - '@pi'
created_date: '2026-10-29T12:16:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels:
  - deferred
dependencies: []
references:
  - apps/plugin/src/sync/reconciliation.ts
documentation:
  - docs/spec.md
type: bug
ordinal: 47000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner deferred this OAB-8.4 review item. Trigger: OAB-8.7 serialized loop implementation. Each delete currently scans the manifest from page one. A later recreate can make the historical delete produce misleading attention. Preserve obsolete revision and per-side safety rules.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Delete feed classification does not scan the manifest from page one for each row
- [x] #2 A delete followed by recreate does not create misleading attention or overwrite the newer base
- [x] #3 Tests cover inline text, unsupported blobs, obsolete deletes, and delete followed by recreate
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the single branch plan docs/superpowers/plans/2026-11-04-deferred-plugin-sync.md. Add failing multi-delete replay tests. Share manifest classification within one replay, preserve superseding revisions, and test text and blob admission. Run docs:check and bun run check. Complete independent task review and branch review before publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved branch plan pn-fcb085. Baseline bun run check passed before product changes. Work uses one task implementer and one task reviewer, then a whole-branch review. No live vault or service action is planned.

Task 1 implementation evidence: RED used `bun run --cwd apps/plugin test -- reconciliation.test.ts -t 'classifies multiple deletes from one paginated manifest per replay|ignores obsolete deletes before reading manifest authority|does not reuse manifest classification across replay calls'` and exited 0 via wrapper after observing code 1. Two tests failed on repeated page-one scans and obsolete delete lookup. GREEN focused tests passed. Added replay-local manifest rows with exact tombstone, newer revision, duplicate/missing authority, and unsupported admission handling. Final focused delete group: 15 passed. Full `bun run check` passed: lint, docs, typecheck, tests, and builds. Worker negative-control tests emitted expected uncaught exception diagnostics but their suites passed. Limits: local synthetic vault only. No live vault, deployed service, or desktop Obsidian run. Review: checked exact-revision authority, newer-base skip before manifest reads, newer recreate superseding old delete, safe missing/duplicate authority, blob and unsupported-size deletion behavior, per-replay cache lifetime, and scope. No known findings.

Independent task review c843a66d approved source b4b86910919b95a870195124fccbf520b8b96919 with no actionable findings. Review covered replay-local authority, epoch validation, obsolete and superseding revisions, unsupported blobs, named helper documentation, and controller policy ownership. Focused tests and full checks are worker evidence. No live desktop proof ran. Task closure waits for whole-branch and human reviews.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shared delete authority within each replay. Tests cover paginated text and blob deletes, obsolete revisions, recreate, missing authority, and cache lifetime. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
