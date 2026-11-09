---
id: OAB-50.8
title: Remove the remaining AI Bridge names
status: Done
assignee: []
created_date: '2026-11-09T21:46:00Z'
updated_date: '2026-11-09T23:16:00Z'
labels: []
dependencies: []
parent_task_id: OAB-50
priority: high
type: chore
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner approved a breaking rename without compatibility or migration code. The supervisor owns release, deployment checks, reconnection, and local folder changes. Item 8 also adds explicit MCP delete consent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Accept only obsidian://vaultwire/callback across protocol, plugin, Worker, and tests.
- [x] #2 Use .vaultwire/, Vaultwire settings conflicts/, and vaultwire-sync-status without moving old folders.
- [x] #3 Use vaultwire: device storage keys without migration. Tests prove hash reconciliation preserves data with stale journal, stale epoch, or missing credentials.
- [x] #4 Use vaultwire as the production object key. Reject tokens without a grant in the new registry. Record that old history and export lists remain in the old object.
- [x] #5 Remove legacy plugin migration code, commands, tools, documentation, target keys, and old plugin exclusions. Keep vaultwire and .vaultwire exclusions.
- [x] #6 Remove the VAULTWIRE_CUTOVER_AUTHORIZED deployment guard and its test expectations.
- [x] #7 Update current docs, tooling, tests, and development vault names. Rename docs/api/f2.md and fix links if it denotes a legacy phase.
- [x] #8 Advertise vault:read vault:write vault:delete. Consent keeps read mandatory and grants only checked requested scopes. Devices retain delete. Update spec and tests.
- [x] #9 Name search returns only permitted history matches. Report every remaining match and reason. bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan: docs/superpowers/plans/2026-11-09-remove-legacy-names.md. One implementer owns the breaking rename, stale-state safety tests, MCP scope consent, docs, tooling, and checks. Wait for plan approval. Then use task review, whole-branch review, Plannotator branch review, rebase, checks, and PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision: no compatibility period or data migration. Production object key vaultwire selects an empty object. The first connected device imports files. Revision history and the old exports list remain in the old object. Item 8 keeps delete separate and lets the owner narrow requested scopes. No live actions are authorized.

Implementation steps 1–3 completed on feature/remove-legacy-names. bun run check passed with exit 0. It passed lint, docs:check, all workspace typechecks, all tests, and dry-run builds. Test totals: tooling 107, protocol 314, plugin 850 passed and 1 skipped, Worker 1055 across its three suites. Biome reported 15 existing non-null-assertion warnings and no errors. Focused Worker consent and OAuth/MCP tests passed 103 tests. Focused plugin session, storage, journal, enrollment, and desktop-acceptance tests passed 258 tests. No live service, vault, deployment, or Cloudflare resource action ran. Remaining current-surface matches: wrangler.production.jsonc and its deployment-preflight/config fixtures retain the released transfer migration source name; docs/spec.md records wiped legacy resources as history; oauth.test.ts rejects the old provider-identity digest; device-storage.test.ts constructs the former local key for its ignored-key test; release-please-config.test.ts, release.test.ts, and release-versions.test.ts preserve legacy tag/plugin-ID rejection cases; deployment-config.test.ts asserts removal of the cutover secret; product-labels.test.ts checks that the former API path is absent. Older Backlog task records and historical plans retain pre-cutover names and remain unchanged. No old local keys, data, or migration code are read or migrated.

Test-first exception: no baseline RED run was retained for each added regression test. Focused tests and bun run check passed after implementation. I do not claim baseline RED evidence. The first full check failure came from a stale tooling assertion for the renamed API guide, not a product regression.

Acceptance-test review closures: the plugin startup test stores a stale journal under the former key, starts with no current credentials, preserves local bytes, and reconciles the remote row by hash under the new epoch. The test passed on first run because source behavior was already correct. The Worker old-identity test first returned 201 and committed content despite an empty current registry. I added selected-registry grant-record validation before REST and MCP dispatch. The test now proves the old object retains the grant, the current Vaultwire registry has no grant, the production PUT returns 401, and no content commit runs. Known revoked grants still use the existing denial path. The old identity separator and object name use string fragments in the new test fixture. The routing test now checks the added current-object lookup. Final validation passed: plugin 30 files and 851 passed with 1 skipped, Worker 73 files and 1,056 passed, docs:check passed, bun run check passed. Biome reports 15 existing non-null-assertion warnings and no errors. No baseline RED is claimed for the reconciliation test. Task stays In Progress for parent review.

Acceptance-gap fix commit: 867bf51 (fix: reject grants absent from selected vault registry).

Final-review correction wave: Finding 1 fixed. The rejection fixtures keep the tested historical values but split all prohibited substrings across fragments: device-storage.test.ts:61, reconciliation.test.ts:779, oauth.test.ts:760, 775, 1007, release-versions.test.ts:87, deployment-config.test.ts:54, and product-labels.test.ts:62. The exact acceptance search `git grep -n -i -E 'ai-bridge|ai bridge|obsidian-ai-bridge|obsidian-bridge|aibridge'` still returns only approved history outside backlog, plans, and changelogs: apps/plugin/test/release.test.ts:239 preserves a released plugin-tag rejection case; apps/worker/test/deploy-preflight.bun.ts:64 and apps/worker/wrangler.production.jsonc:36 preserve the released namespace-transfer source; docs/plugin-release.md:17 documents existing legacy release tags; docs/spec.md:44 records wiped resources as historical context; tooling/test/deployment-config.test.ts:117 protects the released transfer migration; tooling/test/release-please-config.test.ts:148 preserves the old release-tag case. No other non-backlog/non-plan/non-changelog match remains. Finding 2 fixed. Removed DeviceSessionHost.authorizationCompleted, its migration-only comment, and its invocation. Credential persistence, identity persistence, rollback, and generation checks remain unchanged. No test-first RED is claimed because this final cleanup changes already passing assertions and removes an unused hook. Validation: focused plugin tests passed 3 files/105 tests; focused Worker OAuth tests passed 1 file/41 tests; focused tooling tests passed 2 files/11 tests; docs:check passed; bun run check passed 2,328 tests with 1 skipped, all typechecks and dry-run builds. Biome reported 15 existing warnings and no errors. Initial Worker focused command used the wrong Vitest root and found no tests; rerun from apps/worker passed.

Final review closure: whole-branch review inspected a1525c0..867bf51 and the task notes. Scoped review approved fixes through 0c2f285. Both missing acceptance tests now pass. The old-token test exposed a real authorization gap: the Worker trusted provider validity without selected-registry membership. The request wrapper now checks retained client_grants before REST or MCP dispatch. Revocation remains downstream. Structural candidates oauth.ts, clients.ts, main.ts, and text-vault.ts remain cohesive after state and policy review. Documentation review covered changed contracts, consent, recovery, API guide, and README. No actionable finding remains. Owner approved branch review pn-5121ae at http://localhost:64557 without annotations. Final fetch and rebase found origin/main unchanged. Parent ran bun run check on 0c2f285: exit 0, 2328 passed, one skipped, 15 existing warnings, typechecks and dry-run builds passed. Exact name search leaves seven current-path lines, all approved history listed above. No measured coverage report or hosted CI evidence was available. No live service or personal vault test ran.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete the breaking Vaultwire rename and selective MCP consent. Devices use new local keys and callback without migration. The new object denies absent grants before API dispatch. Tests cover stale local state, hash reconciliation, selected scope grants and refresh, and old-object token denial. Independent and human branch reviews approved the final source. Full check passed with 2328 tests and one skipped. Supervisor release, deployment checks, reconnection, secret deletion, and real folder changes remain separate live steps.
<!-- SECTION:FINAL_SUMMARY:END -->
