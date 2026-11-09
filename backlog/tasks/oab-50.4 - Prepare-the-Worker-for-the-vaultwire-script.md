---
id: OAB-50.4
title: Prepare the Worker for the vaultwire script
status: In Progress
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T15:49:00Z'
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
- [ ] #1 A development rehearsal transfers a Durable Object with synthetic journal data between two scripts and reads the same cursor and files after the transfer.
- [ ] #2 Deployment config tests pin the new script name, origin, bindings and migration.
- [ ] #3 bun run check and Worker preflight pass. No production deploy happens in this task.
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
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner brief: S19-vw-worker.md and V-COMMON.md allow development scripts and deploys only. No production deploy. File ownership excludes Worker source and infrastructure. Cutover blocker: apps/worker/src/index.ts selects Vault with idFromName(request host), and scheduled and OAuth paths use SERVICE_ORIGIN. The new hostname selects a different object despite namespace transfer. OAB-50.6 needs an explicit object-identity solution before production. Do not change these source files in this task.

Implementation results: Production Wrangler config now uses vaultwire, vaultwire.mmorillo.dev, the vaultwire R2 names, the named S17 KV and Access placeholders, and a transferred_classes migration from Vault in obsidian-ai-bridge. Both development configs keep independent create migrations and isolated names. The deploy workflow checks OAB-50.6 cutover authorization and unresolved placeholders before deployment. Local preflight removes transfer migrations and inserts a local Vault create migration.

Validation: Focused config test RED before implementation: 2 failed and 3 passed, with script-name and KV-placeholder mismatches. Focused config tests then passed 6 tests. Worker preflight test passed. bun run docs:check passed. bun run --filter '@obsidian-ai-bridge/worker' preflight passed. bun run check passed: lint, docs, all typechecks, test suites, and dry-run builds.

Development rehearsal blocker: Wrangler whoami exited 1. Its private output produced only the safe failure label unknown_wrangler_failure. No development scripts or Cloudflare resources were created. No production deploy or vault access occurred. The synthetic remote transfer rehearsal remains incomplete because this worktree has no usable Wrangler authentication.

Production cutover blocker: apps/worker/src/index.ts derives the Vault object key from the request host, while scheduled and OAuth paths use SERVICE_ORIGIN. Namespace transfer alone does not preserve the object selected by the new hostname. OAB-50.6 must resolve object identity before production deployment. No Worker runtime source changed.
<!-- SECTION:NOTES:END -->
