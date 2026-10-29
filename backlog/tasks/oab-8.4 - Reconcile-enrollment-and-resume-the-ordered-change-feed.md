---
id: OAB-8.4
title: Reconcile enrollment and resume the ordered change feed
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-29T12:32:00Z'
labels: []
dependencies:
  - OAB-8.3
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Compose remote apply with resumable initial enrollment, manifest reads, and feed replay. One focused PR. Real-device proof remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Empty, populated, and mixed vault enrollment follows section 7.2. Automated AC-20 covers equal, local-only, remote-only, and different files.
- [x] #2 Pinned revision reads, pruned revision fallback, and manifest/feed overlap preserve exact bytes. Feed replay never applies an obsolete revision.
- [x] #3 AC-13 epoch recovery discards stale cursors and expected writes, rewrites bases by hash, and moves old-epoch operations to attention without loss. Cursor expiry triggers full reconciliation.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved plan pn-6571b8. Extend canonical device state and verified journal transitions. Add safe authenticated sync transport, create-only enrollment, manifest checkpoints, pinned reads with current fallback, hash-only epoch recovery, and ordered feed replay. Reuse TextApplyEngine. Keep general publishing in OAB-8.5, blobs in OAB-8.6, and scheduling/events/status in OAB-8.7. Use one worker for RED/GREEN, check, and commits. Complete task review, whole-branch review, owner diff review, and PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reviewed source revision: 3af6efb. AC1 tests cover empty and mixed enrollment, equal/local-only/remote-only/different paths, create races, response loss, and restart checkpoints. AC2 tests cover Worker-shaped JSON, exact BOM/CRLF/Unicode bytes, pinned pruning to live text or tombstone, saved and unsaved collision-copy recovery, manifest rows above captured head, obsolete puts, and source-only renames without reads. AC3 tests cover hash-only epoch reset, lower new revisions, stale cursor/expected writes/pending apply removal, lossless queued/sent operations in attention, later attention updates, and 409/410 recovery through resume and replay.

RED/GREEN: tests first exposed absent journal transitions, raw-response mismatch, BOM loss, obsolete restored bases, unresolved lost responses, binary text reads, incomplete close fences, fixed-page assumptions, attention record loss, resume recovery gaps, tombstone fallback refusal, and remote-copy rebase failure. Focused tests passed after each fix. Final worker bun run check passed at 3af6efb with 1,396 tests across 88 files, lint, docs, types, and dry-run builds. docs:check and diff checks also passed.

Independent task review and corrective review approved the implementation. Whole-branch review at 8bd63e7 found F1-F7. Corrective review at 3af6efb closed every finding with regression evidence. F1 preserves archived operations. F2 shares resume/replay recovery. F3 safely restarts live page traversal. F4 fences upload admission and completion. F5 accepts current tombstones. F6 retains verified copies and replaces unsaved plans. F7 keeps obsolete and rename-side admission in the engine. No actionable finding remains.

Documentation audit covered changed semantic declarations, private helpers, ports, and canonical schemas. Structural candidates were reconciliation, journal, text apply, transport, and enrollment scope. The corrective reviewer passed the stateful ownership gate. Parent active diagnostics returned no TypeScript errors on three key modules. Auxiliary pattern findings did not establish defects.

No live service or vault proof ran. OAB-8.8 retains real two-device proof. Existing host trash and rename race limits remain. Unsupported blobs receive durable attention without confirmed apply. No general publish, scheduler, event trigger, status panel, dependency, Worker source, or infrastructure change ships here. Owner branch review remains pending.

Owner branch review pn-268b7e requested terminal enrollment handling. Owner then approved corrections for terminal outcomes, the reset-to-checkpoint resume gap, and readManifestPage TSDoc. Source revision 4ab542a implements that scope. Only 409 path_collision, 409 operation_expired, 422 idempotency_mismatch, and 413 are terminal. Validated collision paths reach attention. Rejected operations resolve, later local paths continue, and final cursor persists. 401 and 429 remain uncertain. Tests cover production-shaped collision, terminal outcome matrix, crash before local progress, resume after listing/checkpoint failure, and fresh disconnected resume. Independent scoped review approved 4ab542a. Final worker bun run check passed with 1,408 tests across 88 files. No source changed after that check. Owner directed checks then PR without another owner gate.

Owner accepted two bounded deferrals. OAB-29 covers delete-row classification without repeated manifest scans, triggered by OAB-8.7 loop work. OAB-30 covers hydration conflict copy timestamps, triggered when conflict names become user visible. These do not block this PR. No live service or vault test ran.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added resumable text enrollment, verified manifest checkpoints, exact pinned reads with current-state fallback, hash-only epoch recovery, and ordered feed replay. Canonical state and guarded apply preserve local bytes, newer revisions, and old operations. Terminal enrollment rejections reach durable attention without blocking later paths. Worker check passed with 1,408 tests. Independent reviews closed all blocking findings. Owner reviewed the branch and approved the final correction scope. OAB-29 and OAB-30 retain accepted deferrals. Real-device proof remains OAB-8.8. No Worker source or infrastructure changed.
<!-- SECTION:FINAL_SUMMARY:END -->
