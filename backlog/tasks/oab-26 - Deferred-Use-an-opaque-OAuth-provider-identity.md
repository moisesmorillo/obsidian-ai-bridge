---
id: OAB-26
title: 'Deferred: Use an opaque OAuth provider identity'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T16:48:00Z'
updated_date: '2026-11-05T00:12:00Z'
labels:
  - deferred
  - privacy
dependencies: []
references:
  - OAB-7.8
documentation:
  - docs/spec.md
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-7.8 finding S1 remains open. The provider authorization code exposes the owner subject as its user-id prefix in browser history and client logs. This is a privacy concern, not proof of an Access bypass.

Trigger: before broader third-party client use, select and test a safe identity transition. Preserve durable authority and existing grants. Do not record actual subjects, codes, or tokens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New consent flows use an opaque provider identity in authorization codes, access tokens, and refresh tokens. Legacy grants follow the approved compatibility policy.
- [ ] #2 Tests cover stable owner mapping, token callback matching, provider cleanup, and the documented treatment of existing grants.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execute approved plan pn-3a5ce0 as one atomic task: deterministic service-scoped SHA-256 provider identity, exact two-identity callback mapping, preserved legacy grants with fixed existing expiry, explicit revokeExistingGrants false, bounded dual-namespace cleanup with 48 counted calls, synthetic RED/GREEN coverage, and public compatibility documentation. One implementer owns both sections, full bun run check, and commit. Parent owns task review, whole-branch review, human branch review, closure, and PR 4. The first PR body line states the production identity change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Supervisor confirms PR 50 merged. Main is current at 88e88989b8708715d4963e3b64bcf084ad645145. Owner approved all six decisions in plan pn-3a5ce0, including the bounded AC1 replacement above. Legacy refresh retains its provider prefix and existing expiry. New consent uses a deterministic pseudonym, not encryption or an unlinkable secret. No worktree existed before the explicit supervisor signal. No deployment, resource change, new secret, dependency, live-state migration, or vault action belongs to this task.

Implementation evidence, 2026-11-05.

RED: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/provider-identity.test.ts` exited 1 before implementation because the helper module did not exist. It reported one failed suite and zero tests. GREEN: the same command passed two tests after the helper was added.

Cleanup test chronology exception: the application and dual-namespace cleanup code preceded the new isolated cleanup budget tests. Those tests were added after implementation. They pass the four-call remainder, five-call completion reservation, and no-budget-progress cases. The full check first found that the completed cleanup path was incorrectly marked pending when it spent the last reserved call. The application now tracks per-grant completion.

Focused command: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/provider-identity.test.ts test/application-clients-cleanup.test.ts test/f2/oauth.test.ts test/f2/owner.test.ts` passed 30 tests. The complete F2 command `cd apps/worker && bunx vitest run --config vitest.f2.config.ts` passed 108 tests across eight files. The isolated cleanup command `cd apps/worker && bunx vitest run --config vitest.config.ts test/application-clients-cleanup.test.ts` passed three tests.

`bun run docs:check` passed. `bun run check` passed lint, docs, type checks, tests, and dry-run builds. Tests passed: tooling 56, protocol 306, plugin 483, Worker suites 660, 122, and 108. Total: 1,735 tests in 100 files. Four workspace type checks passed. Protocol and plugin builds passed. The Worker dry-run build passed. Expected injected network, stream-cancellation, and SQLite errors appeared in test logs.

The approved privacy exception remains: existing legacy codes and grants keep their provider identity through existing expiry or explicit revocation. Legacy refresh can emit another raw-subject-prefixed token. The pseudonym is deterministic and known-input-comparable, not secret or anonymous. KV cleanup is eventually consistent and cannot prove global immediate absence. No deployment, resource change, live-state migration, vault action, new secret, or dependency occurred. OAB-26 remains In Progress and all acceptance criteria remain unchecked for parent review.

Task-review correction, 2026-11-05.

Finding closure: replaced the full acceptance list through repeated `--acceptance-criteria` flags. OAB-26 now has exactly two unchecked criteria. AC #1 uses the approved bounded consent identity and legacy compatibility wording. AC #2 retains the test coverage requirement once. The task remains In Progress.

Finding closure: added a late-token-write integration case. It saves a valid synthetic provider token record, clears both namespace token keys, injects the token after cleanup reads the opaque namespace as empty, then proves the restored token receives `401 revoked` from durable authority. The revocation request uses seven counted calls, within the 48-call limit.

Finding closure: added a provider-list failure integration case. The durable registry denies the grant before the first namespace list fails. The grant remains `revoked: true` and `cleanup_pending: true`. The existing access token receives `401 revoked`. No grant-completion RPC occurs. The request uses three counted calls, within the 48-call limit.

Finding closure: added an 11-grant application budget case. The first request completes nine empty grants, leaves two pending, and uses 47 of 48 calls. The second request completes both remaining grants, reports no pending cleanup, and uses 12 calls. The test confirms bounded progress without a loop or false completion.

These correction tests followed the existing product implementation. No code was deleted to manufacture RED. The original identity helper RED/GREEN history and cleanup chronology exception remain recorded above.

Final correction validation: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts` passed 110 tests in eight files. `cd apps/worker && bunx vitest run --config vitest.config.ts test/application-clients-cleanup.test.ts` passed four tests. `bun run docs:check` passed. `bun run check` passed lint, documentation, four workspace type checks, tests, and dry-run builds. Totals: tooling 56, protocol 306, plugin 483, Worker suites 661, 122, and 110. Total: 1,738 tests in 100 files. No remote CI or live-service action was run.
<!-- SECTION:NOTES:END -->
