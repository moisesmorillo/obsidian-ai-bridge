---
id: OAB-25
title: Deploy the F2 Worker script from GitHub Actions on merge to main
status: To Do
assignee: []
created_date: '2026-10-28T16:19:00Z'
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
- [ ] #1 A `deploy.yml` workflow runs after a merge to main and after a manual `workflow_dispatch`, and it only runs for the repository owner as actor.
- [ ] #2 The workflow runs the same pinned Wrangler command as `docs/api/f2.md` from `apps/worker`, with `OWNER_SUBJECT` read from a GitHub secret and never printed in logs.
- [ ] #3 The Cloudflare token used by the workflow comes from an OpenTofu `cloudflare_account_token` in cloudflare-infra with Workers Scripts Write only, and its creation is recorded with the PR link in the task notes.
- [ ] #4 A deploy run is confirmed by the Worker version id in the run log and by a public check of `/.well-known/oauth-protected-resource` after the run.
- [ ] #5 `docs/api/f2.md` describes the CI deployment and keeps the manual command as the fallback.
<!-- AC:END -->
