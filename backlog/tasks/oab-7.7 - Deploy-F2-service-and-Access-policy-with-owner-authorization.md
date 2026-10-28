---
id: OAB-7.7
title: Deploy F2 service and Access policy with owner authorization
status: Done
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-28T02:55:00Z'
labels:
  - F2
  - needs-owner-authorization
  - deployed-service
dependencies:
  - OAB-7.6
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7700
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Needs explicit owner authorization in the current execution conversation before service deployment or any Cloudflare resource change. Task creation and plan approval grant no such authorization. Use only an authorized synthetic vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Owner authorization names the permitted environment, resource operations, Access settings, and synthetic test data before any remote change.
- [x] #2 Authorized deployment configures OAuth storage, service bindings, Access protection, identity claims, redirect addresses, and discovery endpoints.
- [x] #3 Deployed checks prove unauthorized requests fail closed and Access cannot be bypassed. No personal vault is accessed.
- [x] #4 Record the deployed revision and actual remote results in task notes. Local tests are not substituted for deployed evidence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the revised docs/superpowers/plans/2026-10-25-oab-7.7-f2-deployment.md as the single branch plan. OpenTofu in cloudflare-infra owns KV, R2, the Workers custom domain, Access application, and policy. Wrangler deploys only obsidian-ai-bridge-f2 with bindings to owner-supplied outputs. Declare no routes or custom domain. Revise tests, validate, and commit now. Do not deploy until the owner supplies the KV ID, R2 bucket name, Access team domain, AUD, owner subject, and infrastructure readiness confirmation in this session.

Owner supplied the deployment inputs and revised readiness order. Bind the existing KV namespace and R2 bucket, deploy only obsidian-ai-bridge-f2 with no routes, then report deployment identifiers. The owner attaches the custom domain through OpenTofu afterward. Public verification waits for that confirmation. Treat the supplied owner subject as unconfirmed until the first Access login.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The owner previously authorized OAB-7.7 service resource changes. OpenTofu in cloudflare-infra owns KV namespace oab-f2-oauth, R2 bucket oab-f2-immutable-blobs, custom domain obsidian-bridge.mmorillo.dev, and the Access application and policy. This repository must not provision or change those resources through Wrangler, API, or OpenTofu. Do not use an API token. No remote calls or deployment occurred in this revision.

Wrangler may deploy only script obsidian-ai-bridge-f2. The production config declares no route or custom domain and keeps workers_dev and preview_urls false. Task 2 will add the owner-supplied KV ID and confirmed R2 bucket name after the owner sends OpenTofu outputs. The expected R2 bucket name is oab-f2-immutable-blobs, pending owner confirmation.

The owner must send ACCESS_TEAM_DOMAIN, ACCESS_AUDIENCE, OWNER_SUBJECT, infrastructure readiness confirmation for account cb1688e69610249def9ac8e0448d5040, and Access readiness confirmation before deployment. Supply auth settings as Worker variables during script deployment. Do not use standalone secret-write commands. Preserve synthetic-vault restrictions and stop before OAB-7.8.

Independent scope-revision review approved commit 3aff33fa19ebbc46c9c200dc7a98675606569243 with no actionable findings. Reviewed config, existing deployment-config test, revised single plan, API production section, and task notes. OpenTofu ownership and the Wrangler script-only boundary match the owner instruction. Worker reported focused RED/GREEN, docs:check, pinned local dry run, and full bun run check passed. Reviewer did not rerun checks. No remote changes or deployment occurred. Await owner outputs and readiness confirmations in this session before deployment.

Owner input file received in this session. Account cb1688e69610249def9ac8e0448d5040, KV afb1eaa5d1e444e98fd3b7c705d26d5f, R2 oab-f2-immutable-blobs, Access issuer https://mmorillo.cloudflareaccess.com. Owner supplied AUD and owner subject. The subject comes from the Access user list, not a verified JWT. Keep exact-subject authentication and report a mismatch at first login. Owner explicitly authorizes script-first deployment because the custom domain does not exist yet. Do not attach it here. Report script deployment so the owner can add the domain through cloudflare-infra. Owner confirms Access application Obsidian AI Bridge F2 protects /authorize and /owner/* with owner-only Email OTP. External path checks remain pending. No personal vault access. Stop before OAB-7.8.

Task 2 inputs are received and bound to the production config. Updated deployment-config tests first. The test run failed on the missing account and KV ID, then passed after the config update. docs:check and bun run check passed. The first full check included untracked .unipi content, so it failed Biome; rerun passed after temporarily stashing and restoring .unipi unchanged. Wrangler 4.45.0 production dry run listed the supplied KV ID, R2 name, and auth variables. No route or custom domain appeared. No deployment yet.

Task 2 deployed script obsidian-ai-bridge-f2. Exact command from apps/worker: bunx --no-install wrangler deploy --config wrangler.production.jsonc. Exit code 0. UTC start 2026-10-28T00:50:02Z. Source Git SHA 5ab265b8c0ee4835e48ca265518f80f744597dcd. Wrangler 4.45.0 OAuth session selected account Professional - Homelab Account, ID cb1688e69610249def9ac8e0448d5040. Worker Version ID 066110dc-be65-460d-9883-cb7bf4c5dbfe. Deployment output listed VAULTS (Vault), OAUTH_KV KV namespace afb1eaa5d1e444e98fd3b7c705d26d5f, R2_BUCKET oab-f2-immutable-blobs, canonical SERVICE_ORIGIN, and supplied Access variables. Output reported 'No deploy targets for obsidian-ai-bridge-f2'. Config keeps workers_dev=false and preview_urls=false, with no routes or custom domain. No alternate URL or public endpoint was probed. Custom domain is not attached. Owner must attach obsidian-bridge.mmorillo.dev through OpenTofu, then confirm readiness before public verification. OWNER_SUBJECT is from the Access user list, not a verified JWT. Confirm exact sub at first Access login. No authenticated client flow or personal vault access occurred. Stop before OAB-7.8.

Correction: the earlier Task 2 validation note ended with 'No deployment yet' because it was recorded before the authorized deployment. The deployment record in the next note supersedes that pre-deployment status.

Task 2 review correction: Reviewer raised a MAJOR finding because the prior report omitted the effect and authority of migrations.new_sqlite_classes=["Vault"]. Read-only Worker service metadata GET succeeded with migration_tag v1 at 2026-10-28T00:57:01.500444Z. Read-only script-settings GET confirmed VAULTS class Vault namespace 8ed8f69160404986a33eefa5ab6d4be5 at 2026-10-28T00:56:42.775763Z. Evidence is in .superpowers/sdd/2026-10-25-oab-7.7-f2-deployment/script-migration-evidence.json and script-settings-evidence.json. The approved plan includes the existing SQLite migration. Reviewed OpenTofu revision 3aff33f permits this Worker script, migration, and bindings. OpenTofu-owned resources are KV, R2, custom domain, and Access. Wrangler applied migration v1 and created/bound the script-owned Vault Durable Object namespace. We did not create or change any listed OpenTofu-owned resource. No config/test edit, remote mutation, redeployment, or public check occurred for this correction. docs/api/f2.md and task-2-report.md now state these facts and authority. The custom domain remains pending owner attachment.

Authority citation: the approved source plan is docs/superpowers/plans/2026-10-25-oab-7.7-f2-deployment.md, section 'Owner scope change and authority'. It permits the existing SQLite migration and bindings, while its OpenTofu-owned resource list covers KV, R2, custom domain, and Access. The reviewed OpenTofu revision 3aff33f has the same script-plus-migration boundary.

Task 2 independent corrective review approved documentation revision 67dc22dcf9023950f6f779ee77352b5b6439e6ed. Migration-effect finding closed with read-only Worker metadata and explicit authority for the retained Vault migration. No new findings. Deployed source remains 5ab265b8c0ee4835e48ca265518f80f744597dcd and Worker version 066110dc-be65-460d-9883-cb7bf4c5dbfe. Domain attachment through cloudflare-infra and external checks remain pending. No redeployment or remote mutation occurred during correction.

Task 3 independent public verification on 2026-10-28 at 02:07 UTC. Owner confirmed OpenTofu attached proxied DNS for obsidian-bridge.mmorillo.dev to obsidian-ai-bridge-f2 production. Source 5ab265b8c0ee4835e48ca265518f80f744597dcd, Worker version 066110dc-be65-460d-9883-cb7bf4c5dbfe. Eighteen bounded HTTPS probes used 8-second timeouts and 16,384-byte response caps with no redirect following or cookies. Both canonical OAuth discovery documents returned 200 and matched the canonical issuer/resource/endpoints. GET /authorize returned 302 to HTTPS mmorillo.cloudflareaccess.com at /cdn-cgi/access/login/obsidian-bridge.mmorillo.dev. Safe metadata parsing matched the expected AUD, canonical hostname, and /authorize destination. GET /authorize/consent, /owner/clients, and /owner/clients with a forged Cf-Access-Jwt-Assertion returned 302 to Access. GET /owner returned 404 with no application content; the API contract documents /owner/clients, not a root handler. REST /v1/vault and MCP /mcp returned 401 both without bearer and with invalid bearer. MCP requests used application/json and Accept application/json, text/event-stream. Invalid /oauth/register returned 400 OAuth error; invalid /oauth/token returned 401 OAuth error. The known workers.dev hostname returned 404 for both discovery documents, owner, REST, and MCP. Production config has preview_urls=false and deploy output emitted no preview URL; none was probed. Full probe matrix and limits: .superpowers/sdd/2026-10-25-oab-7.7-f2-deployment/task-3-report.md. No Access policy content, login, consent, client flow, or authenticated vault operation was tested. OWNER_SUBJECT remains unconfirmed against a verified JWT. Keep OAB-7.7 and OAB-7.8 open; no F2 exit claim. Existing parent notes remain intact.

Task 3 documentation validation: bun run docs:check passed after documentation updates. First bun run check failed only because Biome included the pre-existing untracked .unipi/config/settings-version.json. Reran bun run check with only .unipi temporarily stashed, then restored it unchanged by SHA-256 comparison. The rerun passed lint, docs, all four workspace type checks, 852 test cases across 74 test files, and plugin/protocol/worker builds. No test files changed. Task remains In Progress. Parent retains acceptance, independent review, and publication.

Validation count correction: the full suite passed 1,203 tests across 74 files, not 852. The test group counts were tooling 55, plugin 2, protocol 282, and worker 643 + 120 + 101.

Independent Task 3 review approved commit 46e8491bede5385c18a74c81eb92e698fcd7bfff with no actionable findings. The reviewer checked public-response claims against Worker route contracts and documented evidence. Bare /owner has no handler and returned a safe 404. Implemented /owner/clients redirected to Access. Limits remain explicit: no authenticated flow, JWT-sub confirmation, Access policy inspection, revocation, personal vault, or F2 exit proof. Whole-branch review and publication remain pending.

Task 4 local acceptance review. Checked AC #1 based on the owner-authorized account and operation boundary in the approved plan and notes: Wrangler may deploy only the named Worker and its existing migration/bindings; OpenTofu owns KV, R2, custom domain, Access app/policy; Access protects /authorize and /owner/* for owner-only Email OTP; use synthetic data only and do not access a personal vault. Checked AC #2 based on production config and read-only deployment settings/migration evidence, owner confirmation of OpenTofu domain and Access setup, and public discovery matching the canonical issuer/resource/endpoints. OWNER_SUBJECT is configured but not confirmed against a verified JWT. Checked AC #3 only for the tested public boundary: unauthenticated and invalid-bearer REST/MCP denials, protected route redirects, a forged assertion denial, OAuth protocol errors, and no service response from the known workers.dev hostname. These bounded probes do not prove every possible Access bypass or authenticated client behavior. Checked AC #4 from the recorded source SHA 5ab265b8c0ee4835e48ca265518f80f744597dcd, Worker version 066110dc-be65-460d-9883-cb7bf4c5dbfe, and actual external statuses. No criterion was weakened. Task remains In Progress pending whole-branch human review and publication.

Final whole-branch review approved revision 8cf77dd3f4673ae75182ca01e5088363ac14001a against main 9c45682ee9f46a24668c0baacef0906db212af0e. Reviewer inspected all six changed files, authority boundaries, configuration tests, deployment and public evidence, documentation semantics, and prior finding closures. No actionable findings remain. Reviewer ran docs:check and diff check successfully and reviewed the worker full-check result of 1203 tests across 74 files. Authenticated client use, revocation, first-login subject comparison, and F2 exit remain OAB-7.8 obligations. Human branch review, publication, and remote CI remain pending.

Public branch review correction: remove the owner subject from tracked production config, deployment tests, plan text, and unpublished branch history. Keep exact-subject verification unchanged. The owner supplies the value locally through the environment or an ignored local file. Pinned Wrangler deployment must use the explicit nonempty shell guard shown in the API guide and branch plan. CI checks and builds only, so no GitHub deployment secret is needed. Ignore .unipi/ without changing its local content. Preserve other deployment identifiers and the historical source revision and Worker version. No redeployment or Cloudflare change is authorized or performed for this correction.

Final documentation consistency correction: the Task 2 future-deployment example in the existing plan now includes the explicit nonempty OWNER_SUBJECT shell guard. The historical deployment command and source SHA remain historical facts. Human review pn-625da3 contained only the two approved findings. The owner approved option 1. The scoped reviewer approved both corrections at c3cbc14. Mark both comments addressed. No source/runtime change, redeployment, or Cloudflare operation occurred. Authenticated client behavior, owner-subject confirmation against a verified JWT, and F2 exit remain outside this task. Push, pull request, remote CI, and worktree cleanup remain pending.

Final correction validation: bun run docs:check passed. bun run check passed with lint, docs, all four workspace type checks, 1,204 tests across 74 files, and builds. The check ran with .unipi/ present and ignored. Its settings-version.json SHA-256 remained b9f64b5acb865d00ab4e108df212fe01a413df83db8a1da9ba965201b2991a8f. A scan against the original owner input found no owner-subject value in tracked files. No source/runtime changes, redeployment, or Cloudflare operation occurred. Original deployed source remains 5ab265b8c0ee4835e48ca265518f80f744597dcd and Worker version remains 066110dc-be65-460d-9883-cb7bf4c5dbfe. No authenticated client flow or F2 exit claim. Push, PR, remote CI, and worktree cleanup remain pending.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed OAB-7.7 after deployed evidence, the owner-approved corrections, and scoped branch review. The plan and public deployment guide now use the guarded owner-subject override. The owner subject is absent from tracked files and sanitized branch history. Exact-subject runtime verification and the deployed Worker version remain unchanged. bun run docs:check and bun run check passed, including 1,204 tests across 74 files. No deployment or Cloudflare change occurred. No authenticated client flow or F2 exit claim. Push, pull request, remote CI, and worktree cleanup remain pending.
<!-- SECTION:FINAL_SUMMARY:END -->
