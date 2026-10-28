---
id: OAB-25
title: Deploy the F2 Worker script from GitHub Actions on merge to main
status: Done
assignee:
  - '@pi'
created_date: '2026-10-28T16:19:00Z'
updated_date: '2026-10-28T18:30:00Z'
labels:
  - F2
  - deployed-service
  - ci
  - needs-owner-authorization
dependencies: []
references:
  - .github/workflows/check.yml
  - >-
    backlog/tasks/oab-7.7 -
    Deploy-F2-service-and-Access-policy-with-owner-authorization.md
documentation:
  - docs/api/f2.md
type: chore
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F2 Worker script is deployed by hand from the owner Mac with the owner Wrangler OAuth session. PR #24 (f84a225) was deployed that way on 2026-10-28 after the merge. The owner session has full account rights, and a merged change stays unpublished until someone runs the command. The owner wants a deploy workflow so a merge to main publishes the script with a token that can only write Worker scripts. The token is born in the owner cloudflare-infra repository through OpenTofu, like the state token in `infra/tokens.tf`, and this repository only consumes it as a GitHub secret. `OWNER_SUBJECT` stays out of tracked files and arrives as a second GitHub secret. The current `check.yml` workflow runs checks and build only. The documented manual command lives in `docs/api/f2.md` and in the OAB-7.7 task notes. A deployment from CI is a deployed-service action and needs explicit owner authorization before the first run.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A `deploy.yml` workflow runs after a merge to main and after a manual `workflow_dispatch`, and it only runs for the repository owner as actor.
- [x] #2 The workflow runs the same pinned Wrangler command as `docs/api/f2.md` from `apps/worker`, with `OWNER_SUBJECT` read from a GitHub secret and never printed in logs.
- [x] #3 The Cloudflare token used by the workflow comes from an OpenTofu `cloudflare_account_token` in cloudflare-infra with Workers Scripts Write only, and its creation is recorded with the PR link in the task notes.
- [x] #4 A deploy run is confirmed by the Worker version id in the run log and by a public check of `/.well-known/oauth-protected-resource` after the run.
- [x] #5 `docs/api/f2.md` describes the CI deployment and keeps the manual command as the fallback.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the owner-approved plan in .pi/plans/oab-25-ci-deploy.md. Add an owner-only, main-only deployment workflow with shared production concurrency, pinned checkout and mise actions, frozen dependency installation, private Wrangler output capture, version summary, and a final public HTTP 200 check. Update docs/api/f2.md with CI as the normal path and the manual fallback. No product or production-config changes. No new workflow-test framework because the repository has no pattern. Run bun run check, independent task and branch reviews, and Plannotator branch review. Push and open a pull request. Do not deploy or dispatch. Keep criterion 4 pending until the first owner-authorized deployment.

Owner-approved scope addition: filter push deployments to apps/worker/**, packages/**, bun.lock, package.json, mise.toml, and .github/workflows/deploy.yml. Keep workflow_dispatch unfiltered. Document manual dispatch for merges outside those paths and test push-versus-dispatch path semantics with synthetic offline fixtures.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Token evidence: https://github.com/moisesmorillo/cloudflare-infra/pull/18. The owner confirms the OpenTofu account token has Workers Scripts Read and Write only. CLOUDFLARE_DEPLOY_TOKEN and OWNER_SUBJECT exist as repository secrets. Merge authorizes the first CI deployment. This task does not authorize a local deployment.

Owner-approved scope addition: push path filter is exactly apps/worker/**, packages/**, bun.lock, package.json, mise.toml, and .github/workflows/deploy.yml. workflow_dispatch has no paths filter. docs/api/f2.md says merges outside these paths do not deploy and the owner can dispatch manually. Synthetic fixtures covered success, missing and invalid version IDs, ambiguous version IDs, deployment failure, each missing secret, HTTP 200, non-200, redirect, network failure, and push-versus-dispatch path semantics. No existing workflow-test pattern was found. No workflow-test framework or dependency was added. Criterion 4 remains unchecked pending the first owner-authorized CI deployment. No local deploy or dispatch occurred.

Baseline: bun install --frozen-lockfile and bun run check passed before changes. Final checks passed: bun run docs:check and bun run check. The final suite ran 74 test files with 1,208 tests, and all workspace builds passed. Shellcheck passed both workflow scripts. Ruby parsed workflow YAML, and git diff --check passed. The temporary offline fixtures passed 11 shell cases plus exact path-filter checks. Direct execution of extracted workflow scripts was blocked by the command safety gate, so fixture cases exercised equivalent shell decision behavior rather than invoking the extracted workflow scripts.

Independent task review and final whole-branch review examined revision ff65b35aba3d06023af9accb62e1c4ef17f416a5 against main 935d42f. Both found no actionable defect. Documentation scope: workflow behavior, docs/api/f2.md, and task notes. Structural candidate: deploy.yml coherently owns deployment orchestration, actor and ref gates, concurrency, private output capture, and public status checks. No TypeScript changed. Reviewers examined worker validation evidence without test reruns. Limits: equivalent-shell fixtures, no real deployment, and no remote public check. No findings need closure. Criterion 4 stays pending until the first owner-authorized deployment.

First CI deployment 2026-10-28: run https://github.com/moisesmorillo/obsidian-ai-bridge/actions/runs/40745615356 on merge commit 2333123 (PR #28), event push, actor owner. All steps succeeded. The Deploy Worker step printed "Deployed Worker version: 196df3e7-c7c3-4d98-ba7b-906a0cfc5f9f" and the job summary carries the source revision. The last step returned HTTP 200 from /.well-known/oauth-protected-resource. Public checks after the run: the metadata lists scopes_supported vault:read and vault:write, /authorize and /owner/clients still answer 302 to Access. No secret value appeared in the log. The owner assistant verified the run with gh run view and curl.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The F2 Worker now deploys from GitHub Actions. deploy.yml runs on push to main for the six deployment paths and on manual dispatch, owner-only, with one production concurrency group. It uses the pinned Wrangler command with CLOUDFLARE_DEPLOY_TOKEN (OpenTofu token with Workers Scripts Read and Write, delivered by cloudflare-infra PR #18 through a GitHub App) and the OWNER_SUBJECT secret. The first run deployed version 196df3e7-c7c3-4d98-ba7b-906a0cfc5f9f and the public metadata check passed. docs/api/f2.md keeps the manual command as the fallback. check.yml now runs once per pull request. Risk: the token covers every Worker script in the account, not only this one.
<!-- SECTION:FINAL_SUMMARY:END -->
