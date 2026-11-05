---
id: OAB-32
title: Stop unsupported apply before content reads
status: Done
assignee:
  - '@pi'
created_date: '2026-11-02T16:17:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/text-apply.ts
type: bug
ordinal: 51000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b defers the unsupported-admission read gap in applyCurrent and applyPathChange. An unsupported path can reach vault.read before admission stops the content read. This bounded deferral does not authorize an unguarded overwrite. Local bytes must remain intact. Trigger: OAB-8.8 qualification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Tests cover applyCurrent and feed apply for files above 25 MB. Neither route reads the complete text or binary body.
- [x] #2 Unsupported local content stays unchanged. The apply retains safe pending state or attention without advancing an unconfirmed base.
- [x] #3 Supported inline and blob applies retain exact-byte preservation, revision guards, and current scope boundaries.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan pn-fcb085 Task 4. Add failing direct-current and feed apply regressions above 25 MB. Stop unsupported admission before full text or binary reads. Preserve pending work or attention without base advancement. Test resumed work and supported paths. Run docs:check, full checks and independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task 4 implementation at dcaef73. RED: focused oversized direct-current/feed test failed with 7 local text reads, observed exit 1. RED: resumed named-work test failed with 2 binary reads, observed exit 1. GREEN: focused regression tests passed, 3 passed. Final focused checks: text-apply and enrollment-scope, 124 passed. docs:check passed. bun run check passed: lint, docs, typecheck, all tests, and builds. Worker tests printed expected simulated network and SQLite failure logs, then passed. Scope limit: rename admission was not changed. Tests use an actual 25,000,001-byte local fixture and verify body-read counts, byte hash, pending state, attention, and base revision.

Task review 84a62ef9 approved with non-blocking notes at implementation revision 88000aa0f1fe13a2657269e508da0c6c9f829b3f. The earlier dcaef73 reference names the base, not the implementation. This entry corrects that revision note. Reviewer confirmed metadata admission, unchanged bases, and retained pending work before recovery effects. Two minor items carry into OAB-33, which changes the same recovery path: add unsupported copied-step coverage and document the unsupported resume outcome. Branch review must verify both closures. No live vault or service proof ran. Closure waits for branch reviews.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Unsupported non-rename apply stops before complete body reads. Direct, feed, named and copied tests retain local bytes, pending work and unchanged bases. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
