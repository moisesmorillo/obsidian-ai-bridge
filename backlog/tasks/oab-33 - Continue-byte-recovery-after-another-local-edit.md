---
id: OAB-33
title: Continue byte recovery after another local edit
status: Done
assignee:
  - '@pi'
created_date: '2026-11-02T16:17:00Z'
updated_date: '2026-11-05T03:06:00Z'
labels: []
dependencies: []
references:
  - apps/plugin/src/sync/text-apply.ts
type: enhancement
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner branch review pn-86bc2b accepts the current safe attention stop after another local edit during named byte recovery. Local bytes remain intact and durable recovery identity stays pending. Automatic continuation remains deferred. Trigger: OAB-8.7 recovery controls or repeated-edit evidence during OAB-8.8 qualification. This task covers both the safety stop and continuation. Do not create a separate safety-stop task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A regression stops after a named byte plan, changes local bytes again, and proves safe continuation preserves both observed versions before replacement.
- [x] #2 Continuation retains existing visible copy identities and verifies pre-apply bytes, stat guards, remote revision authority, and readback before base advancement.
- [x] #3 Repeated edits, corrupt copies, refused effects, and lifecycle close never cause an unguarded overwrite. Unsafe continuation retains pending work or attention.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Follow approved plan pn-fcb085 Task 5. Add failing repeated-edit named byte recovery regression. Preserve existing visible copies and each new observed version through durable extended plans, stat guards, pinned remote authority and readback. Test repeated edits, corrupt copies, refused effects and close. Also close OAB-32 minor copied-step and resume documentation items in the same recovery path. Run docs:check, full check and independent review.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope exception approved by the owner through ask_user_question and confirmed by the supervisor. The existing canonical PendingApplySchema caps copy count and only accepts one blob conflict/pre-apply pair. The repeated-edit regression rejected a four-copy plan, so the approved continuation cannot fit the current contract. Allow a bounded additive canonical schema extension and validation tests in packages/protocol. Preserve all existing persisted records, with an explicit pre-change journal load regression. Additive fields only if new fields are needed. Do not remove or rename existing fields. No Worker behavior change. A packages change triggers the normal Worker CI deployment on merge, which the supervisor accepts. No manual deploy.

Task 5 implementation at 76b0bbf plus this task commit. RED: repeated-edit text-apply regression failed because the later version had no visible copy, exit 1. RED: repeated-plan protocol test failed because the prior schema rejected the third hash pair, exit 1. GREEN: focused text-apply passed 92 tests, DeviceJournal passed 47, protocol device-state passed 17. Full check passed: Biome, docs:check, four workspace typechecks, 1746 tests, and all builds. Worker tests printed expected injected network and SQLite errors, then passed.

Added a reviewed schema scope exception approved by the owner and supervisor. The canonical journal schema accepts at most six copy records. It validates local or remote mode, operation source and side, unique paths, hash-paired conflict and pre-apply copies, and pre-apply path hashes. The plugin stops with attention and retains pending work if a new version exceeds the bound. A pre-extension serialized journal opens with the same copy paths. No persisted fields, dependencies, Worker source, or live service state changed.

OAB-32 review 84a62ef9 item 1 closure: the unsupported-size resume test now covers named and copied steps and asserts no body reads, unchanged base, and retained pending step. Item 2 closure: resumePending TSDoc states the attention, pending, and base outcomes. docs:check passes. Self-review found no unguarded replacement path. Parent review remains pending.

Task review ccd8e11a approved with notes at 7d6c01dad4ef5346b36d8510140b624ef6e364a8. Review confirmed bounded additive validation, pre-extension journal compatibility, saved identities, all-copy verification and guarded replacement. OAB-32 copied-step coverage and resume documentation items are fixed. One non-blocking finding remains for branch triage: near-limit source paths can produce recovery names above the canonical 512-byte limit. Schema validation preserves the prior pending plan and prevents replacement, but continuation stops before the new visible copy. Whole-branch review must address this item. No live evidence or Worker behavior change. Closure waits for branch reviews.

Final branch correction R2 RED: `bun run --filter @obsidian-ai-bridge/protocol test -- test/device-state.test.ts` failed because a tombstone fallback with three preserved blob-version pairs failed canonical pending-apply validation. GREEN: the same command passed all 17 protocol tests after delete recovery reused the existing validated local-put pair rules. Inline completion now accepts repeated blob pairs, selects the pair matching the current source hash and purpose, verifies all copies before replacement, and the tombstone branch selects the copy matching the current local hash. Existing restart and effect/readback tests pass.
R3 GREEN: repeated-edit continuation now bounds recovery names by 512 UTF-8 bytes while retaining the extension and hash suffix. `bun run --filter @obsidian-ai-bridge/plugin test -- test/text-apply.test.ts` passed 93 tests, including near-limit ASCII and multibyte source paths, canonical byte length, preserved extension, and successful final readback/base completion. No valid recovery name records attention and leaves the earlier pending plan intact.

Branch correction follow-up R2 matrix: `apps/plugin/test/text-apply.test.ts` tests “resumes repeated local versions after pinned revision pruning to blob”, `... to text`, and `... to deleted”. Each test seeds four durable blob-copy records for two local versions, persists copied state, closes and reopens DeviceJournal and TextApplyEngine, then resumes against revision 3 after the pinned revision 2 is unavailable. Tests retain exact bytes at every conflict and pre-apply path, require current-hash pair selection, and assert revision 3 base completion only after blob readback, inline readback, or confirmed trash. The blob row asserts guarded stat use. A refused blob write retains the old base and pending plan. A corrupt-copy regression proves attention and no recovery-copy refresh before validation completes.
Historical-code evidence: with both `apps/plugin/src/sync/text-apply.ts` and `packages/protocol/src/schemas/device-state.ts` temporarily loaded from `2059426`, `bun run --filter @obsidian-ai-bridge/plugin test -- test/text-apply.test.ts -t "resumes repeated local versions"` failed all three authority rows (3 failed, 93 skipped). The prior files were restored immediately.
Current GREEN: `bun run --filter @obsidian-ai-bridge/plugin test -- test/text-apply.test.ts test/sent-replay-authority.test.ts` passed 103 tests before adding guard cases. Final focused command passed 103 tests after guard cases were included. `bun run docs:check` and `bun run check` passed. The full check passed 56 tooling, 307 protocol, 515 plugin with 1 skipped, and 657 + 122 + 104 Worker tests. No live service or vault test ran.

Final branch closure: whole-branch review 1bacac3f covered the complete branch against current main. Corrective review 88a7015d approved 0dced7590c6484ed1ed28edac87ea78f85906fee and closed R1, R2 and R3. R1 separates epoch mismatch from cursor expiry. R2 covers repeated-plan restart fallback to blob, inline text and tombstone. R3 enforces the UTF-8 recovery-name budget. Reviewers assessed state-policy ownership, contracts, changed named declarations and semantic documentation. Autosquash and current-main integration preserved task source. Human review pn-09d26f approved 3364af028bd726dfdcf5b17aca816455ec21c39d with no annotations. The supervisor separately accepted measured local cost and retained 30,000 ms. Fresh parent docs:check and bun run check passed on that source: 1,776 tests passed, one opt-in measurement skipped. Lint, type checks and builds passed. Active LSP probes found no errors in the principal changed source files. No native desktop or current hosted performance proof ran. Only task closure records change after human approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Repeated byte recovery preserves verified versions with a six-copy bound. Compatible canonical validation supports pruned fallback, restart, and bounded UTF-8 names. Independent task, whole-branch, corrective, and human reviews passed. Final checks passed 1,776 tests with one opt-in skip. No live vault or service action ran.
<!-- SECTION:FINAL_SUMMARY:END -->
