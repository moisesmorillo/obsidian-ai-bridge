---
id: OAB-45
title: Packed export chunk column fails in production with Buffer is not defined
status: To Do
assignee: []
created_date: '2026-11-07T15:46:00Z'
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
- [ ] #1 packed_export_chunks.data maps to Uint8Array through a drizzle customType. No Buffer use remains in the packed export read or write path.
- [ ] #2 A test fails before the fix and passes after it with Buffer unavailable (deleted from globalThis in the test) across checkpoint, nextActive and readManifestRange or readSourceRange.
- [ ] #3 A guard test or tooling check fails when the production bundle references Buffer outside a typeof guard.
- [ ] #4 bun run check green and Worker preflight green. No compatibility flag change. No migration: the SQL column type stays blob.
<!-- AC:END -->
