---
id: OAB-50.4
title: Prepare the Worker for the vaultwire script
status: In Progress
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:16:00Z'
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
## Goal and design
Prepare the vaultwire script without a production deploy. Keep the pinned Wrangler migrations flow. Transfer the existing Vault namespace instead of creating an empty destination.

## Global constraints
Edit only the three Worker Wrangler configs, .github/workflows/deploy.yml, deployment-config tests, preflight tooling/tests, and this task. No production deploy, personal vault access, infrastructure changes, or new dependencies. Preserve protocol and storage invariants.

## Owner decisions
The owner skips Plannotator for this task. Development scripts and deploys with synthetic data are allowed by S19. Keep CLOUDFLARE_DEPLOY_TOKEN as the GitHub secret key. S17 supplies its replacement token value. Use PENDING_S17_VAULTWIRE_OAUTH_KV_ID and PENDING_S17_VAULTWIRE_ACCESS_AUDIENCE until infrastructure outputs exist. Fail closed in the deploy workflow while placeholders or the host-identity cutover blocker remain. Do not change source files outside ownership.

## Task 1: Worker script, bindings and namespace transfer
- [ ] Add deployment-config assertions for vaultwire, https://vaultwire.mmorillo.dev, vaultwire-blobs, vaultwire-backups, named S17 placeholders, and one transferred_classes migration from Vault in obsidian-ai-bridge to Vault. Reject destination create migrations.
- [ ] Run the focused tests before implementation. Record the expected failing assertions.
- [ ] Change production config and development config names. Development configs create isolated local Vault namespaces, never transfer production data.
- [ ] Change deploy workflow labels and metadata URL. Keep owner/main gates and safe output handling. Add an explicit cutover guard so merging cannot deploy production accidentally.
- [ ] Make preflight replace the remote transfer migration with an isolated local create migration. Test this distinction and credential isolation.
- [ ] Rehearse on two unique development scripts using synthetic SQLite journal data. Keep the same object key across the transfer. Compare cursor and files before and after. Also establish that a new host-derived key selects a different object. Never query production data.
- [ ] Run bun run docs:check, bun run check and bun run --filter @obsidian-ai-bridge/worker preflight. Commit scoped changes and actual evidence in task notes.
- [ ] Run independent task review and whole-branch review. Rebase on origin/main, open one PR, and remove the worktree. Use a draft PR if rehearsal or the source-code identity dependency blocks completion.

## Platform evidence and review focus
Cloudflare official documentation: https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#transfer-migration . transferred_classes uses from, from_script and to. The destination must export the class and must not create it first. Migration tags are ordered and apply once. Transfer is atomic and cannot use gradual deployment. Existing source bindings forward after transfer but need updated config before their next deploy. Current docs prefer exports for new tools, but the existing pinned Wrangler 4.45.0 and owner brief use supported migrations. No tool upgrade belongs here.
Review remote versus local migration separation, credential isolation, placeholder blocking, hostname-derived object identity, and unchanged production resources.

## Approved scope extension
Supervisor decision: add VAULT_OBJECT_NAME and use it at every production idFromName call. Production keeps obsidian-bridge.mmorillo.dev as the stable object name. Development configs use isolated object names. Fail closed when absent. Add RED/GREEN tests for REST, measurements, owner registry, exports, garbage collection, scheduled exports, OAuth token exchange, and consent selection. Keep SERVICE_ORIGIN for origin and auth checks only. Add binding typing and the test fixtures needed for this change. Do not expand unrelated runtime behavior.

The supervisor authorizes only vaultwire-rehearsal-a and vaultwire-rehearsal-b for the remote rehearsal. Wait for a second message that confirms the token file exists. Read its contents only through the specified CLOUDFLARE_API_TOKEN command substitution. Never print or persist it. Deploy synthetic source data, transfer to the destination script, compare the same object cursor and files, and delete both scripts at the end. S17 placeholders stay. Continue PR 130 on the same branch. Mark the PR ready only after the remote rehearsal passes. Run local full checks and independent review after code changes.
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
<!-- SECTION:NOTES:END -->
