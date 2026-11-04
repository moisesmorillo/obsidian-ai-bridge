---
id: OAB-40
title: Defer replay conflicts while a sent operation remains unresolved
status: Done
assignee:
  - '@pi'
created_date: '2026-11-04T22:36:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/reconciliation.ts
  - apps/plugin/src/sync/publication.ts
documentation:
  - docs/spec.md
type: bug
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Session S2 reproduced an AC-30 sync failure with real controllers and a synthetic service. The first PUT commits at revision 1 but its response is lost. The device edits the same path again. Replay sees the committed revision before the sent retry resolves and treats it as a foreign change. It publishes the local edit as a conflict copy at another path. The fixture never receives its successor PUT. Spec section 7.7 and AC-30 expect the idempotent retry to resolve the sent operation, then the successor to publish at the same path with the new revision and no conflict copy. A path with an unresolved sent operation must not become a remote conflict during replay. Resolve or defer it. The supervisor assigned this bounded fix after OAB-33 and before OAB-8.10 on the deferred plugin sync branch. S2 retains acceptance-tool ownership.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A failing regression uses real journal, publication, reconciliation, and desktop controllers with a synthetic service. It reproduces commit, lost response, later local edit, and replay before retry resolution.
- [x] #2 The sent retry keeps its key, bytes, and original precondition. After its receipt, a distinct successor publishes at the same path with the confirmed epoch and revision. No conflict copy appears for this own committed revision.
- [x] #3 Replay safely resolves or defers paths affected by unresolved sent operations. Deferred work does not advance an unconfirmed base or discard feed authority. Foreign changes, obsolete revisions, restart, and close remain safe.
- [x] #4 Exact-revision mutation guards, absence-never-deletes, obsolete revision safety, and visible collision versions remain intact. Focused regressions, documentation, full checks, and independent review pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Supervisor authorized OAB-40 after OAB-33 and before OAB-8.10. Reproduce S2 response-loss and own-feed timing in our own test files with real controllers and a synthetic service. Resolve or defer affected replay paths while sent operations remain unresolved. Preserve feed order, sent identity and revision authority. Test same-path successor, foreign edits, restart and close. Run docs:check, full check and independent task review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: `bun run --filter @obsidian-ai-bridge/plugin test -- test/sent-replay-authority.test.ts` failed at the cursor assertion. Replay advanced past the unresolved sent operation and replaced the newer local edit.
GREEN: The regression now passes with 2 tests. It checks immutable retry identity and bytes, the original precondition, a distinct same-path successor, ordered unrelated feed work, no own-revision conflict copy, restart, and close.
Validation: `bun run docs:check` passed. `bun run check` passed with 505 plugin, 56 tooling, 305 protocol, and 882 worker tests, plus all builds and typechecks.
Limits: No direct unresolved-rename feed fixture was added. Existing rename precondition recovery tests passed. The AC-30 desktop acceptance source and S2 worktree remain untouched.

Correction round 1 RED: `bun run --filter @obsidian-ai-bridge/plugin test -- test/sent-replay-authority.test.ts` failed for both the absent-precondition replay and full-manifest overlap. The manifest case replaced newer local bytes before receipt.
MAJOR closure: Manifest traversal now leaves its persisted `pending_paths` checkpoint before an unresolved sent path. It does not advance the manifest or cursor. Exact journal-backed absent-create hash matches set the confirmed base and resolve the create without applying over a successor. Other sent work still blocks. Old-epoch operations follow `resetEpoch` into attention.
MINOR closure: The integration regression starts without a base, commits revision 1, loses its response, edits locally, and replays before retry settlement. It verifies the same absent retry key, bytes, and precondition, then a distinct same-path revision-1 successor with no conflict copy.
Compatibility evidence: Full-manifest tests cover startup deferral and epoch reset. Cursor-expiry recovery stays deferred until retry. Enrollment response-loss recovery now preserves a later local edit. Existing genuine 412, foreign edit, and rename recovery tests pass.
Validation: Focused sent-replay, reconciliation, publication, startup, and late-receipt tests passed 161 tests. `bun run docs:check` passed. `bun run check` passed with plugin 507, tooling 56, protocol 305, and worker 882 tests.
Limits: No live service or vault tests ran. No new direct rename-side overlap test was added. Independent parent review remains required. OAB-40 stays In Progress.

Task review a4f3b061 found unguarded manifest reconciliation and missing absent-create timing coverage. Corrective review 8132e7bf approved source a02c9850de72170265d8eb7ea8ee0232e519d9ce with both findings fixed. Manifest deferral retains checkpoint authority, exact matching absent creates resolve without overwriting local successors, and epoch reset retains specification behavior. The real-controller regression now starts absent and checks same-key retry plus distinct same-path revision-1 successor. Review covered state ownership and declaration documentation. Direct per-side rename overlap remains an evidence limit. Worker focused tests and full check passed. No S2 file or live service changed. Closure waits for branch reviews.

Branch correction R1 RED: `bun run --filter @obsidian-ai-bridge/plugin test -- test/sent-replay-authority.test.ts` failed because replay retained epoch A after `epoch_mismatch` while old sent work remained.
R1 GREEN: the same focused command passed all 5 tests after replay distinguished confirmed epoch mismatch from cursor expiry. `replay()` now reaches manifest reconciliation on epoch mismatch, resets the epoch, moves old sent work to attention, applies the new manifest, and retains confirmed cursor authority. Existing sent-operation deferral remains for same-epoch cursor expiry. Exact evidence: `apps/plugin/test/sent-replay-authority.test.ts`, test “resets the epoch through replay when old sent work blocks cursor recovery”. No direct epoch-only reconcile call in this regression.

Branch correction follow-up R1: the replay regression now also enqueues and publishes `notes/new-epoch-work.md` after epoch B reset through a synthetic PublicationController. It asserts the publication uses epoch B and clears the valid new-epoch operation. Test: `apps/plugin/test/sent-replay-authority.test.ts`, “resets the epoch through replay when old sent work blocks cursor recovery”. `bun run --filter @obsidian-ai-bridge/plugin test -- test/text-apply.test.ts test/sent-replay-authority.test.ts` passed 103 tests. `bun run docs:check` and `bun run check` passed.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Sent-path authority defers feed and manifest conflict classification. Immutable absent retry precedes the same-path successor. Automatic epoch recovery remains reachable. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
