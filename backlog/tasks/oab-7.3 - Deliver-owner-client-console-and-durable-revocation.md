---
id: OAB-7.3
title: Deliver owner client console and durable revocation
status: Done
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-24T17:48:00Z'
labels:
  - F2
  - owner
dependencies:
  - OAB-7.2
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F1 stores revoked grants and checks them, but exposes no owner console. F2 needs protected client inspection and revocation through the real authentication path. Work is local only.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Verified Access protects owner client listing, names, and revocation. Untrusted content cannot execute in console output. State changes reject forged owner requests.
- [x] #2 Revocation persists in the authoritative DO before provider KV revocation. Local tests prove the next request fails with 401 revoked despite stale KV or KV failure.
- [x] #3 Revocation covers the selected client grants, preserves committed data, and never depends on KV propagation for immediate denial.
- [x] #4 Tests cover invalid Access claims, unauthorized callers, repeat revocation, operation races, and provider failures. No plugin or deployed behavior is claimed.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use docs/superpowers/plans/2026-10-24-f2-local-delivery.md, Task 2. After OAB-7.2, deliver the owner console and authoritative grant revocation with race tests.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
OAB-7.2 passed independent review and scoped consent correction review at 3026486. Task 2 follows the approved plan. Preserve the production identity path and explicit consent guard. Work remains local only.

Task 2 adds the schema-7 owner registry, schema-6 upgrade, durable client and grant records, generation fencing, owner pages, CSRF, bounded cleanup, and OAuth callback checks. Original RED: two owner tests returned 404 instead of expected 401 and 403 before routes existed. Original GREEN: focused F2 tests passed after implementation.

Scoped review closures: T2R-1 adds four deterministic production OAuth and real-DO orderings for code and refresh registration before or after owner revocation. T2R-2 preserves nonzero history and retention metadata and rejects changed or missing catalog objects and malformed schema-6 metadata without repair. Both findings close with test-only changes. The new tests pass against the existing production implementation.

Focused command: cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts test/f2/registry.test.ts test/f2/schema-upgrade.test.ts test/f2/owner.test.ts. Result: 4 files and 30 tests passed. bun run docs:check passed. bun run check passed. Worker suites passed 37 files and 641 tests, 8 files and 120 tests, and 5 F2 files and 40 tests. Protocol passed 13 files and 278 tests. Plugin passed 2 files and 2 tests. Tooling passed 4 files and 52 tests. Type checks, formatting, generated-schema validation, and dry-run builds passed.

Report: .superpowers/sdd/2026-10-24-f2-local-delivery/task-2-report.md. Keep the task In Progress for scoped re-review. Commit pending. No deployment or push occurred.

Scoped re-review correction commit: aad9ea38f55b3a8e1301622f33dd147f172d329a (test(worker): close task 2 review gaps). The correction changes tests only. T2R-1 and T2R-2 now have concrete regression evidence. Task remains In Progress for scoped re-review.

Independent review ebf9cbeb covered 4ff27e4..eeabb34. It approved the implementation with T2R-1 and T2R-2 test gaps. The worker closed both in test-only commit aad9ea3. Scoped review 689e9dcf approved both closures with no open defect. Documentation review covered schemas, TSDoc, task evidence, and production-path tests. Structural candidates clients.ts, oauth.ts, application/clients.ts, owner.ts, and schema.ts retain separate authority, provider, transport, and migration roles. Four deterministic real-DO code/refresh races prove denial across both registration orderings. Nonzero metadata and malformed schema-6 tests prove preservation and rejection without repair. Full check and docs:check pass. The F2 suite passes 40 tests. Local evidence does not qualify deployed Access, external clients, MCP, or plugin behavior.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete the local owner console and durable revocation in eeabb34 and aad9ea3. Verified Access, browser-bound single-use CSRF, escaped output, bounded pages, and provider cleanup protect owner operations. The DO closes client generations and stores grant denials before KV cleanup. Tests prove immediate revoked denial, failed cleanup, code/refresh races, committed-data preservation, and schema-6 upgrade safety. Independent and scoped reviews pass. The full check passes. No deployment occurred. OAB-7 stays open.
<!-- SECTION:FINAL_SUMMARY:END -->
