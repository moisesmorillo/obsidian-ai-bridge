---
id: OAB-45
title: Packed export chunk column fails in production with Buffer is not defined
status: Done
assignee:
  - '@pi'
created_date: '2026-11-07T15:46:00Z'
updated_date: '2026-11-07T15:58:00Z'
labels:
  - worker
  - F6
  - backup
dependencies: []
priority: high
type: bug
ordinal: 81000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Production incident 2026-11-07: the first scheduled packed export (15:00:37 UTC) never completes. Workers Logs show every alarm step failing with 'Buffer is not defined'. Cause: apps/worker/src/infrastructure/sqlite/schema-model.ts defines packed_export_chunks.data as blob('data', { mode: 'buffer' }). Drizzle's SQLiteBlobBuffer calls Buffer.from in mapFromDriverValue, and the production Worker runs without nodejs_compat (compatibility_flags has only unhandled_rejection_after_microtask_checkpoint). The vitest pool-workers runtime exposes Buffer, so bun run check stays green. Fix: define the column with drizzle customType over a Uint8Array (dataType blob, identity mapping on both directions) and keep every chunk read and write on Uint8Array. Do not add nodejs_compat. Then close the test gap: add a test that proves the Worker bundle or runtime has no Buffer dependency (for example a vitest run with globalThis.Buffer removed around the packed export chunk round trip, or a bundle scan in tooling that fails on Buffer references outside guarded typeof checks). The stuck export must resume after deploy: the alarm loop retries every minute, so no manual intervention is expected.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 packed_export_chunks.data maps to Uint8Array through a drizzle customType. No Buffer use remains in the packed export read or write path.
- [x] #2 A test fails before the fix and passes after it with Buffer unavailable (deleted from globalThis in the test) across checkpoint, nextActive and readManifestRange or readSourceRange.
- [x] #3 A guard test or tooling check fails when the production bundle references Buffer outside a typeof guard.
- [x] #4 bun run check green and Worker preflight green. No compatibility flag change. No migration: the SQL column type stays blob.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Export chunk buffer fix

Goal: Restore packed exports without Node Buffer.
Architecture: Keep SQLite blob storage. Map driver bytes with a Uint8Array customType.
Spec: docs/spec.md section 11 and the S7 owner brief.

Owner decisions
- Use the requested customType, not nodejs_compat.
- Use an equivalent Buffer-free runtime guard inside the existing test commands. No new dependency.
- Keep SQL, migrations, generated schema, vault.ts, and compatibility flags unchanged.
- No live service calls or resource changes. Local preflight only.
- The owner authorizes unattended execution without Plannotator.

Steps
- [ ] Add a packed export round trip with Buffer deleted and restored in finally. Cover checkpoint, nextActive, manifest ranges, and source ranges.
- [ ] Run the regression before the fix and record the expected Buffer failure.
- [ ] Add the runtime guard against Buffer-dependent byte mapping, including ArrayBuffer and Uint8Array driver values.
- [ ] Replace the schema column mapper and remove Buffer casts from packed-exports.ts. Preserve byte offsets and lengths.
- [ ] Run focused tests, docs:check, bun run check, and Worker preflight.
- [ ] Commit the fix. Review the task and complete branch with the code-review TypeScript profile.
- [ ] Rebase on origin/main, close OAB-45, push, create one PR, and remove the worktree.

Review focus
- Driver ArrayBuffer wrapping does not copy bytes.
- Uint8Array views retain offsets and lengths.
- Recovery reads pending chunks without Buffer.
- Source and manifest ranges retain exact bytes.
- SQL remains blob with no migration.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/packed-export-schema-upgrade.test.ts -t 'round trips packed export chunks without a global Buffer'` failed as expected with `ReferenceError: Buffer is not defined` in `SQLiteBlobBuffer.mapFromDriverValue`.
GREEN: the focused no-Buffer round trip and mapper tests passed (2 passed, 13 skipped). The complete packed export schema test file passed (15 tests).
Validation: `bun run docs:check`, `bun run check`, and `bun run --filter '@obsidian-ai-bridge/worker' preflight` passed. Runtime schema generation check passed with unchanged `packed_export_chunks.data` SQL type `blob`; no migration or compatibility flag changed.
Scope: no vault.ts edits, live service calls, resource changes, deployment, push, PR, or task closure.

Review: task and whole-branch reviews APPROVE with no findings. Reviewed implementation 8218f6a against origin/main d4b178f. Scope included mapper contracts, view bounds, checkpoint recovery, ranges, and semantic documentation. Review confirmed cohesive schema and persistence ownership. No actionable findings need closure.
AC 3 uses the equivalent runtime guard authorized by the S7 brief. Unused Drizzle Buffer implementations remain in the bundle. Tests prove the affected path without Buffer, not universal bundle absence.
Final checks after rebase: 2,268 tests passed, 1 skipped, zero failed. Check and preflight exited 0. No live recovery check or deployment.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Replaced the packed export Buffer mapper with a Uint8Array customType. Added failing-first Buffer-free regression and driver-mapping guards. SQL stays blob. All local checks and both reviews passed. No migration, compatibility change, or vault.ts edit. Production recovery awaits the owner merge and CI deployment.
<!-- SECTION:FINAL_SUMMARY:END -->
