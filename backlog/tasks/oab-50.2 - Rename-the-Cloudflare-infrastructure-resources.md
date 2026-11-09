---
id: OAB-50.2
title: Rename the Cloudflare infrastructure resources
status: Done
assignee:
  - '@pi'
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:05:00Z'
labels:
  - rename
  - infra
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 87000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository cloudflare-infra (OpenTofu, owner merge applies). Create the new resources next to the old ones: R2 buckets `vaultwire-blobs` (prevent_destroy) and `vaultwire-backups` (same lifecycle as oab-backups), KV namespace `vaultwire-oauth`, Access application, policy and one-time PIN identity provider named for Vaultwire and covering `vaultwire.mmorillo.dev`, and deploy token `vaultwire-github-deploy` with the same permissions plus access to the new buckets. The Workers custom domain for the new hostname attaches at cutover. Rename Terraform addresses and files from oab and obsidian_ai_bridge to vaultwire with moved blocks where the resource survives. Old buckets, KV, domain and token stay until the decommission task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The plan creates the new resources and moves addresses without destroying any existing resource.
- [x] #2 Offline tests pin the new names and the old names that must survive until decommission.
- [x] #3 Outputs expose the new bucket names, KV id, hostname and Access audience for the Worker task.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal
Add Vaultwire resources without a live change outside the infrastructure PR.

## Design and owner decisions
Preserve all old remote names, policies, paths, token values and the current GitHub secret destination and token reference. A secret rotation would add an update, so defer rotation to cutover. Use vaultwire_legacy addresses for retained old resources, with moved blocks. Move the shared Zero Trust organization to vaultwire without a remote change. Keep historical F2 move chains. The new deploy token keeps the existing account-wide script and R2 read permissions. These permissions already cover both new buckets. Do not add a new custom domain, Worker or DNS record. The owner skips Plannotator and authorizes PR publication only. No merge, deploy, backend access or Cloudflare API call.

## Implementation plan
- [ ] Add offline regression tests for exact new names, retained old resources, move chains, account scope, secret stability, Access paths and outputs. Observe failures before HCL changes.
- [ ] Rename the three service HCL files to vaultwire names. Preserve old resources under vaultwire_legacy addresses. Add two buckets, backup lifecycle, KV, Access IdP, policy, application and deploy token. Expose bucket names, KV id, hostname, Access audience and team URL.
- [ ] Run the complete Python suite, compilation, CLI help and whitespace checks. Use CI for pinned OpenTofu formatting, validation and the live PR plan. No local OpenTofu installation is necessary.
- [ ] Run one task review and one complete branch review. Rebase, push and open the infrastructure PR. Read only bounded CI summaries. The plan must show creates and moves with zero updates or destroys.
- [ ] Record evidence and the PR link through the Backlog CLI. Open a separate task-only PR against obsidian-ai-bridge main. Remove both worktrees and report both PRs.

## Review focus
Preserve old identities and import/move chains. Keep exact backup retention values: 15-day expiry and 7-day multipart abort. Preserve owner-only Access with authorize and owner paths. Keep deploy credentials out of outputs. Preserve provider pins and CI credential boundaries.

## Feasibility and limits
Public Cloudflare documentation describes account-wide R2 scope. The current deploy policy uses this scope, so no new permission is needed. No live Access or token creation probe is authorized. CI can check schema and the plan but cannot prove successful creation of a second one-time PIN IdP. OpenTofu is absent locally. CI must supply formatting, validation and plan evidence.

## Owner correction before merge
Cloudflare allows one One-time PIN IdP per account. Reuse the current provider rather than create another. Add a move from vaultwire_legacy_onetimepin to vaultwire_onetimepin. Change its display name to Vaultwire One-time PIN. Point both Access applications to that resource. Keep the earlier F2 and OAB move chain. Update tests before HCL, then run all offline checks. Review the correction and push to infrastructure PR 26. The revised acceptance gate is seven creates, moves, one in-place IdP name update and zero destroys. This owner decision supersedes the earlier separate-IdP design and zero-update gate.

## Completion
All implementation, failing-first tests, offline checks, reviews and final CI checks are complete. The bounded CI summary meets the corrected owner gate. The task-only PR carries this record. Cutover and decommission remain separate tasks.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Task review of 599e684 found one blocker: duplicate cloudflare_zero_trust_organization.vaultwire declarations. The worker will remove the second declaration and add a duplicate-address regression. The review also found stale one-day multipart prose. The configured lifecycle uses seven days. The correction will preserve those configured values. No live access ran. Secret rotation remains cutover work because it would add a resource update.

Infrastructure PR: https://github.com/moisesmorillo/cloudflare-infra/pull/26. Final head: 1b15551. The worker corrected the duplicate organization in 920db39 and added a failing-first uniqueness regression. The final whole-branch review approved with two documentation notes. Commit 1b15551 corrects both notes: the secret address is github_actions_secret.vaultwire_deploy, and the suite discovered 117 tests with 116 passes and one skip. Compilation, CLI help and whitespace checks passed. OpenTofu is absent locally. CI formatting, validation and the actual plan remain pending. The task-only worktree passed bun install --frozen-lockfile and bun run check. The Worker build used dry-run mode and did not deploy. No live Cloudflare, backend or vault access ran.

Owner correction: the initial design treated the One-time PIN IdP as a per-service resource. Cloudflare limits it to one per account. Reuse the existing IdP and change its display name in place. Both applications must reference it. The owner authorizes this one update. No apply ran.

The singleton regression failed against the earlier two-IdP configuration. Commit d6dee80 removes the duplicate create, preserves the existing IdP through the full move chain, changes its display name, and points both Access applications to it. The full offline suite discovered 118 tests: 117 passed, one skipped because OpenTofu is absent, zero failures. Compilation, CLI help and whitespace checks passed. Acceptance criteria 2 and 3 now have focused offline test evidence. The final CI plan still needs to confirm seven creates, moves, one IdP name update and zero destroys.

The scoped corrective review approved d6dee80 with no actionable finding. The parent pushed that commit to infrastructure PR 26. The final CI checks now run for the corrected singleton configuration. The owner controls merge and apply.

Final CI passed for d6dee80db823e2750d6d4f80752d55156233d1e0. Plan run: https://github.com/moisesmorillo/cloudflare-infra/actions/runs/42650937582. The bounded plan summary confirms 0 imports, 7 creates, 1 update, 0 deletes, 11 moves, 0 forgets and 6 output changes. The only planned update changes the shared IdP name. Three refresh observations do not add planned mutations. CI Python 3.11, Python 3.15, OpenTofu formatting and validation, plan and summary publication all passed. The plan uses head d6dee80, base 6ab2c94 and merge e1d96b86f595e2a4c14208bcdd7d97e1792dca49. No apply or deployment ran. The owner controls merge and the normal CI apply. Cutover owns domain attachment and token rotation.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the Vaultwire buckets, lifecycle, KV, Access application, owner policy and deploy token through cloudflare-infra PR 26. Retained old resources with move chains. Reused the single One-time PIN IdP for both applications and changed its display name. Final CI confirms seven creates, eleven moves, one in-place name update and zero destroys. Offline checks and both review stages passed after corrections. No local live access, apply, deployment or vault access ran. The owner controls merge.
<!-- SECTION:FINAL_SUMMARY:END -->
