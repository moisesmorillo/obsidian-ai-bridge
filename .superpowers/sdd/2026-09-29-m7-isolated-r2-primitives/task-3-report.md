# Task 3 — Marker-gated current and recovery records

**Status:** Implemented; validation passed. Independent reviewer gate remains for the parent session.

## Delivered

- Added a private `SyncR2Records` facade for marker-gated current-head reads/create/exact-observed replacement; immutable version/content persistence; and recovery metadata/body persistence.
- The facade validates the exact `syncVaultMarkerKey` and strict marker contents before returning head absence or accepting writes. Marker absence, malformed/cross-vault marker, and unavailable reads fail closed.
- Version and recovery reads validate the strict `.json` record and separately read the exact raw `.md` object; computed SHA-256 and byte size must both match before metadata/body is returned as present. If either counterpart is missing while the other exists, the result is unavailable, not absence. Both absent version objects produce verified absence.
- Immutable writes remain create-only through Task 2. Head replacement preserves the exact observed generation and never refreshes a stale CAS. No multi-key mutation sequencing, `SyncStore`, route/composition, or v2 behavior was added.
- Extended local workerd evidence with byte-exact read-back and before/after v2 sentinel comparison under sync-prefix-only listing.

## TDD evidence

**RED 1 — missing facade:**

```text
$ mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-records.test.ts
FAIL: Cannot find package '@worker/infrastructure/sync/sync-r2-records'
```

After implementation, added a focused orphan-evidence regression: missing `.json` metadata with a present raw body incorrectly returned `absent` (2 failures for version and recovery). The implementation was corrected to distinguish both-absent from incomplete linked evidence.

**GREEN:** focused facade suite passes: 1 file / 10 tests. Local workerd test passes: 2 files / 9 tests. The first workerd run exposed a test-fixture-only single-use R2 body read (`Body has already been used`); the fixture now compares cached byte arrays and the suite passes.

## Commands and exact results

- `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-records.test.ts` — passed, 1 file / 10 tests.
- `mise run worker:storage-test` — passed, 2 files / 9 tests.
- `mise run typecheck` — passed.
- `mise run test` — passed, 95 files / 1,517 tests.
- `mise run lint` — passed; TSDoc presence 0 violations across 234 production files; Oxlint no diagnostics.
- `mise run biome:check` — passed; 373 files, no fixes needed.
- `mise exec -- bunx biome check --write apps/worker/src/infrastructure/sync/sync-r2-records.ts apps/worker/tests/unit/infrastructure/sync-r2-records.test.ts` — passed; formatting/import assists applied before final checks.
- `git diff --check` — passed.

`mise run check` and `mise install` were not run; the requested focused test, storage runtime test, typecheck, full test, lint, and Biome gates were run.

## Changed files

- `apps/worker/src/infrastructure/sync/sync-r2-records.ts`
- `apps/worker/tests/unit/infrastructure/sync-r2-records.test.ts`
- `apps/worker/tests/runtime/sync-r2-primitives.test.ts`
- This report.

## Self-review and remaining concern

Reviewed marker gating, exact key/vault/path validation via Task 1 codec and M7.1 builders, strict version/recovery metadata-to-body hash/size linkage, exact stale-head CAS behavior, immutable conflict handling, exact bytes, namespace isolation, private Worker-infrastructure ownership, and absence of v2/route/composition changes. No blocker identified in this self-review. The current Task 1 type calls the version record `SyncVersionMetadata` rather than the brief's `SyncVersionRecord`; the facade uses the actual strict Task 1 type without changing persisted formats. Independent review remains required by the parent review gate.
