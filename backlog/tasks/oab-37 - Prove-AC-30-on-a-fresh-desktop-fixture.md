---
id: OAB-37
title: Prove AC-30 on a fresh desktop fixture
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-04T18:03:00Z'
updated_date: '2026-11-04T23:31:00Z'
labels:
  - deferred
dependencies: []
references:
  - OAB-8.8
  - apps/plugin/tools/desktop-acceptance.ts
  - apps/plugin/test/desktop-acceptance.test.ts
documentation:
  - docs/spec.md
priority: medium
type: task
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three OAB-8.8 live tries did not complete AC-30. Suffix 04 collided locally. Suffix 05 stopped at a combined successor assertion.

Suffix 06 stopped at AC30_ASSERT_FINAL_CALL_COUNT: expected 3, observed 2. Individual call identities, statuses, and assertion-time queue data were not retained. Commit edc181e adds passing local characterization and does not reproduce the failure.

A later diagnostic-pair correction does not explain the historical missing third call. Trigger: A local regression explains that missing call and supports a reviewed tooling correction. The owner must authorize fresh disposable-vault credentials and a live fixture.

The current dev-2 client is revoked. Do not reuse historical fixture paths or infer further live authority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 One authorized desktop run proves immutable retry identity and bytes, plus a distinct successor with the confirmed precondition.
- [ ] #2 Safe observations identify call counts, revisions, receipt equalities, and queue state for each final condition.
- [ ] #3 The device and service retain the intended content and restored methods, or record the exact failed condition.
- [ ] #4 No personal vault or protected historical fixture changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the reviewed plan at /tmp/oab-37-plan.md. First reproduce the two-call result locally. Correct only acceptance tooling and tests. Review and validate before one authorized live case. Preserve historical fixtures and stop if product sync changes are needed.

Supervisor decision: S1 owns the product fix under OAB-40. Retain the harness but skip its three timing cases with an OAB-40 reason comment. Complete independent tooling corrections, focused tests, docs:check, full check, and task review. Commit and stop. Do not enroll dev-2 or run live AC-30. Wait for the supervisor instruction after the S1 PR merges before rebase and harness activation.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Stopped at the authorized sync boundary on 2026-11-04. Plan pn-406ba6 was approved. The local regression in apps/plugin/test/desktop-acceptance.test.ts uses real journal, publication, desktop, and reconciliation controllers with a synthetic committed feed. Three timing cases reach AC30_ASSERT_FINAL_CALL_COUNT with two fixture requests and one other-path request. The fixture remains at service revision 1 while feed replay reaches cursor 2. Cases cover delayed modify admission, debounce before the retry deadline, and debounce while the first PUT waits. This reproduces the failure class, not the historical live event order. The sync owner must assess the other-path publication before any tooling-only correction or live run.

Worker RED command: bun run --filter @obsidian-ai-bridge/plugin test -- test/desktop-acceptance.test.ts -t 'checks AC-30 feed replay across delayed modify and debounce orderings'. The expected-red wrapper returned shell exit 0 and printed observed-test-exit=1. One test failed and 40 were skipped. The earlier characterization passed one test with 57 skipped. Baseline desktop acceptance tests passed before the new regression.

No production sync or tooling correction, live vault action, credential enrollment, browser action, service request, deployment, commit, push, or PR ran. Dev-1 was not accessed. The failing test and task changes remain uncommitted on feature/oab-37-ac-30-live. Full checks and reviews did not run. Report and plan remain in ignored or temporary paths. Report to the supervisor under the S2 brief. Do not mark acceptance criteria complete.

Supervisor assigned the product defect to S1 as OAB-40. The three retained controller timing cases now stay skipped with an OAB-40 reason comment. Enrollment and live AC-30 wait for supervisor instruction after the S1 PR merges. The supervisor also approved one publication.test.ts fixture-path assertion update for the fresh generator default.

Independent tooling now validates oab-37/ac-30-response-lost-*.md fixture paths, uses the initial attention count, and retains bounded call identity labels, statuses, revisions, complete retry-receipt equality, and assertion-time queue observations. Diagnostic projection omits raw keys, paths, payloads, hashes, ETags, and epoch values.

Task review ed4d6e61 covered the three-file overlay on e810cde2fe879e2b1aba828d69a30f89c122b35a with the code-review skill and TypeScript profile. It requested direct failure-path cleanup proof and complete retry receipt equality. Corrective review 6077464f closes both findings after it inspected the final code and regression tests. The cleanup test installs the generated interceptor, injects fixture creation failure, omits separate cleanup, and proves exact original method identity. The receipt regression keeps equal ETags but changes seq. It failed before the complete seven-field comparison and passed after the correction. The diagnostic reports only a boolean. AC30_ASSERT_FINAL_RETRY_ETAG remains the compatibility code for the complete receipt mismatch.

Worker validation after corrections: desktop acceptance tests passed 44 with 3 OAB-40 cases skipped. Focused publication tests passed 2 with 56 skipped. bun run docs:check, bun run check, and git diff --check passed. The full check recorded 1,729 passing tests and 3 skipped cases, with lint, documentation, type checks, and builds. The receipt RED run recorded 1 failed, 1 passed, 45 skipped, and observed test exit 1 inside a successful expected-red wrapper. The new cleanup test passed immediately because the existing finally block already restored the method.

Review limits: the corrective reviewer could not read the supplied ignored report and correction-diff paths. It used the prior review and current worktree diff and did not rerun checks. Worker commands provide the validation evidence. Canonical tooling typecheck passes despite pre-existing editor alias diagnostics. Full branch and human diff reviews remain pending the future live checkpoint. No real vault, browser, credential, live service, deployment, push, or PR action ran. Keep OAB-37 In Progress and all live acceptance criteria unchecked. Prepare the scoped checkpoint commit and stop.
<!-- SECTION:NOTES:END -->
