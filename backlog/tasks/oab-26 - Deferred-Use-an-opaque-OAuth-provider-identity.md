---
id: OAB-26
title: 'Deferred: Use an opaque OAuth provider identity'
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T16:48:00Z'
updated_date: '2026-11-05T00:41:00Z'
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
- [x] #1 New consent flows use an opaque provider identity in authorization codes, access tokens, and refresh tokens. Legacy grants follow the approved compatibility policy.
- [x] #2 Tests cover stable owner mapping, token callback matching, provider cleanup, and the documented treatment of existing grants.
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

Task review at 407b3da requested corrections. Finding 1, acceptance conflict and duplication: fixed at 4971f2a with exactly two unchecked criteria and the approved bounded wording. Finding 2, missing cleanup cases: fixed with real local KV/DO late-token-write denial and provider-list-failure pending-state tests, plus application continuation over 11 empty grants across two requests. Corrective review APPROVE at 4971f2a, with both findings fixed and no new issue. The 11-grant case uses a stub provider to prove the application budget and continuation, not 11 real KV grants. The late write leaves a token record present but unusable at the DO, not globally absent. Latest worker full check passed 1,738 tests across 100 files, docs, lint, types, and builds. Test chronology exceptions remain explicit. No live-service or remote CI evidence applies. Active lens probe found one URL warning at oauth.ts 181. Review rejected it as a defect because canonical configuration validation and equality checks precede that URL construction.

Whole-branch review correction, 2026-11-05.

Finding closure: expanded the callback rejection test to cover an unrelated raw owner, a different derived owner, a different derived service, and absent, invalid, or changed callback identity configuration. Each rejection asserts zero grant-registration calls.

Finding closure: added repeated opaque consent coverage. The test confirms both issued opaque access tokens still resolve to stored grants and both remain usable after the second consent.

Finding closure: reused the real pinned-provider legacy grant fixture for authorization-code and refresh revocation races. Each flow covers revocation before and after durable registration. Pre-registration denial returns invalid_grant. Post-registration issuance remains denied by durable revocation and cannot refresh again.

Finding closure: the legacy expiry test advances fake time by five seconds before refresh and checks the rotated access-token creation time advanced. A finally block restores real timers. The provider grant expiry remains unchanged.

The tests followed the existing implementation. No product code was removed to manufacture RED. No product source changed in this correction.

Final validation: the complete F2 suite passed 115 tests in eight files. The isolated cleanup suite passed four tests. bun run docs:check passed. bun run check passed lint, documentation, four workspace type checks, 1,743 tests in 100 files, and dry-run builds. Expected injected network, stream-cancellation, and SQLite errors appeared in worker test logs. No live-service or remote CI action ran.

Whole-branch review at 3ff1072 against 88e8898: APPROVE WITH NOTES. Scope: all eight files, identity trust contract, installed provider, legacy lifetime and grant preservation, cleanup call budget and state matrix, TSDoc/API truth, and cohesive adapter/application/durable ownership. Prior task findings were fixed. Final minor direct-coverage finding fixed at b6b6f5a: callback configuration and wrong derived identity rejection, repeated opaque consent preservation, and real-DO legacy code/refresh races. Expiry now advances fake time five seconds and restores timers, so the assertion distinguishes fixed expiry from same-second renewal. Scoped corrective review APPROVE over 3ff1072..b6b6f5a confirms that closure with no new finding. No production source changed in the correction. Latest worker bun run check passed 1,743 tests across 100 files plus lint, docs, four type checks, and builds. git diff --check passed. Reviewers inspected evidence without rerunning checks. No live-service, remote CI, CPU, or native-memory claim applies. Human branch review follows.

Owner approved human branch review pn-d5fc4c with no changes. Both approved acceptance criteria now have direct test and documentation evidence. Earlier chronology exceptions remain recorded, not replaced with false RED claims. This final update changes task metadata only. Publish PR 4 with the exact approved production-change first line, then stop for owner merge. Legacy privacy and eventual KV cleanup remain explicit approved limits.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
New consent uses the approved service-scoped SHA-256 provider identity. Callback mapping accepts only that identity or the exact configured legacy subject and preserves durable raw-owner authority. Fresh consent preserves existing grants. Bounded cleanup covers both namespaces within the 48-call owner budget. Legacy grants retain their identity and existing expiry until explicit revocation or expiry. Tests cover identity/config rejection, repeated consent, legacy compatibility and registration races, fixed expiry, list failure, late writes, and cleanup continuation. Full check passed 1,743 tests plus lint, docs, types, and builds. Task review and whole-branch review findings are fixed. Owner approved pn-d5fc4c without changes. No live-service or resource action occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
