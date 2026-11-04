---
id: OAB-31
title: Select current bytes after queued put size changes
status: Done
assignee:
  - '@pi'
created_date: '2026-11-02T16:17:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/publication.ts
type: bug
ordinal: 50000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b accepts this bounded deferral. refreshQueuedPut selects its reader from saved payload size, not current file size. A queued wait can cross the inline/blob boundary. Current local bytes remain intact, but the next payload can use the wrong reader. Trigger: OAB-8.8 qualification or evidence of a size transition while a put waits queued.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Tests cover both inline-to-blob and blob-to-inline changes during a queued wait, including invalid UTF-8, BOMs, and line endings.
- [x] #2 Reader selection follows current file admission. The queued successor preserves exact current bytes or stops with attention before sending.
- [x] #3 Sent keys, payload bytes, headers, and revision preconditions remain immutable. Files above 25 MB cause attention without a full body read.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan pn-fcb085 Task 3. Add failing queued size-transition tests, select readers from current admission, preserve exact bytes and sent operation identity, and stop files above 25 MB before body reads. Run focused tests, docs:check, full check, and independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: Focused run at 7e1272e failed 3 transition/oversize cases. Both queued boundary transitions lacked successors. Oversize admission read the body. The invalid UTF-8 case did not match the initial test filter and was not part of RED.
GREEN: Added current-size admission, current-reader selection, byte-count validation, exact-byte queued successors, and safe attention for invalid text bytes. Focused publication tests passed 5/5, including existing sent-operation immutability coverage.
Checks: bun run docs:check passed. bun run check passed. Lint checked 241 files. Typecheck passed for tooling, protocol, plugin, and Worker. Tests passed: 1,735 across 97 files. Builds passed for protocol, plugin, and Worker.
Review: Self-review found no blocker. The change stays within publication orchestration and tests. Sent retries bypass queued refresh. Existing transport tests cover immutable request headers.
Limits: Worker tests print expected uncaught network, stream-cancel, and injected SQLite fault diagnostics. They exit zero. No live vault or service was used. Independent review remains with the parent.

Round 1 review correction: Added same-length malformed UTF-8 regression using ED A0 80, whose replacement encoding has the same three-byte length. RED observed exit 1: the invalid bytes produced a queued successor instead of safe attention. Added current-base transition coverage. GREEN: Strict raw UTF-8 validation now rejects malformed inline bytes into attention and preserves the original local bytes. Successors use the latest confirmed epoch and revision.
Finding closures: MAJOR closed. Inline queued bytes now come from the raw reader and pass fatal UTF-8 validation before successor admission. If the exact-byte reader is unavailable, the queued operation moves to attention. Valid BOM and line-ending bytes remain unchanged. MINOR closed. A queued boundary transition now proves the predecessor uses rev 2 and the successor uses the updated current epoch and rev 5.
The first full check after the code change found two plugin fixture failures because their text vaults lacked exact-byte readers. Added exact UTF-8 byte readers to those related test fixtures. Focused publication suite then passed 62/62. Final docs:check and bun run check passed. Full check tests passed: 1,736 across 98 files. All typechecks and builds passed. Lint checked 241 files. Worker test output contained expected simulated network, stream-cancel, and SQLite fault diagnostics. The task remains In Progress.

Correction: Final bun run check passed 1,736 tests across 97 files, not 98.

Task review 9f9c6f13 found same-length malformed UTF-8 could pass a decoded-length check and requested confirmed-base successor coverage. Corrective review f12168f8 approved source 43f62a56f05f25cd25bf1799c5dfb08edc9a03e8. Both findings are fixed through exact raw-byte reads, fatal inline UTF-8 validation, and explicit revision-2 to revision-5 successor coverage. Reviewer reconstructed admission and sent/queued authority and checked declaration documentation. Focused tests and full check passed under worker validation. No live proof ran. Closure waits for branch reviews.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Queued publication selects current admission and validates raw bytes. Successors retain exact bytes and current base authority. Sent retry identity stays immutable. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
