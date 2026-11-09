---
id: OAB-50.4
title: Prepare the Worker for the vaultwire script
status: Done
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:29:00Z'
labels:
  - rename
  - worker
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 89000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge, apps/worker wrangler configs, deploy workflow and their tests. The production script becomes `vaultwire` with SERVICE_ORIGIN https://vaultwire.mmorillo.dev and bindings to vaultwire-blobs, vaultwire-backups and vaultwire-oauth. The Durable Object namespace holds the real vault journal, so the new script must take over the existing namespace from the obsidian-ai-bridge script with a Durable Object transfer migration instead of starting empty. Development configs follow the same names. Rehearse the transfer on development scripts with synthetic data before production.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A development rehearsal transfers a Durable Object with synthetic journal data between two scripts and reads the same cursor and files after the transfer.
- [x] #2 Deployment config tests pin the new script name, origin, bindings and migration.
- [x] #3 bun run check and Worker preflight pass. No production deploy happens in this task.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal and approved design
Prepare the vaultwire Worker without a production deploy. Transfer Vault from obsidian-ai-bridge with transferred_classes and no destination-create migration. Preserve the object key with VAULT_OBJECT_NAME=obsidian-bridge.mmorillo.dev in production. Use isolated development values. Fail closed when the binding is missing.

## Owner decisions
The supervisor extended source scope to index.ts and infrastructure/auth/oauth.ts for stable object selection, with binding typing and supporting tests. S17 placeholders stay. The production cutover guard stays. The supervisor authorized only vaultwire-rehearsal-a and vaultwire-rehearsal-b, including deletion. No production deploy or personal vault access. Keep CLOUDFLARE_DEPLOY_TOKEN as the GitHub secret key. No new dependencies.

## Completed steps
- [x] Verify official Cloudflare transfer syntax and destination constraints.
- [x] Add failing config and object-selection tests before implementation.
- [x] Prepare configs, bindings, deployment guards and isolated preflight.
- [x] Route all nine production selections through VAULT_OBJECT_NAME.
- [x] Test missing names, callback name drift, every routing seam, and origin checks.
- [x] Rehearse synthetic SQLite cursor and file continuity across the two authorized scripts.
- [x] Delete both rehearsal scripts and inspect both deletion messages.
- [x] Pass bun run check, docs:check, focused tests and Worker preflight.
- [x] Complete task review, whole-branch review and scoped correction review.
- [x] Continue PR 130 on the same branch. Publish and remove the isolated worktree after final bookkeeping.

## Evidence limits
The remote rehearsal used a temporary SQLite fixture and Wrangler 4.156.2, not repository-pinned 4.45.0. It proves synthetic namespace and object continuity only. It does not qualify the production Worker, production schema, alarms, OAuth state or R2 content. S17 output replacement and production cutover remain separate work. Earlier blocked-draft notes describe superseded task states.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief: S19-vw-worker.md and V-COMMON.md allow development scripts and deploys only. No production deploy. File ownership excludes Worker source and infrastructure. Cutover blocker: apps/worker/src/index.ts selects Vault with idFromName(request host), and scheduled and OAuth paths use SERVICE_ORIGIN. The new hostname selects a different object despite namespace transfer. OAB-50.6 needs an explicit object-identity solution before production. Do not change these source files in this task.

Implementation results: Production Wrangler config now uses vaultwire, vaultwire.mmorillo.dev, the vaultwire R2 names, the named S17 KV and Access placeholders, and a transferred_classes migration from Vault in obsidian-ai-bridge. Both development configs keep independent create migrations and isolated names. The deploy workflow checks OAB-50.6 cutover authorization and unresolved placeholders before deployment. Local preflight removes transfer migrations and inserts a local Vault create migration.

Validation: Focused config test RED before implementation: 2 failed and 3 passed, with script-name and KV-placeholder mismatches. Focused config tests then passed 6 tests. Worker preflight test passed. bun run docs:check passed. bun run --filter '@obsidian-ai-bridge/worker' preflight passed. bun run check passed: lint, docs, all typechecks, test suites, and dry-run builds.

Development rehearsal blocker: Wrangler whoami exited 1. Its private output produced only the safe failure label unknown_wrangler_failure. No development scripts or Cloudflare resources were created. No production deploy or vault access occurred. The synthetic remote transfer rehearsal remains incomplete because this worktree has no usable Wrangler authentication.

Production cutover blocker: apps/worker/src/index.ts derives the Vault object key from the request host, while scheduled and OAuth paths use SERVICE_ORIGIN. Namespace transfer alone does not preserve the object selected by the new hostname. OAB-50.6 must resolve object identity before production deployment. No Worker runtime source changed.

Review closure: task review and final whole-branch review both returned APPROVE WITH NOTES for blocked-draft publication only. Both reviewed 4077c8bc76ca06e4f8f714425e838157cd746dad against 7ed19cca1e566e9a6975c19c4c576213f4bb79ab. Scope covered all eight changed files, TypeScript declaration documentation, preflight lifecycle cohesion, transfer configuration, deploy guards, local isolation, and relevant identity callers. Neither review found an actionable code defect. The missing rehearsal remains open and blocks AC1. The hostname-derived identity mismatch remains open and blocks production cutover. S17 placeholders remain open and block deployment. Config tests and local checks prove AC2 and AC3 only. Hosted CI and actual remote data continuity remain unverified. Parent LSP probe found no new TypeScript errors. Auxiliary findings apply to existing caught errors, loopback TLS, and private temporary-file handling. Keep this task In Progress and publish a draft PR under the owner blocker rule.

History: the supervisor extended scope to resolve the hostname-derived identity blocker through VAULT_OBJECT_NAME. Source changes in index.ts and infrastructure/auth/oauth.ts are now allowed for this purpose. Binding types and relevant test fixtures support that change. The supervisor will provide a token file and explicitly confirm it in a second message. No token read or remote rehearsal may start before that confirmation. The supervisor authorizes deletion of both named rehearsal scripts after use. Keep S17 placeholders and the production cutover guard.

Approved object-name extension: VAULT_OBJECT_NAME now selects the Durable Object in REST, measurements, owner registry, export, blob GC, owner measurements, scheduling, consent, and OAuth grant callbacks. The production value remains obsidian-bridge.mmorillo.dev. Development configs use isolated stable values. Missing or empty names stop Worker fetch, scheduled work, OAuth setup, callback validation, and consent routes before namespace lookup. SERVICE_ORIGIN keeps origin validation only.

RED evidence: before implementation, scheduled-export.test.ts failed 2 assertions because scheduled work used the SERVICE_ORIGIN host and selected a namespace when VAULT_OBJECT_NAME was missing. The focused OAuth callback test failed when it ignored a missing callback object name.

GREEN evidence: bun run docs:check passed. bun run check passed lint, documentation, all typechecks, 54 Worker test files (774 tests), 19 protocol test files (314 tests), 30 plugin test files (844 passed, 1 skipped), tooling tests (102 tests), and dry-run builds. Worker preflight passed. Focused object-name OAuth routing tests passed 2 tests. Deployment config tests passed 7 tests.

Remote rehearsal: an initial run failed to read the source Workers.dev endpoint with curl exit 56. Both named scripts were deleted successfully. A retry deployed vaultwire-rehearsal-a with an isolated SQLite Vault create migration, seeded synthetic cursor and file rows under vaultwire-rehearsal-stable-object, then transferred Vault to vaultwire-rehearsal-b without a destination create migration. The object ID, cursor, and file rows matched before and after. Wrangler deletion succeeded for both named scripts. No production deploy, zone request, R2/KV resource operation, or personal vault access occurred.

The earlier hostname-derived identity blocker is resolved by the approved stable binding. AC1 is now supported by the synthetic rehearsal. Keep this task In Progress pending parent review and publication. S17 placeholders and the production cutover guard remain unchanged.

Task review of approved object-name extension at 383ff04 returned APPROVE WITH NOTES. Production and development object-name selection, missing-name guards, transfer rehearsal and deletion evidence satisfy scope. One non-blocking test gap remains for final branch review: add explicit callback non-empty object-name drift and outer Worker fetch missing-name cases. Existing tests cover missing/empty callback names and direct consent. Runtime guards exist. Final review must assess this bounded gap before publication.

Final-review finding closure: added the requested callback object-name drift case with a different non-empty name. The callback returns invalid_grant, and the namespace spy confirms zero idFromName selections. Added outer Worker fetch checks for missing and empty names. Each asserts status 503, exact body `Vault object name is not configured`, cache-control `no-store`, and zero namespace selections.

Validation for this bounded test-only change: `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts -t 'fails closed at the Worker entry|rejects other provider identities'` passed 2 tests, exit 0. `bun run docs:check` passed, exit 0. `bun run check` passed, exit 0. It reported 54 Worker test files with 774 tests, 19 protocol files with 314 tests, 30 plugin files with 844 passed and 1 skipped, and 9 tooling files with 102 tests. The Worker F2 suite passed 145 tests.\n\nRehearsal version clarification: the remote rehearsal used Wrangler CLI 4.156.2. This repository pins Wrangler 4.45.0. The remote rehearsal does not directly qualify transfer behavior with the pinned CLI. Do not rerun the rehearsal in this test-only fix wave.

Final review closure: whole-branch review covered 383ff04 against origin/main 7ed19cc and approved with one bounded test gap. Corrective review covered 383ff04..8f8d0f7 and returned APPROVE. Both callback drift and outer-fetch missing/empty-name cases are ADDRESSED with exact failure and zero-namespace-selection assertions. No actionable finding remains. Parent inspected synthetic before/after snapshots and confirmed successful deletion messages for both rehearsal scripts. The parent also confirmed a clean worktree, unchanged origin/main and git diff --check. All acceptance criteria are checked. Hosted CI remains separate evidence. This task is complete within the supervisor scope. S17 placeholders and the production deploy guard stay in place.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Prepared the vaultwire Worker, bindings and Vault namespace transfer. Added VAULT_OBJECT_NAME at all nine selection sites, with the legacy production key and fail-closed guards. Local checks and synthetic development transfer passed. Wrangler confirmed deletion of both authorized rehearsal scripts. Independent reviews closed all findings. S17 placeholders and production deployment guards remain by owner decision. No production deploy or personal vault access occurred. Remote rehearsal used a temporary SQLite fixture and Wrangler 4.156.2 rather than pinned 4.45.0. PR 130 is the delivery record.
<!-- SECTION:FINAL_SUMMARY:END -->
