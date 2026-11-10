---
id: OAB-60
title: Design a one-click Deploy to Cloudflare setup for self-hosted Vaultwire
status: To Do
assignee: []
created_date: '2026-11-10T18:18:00Z'
labels: []
dependencies: []
references:
  - https://developers.cloudflare.com/workers/platform/deploy-buttons/
  - https://developers.cloudflare.com/workers/ci-cd/builds
priority: medium
type: spike
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner wants anyone who finds the repository to install the whole Vaultwire infrastructure in their own Cloudflare account with one click, like the Deploy to Cloudflare buttons in Cloudflare template repos, and to learn about and apply later updates to their Worker. Known facts from the Cloudflare deploy-button docs (read 2026-11-10): the button clones a public GitHub or GitLab repo into the deployer's account, deploys through Workers Builds, and provisions KV, D1, R2, Durable Objects, Queues and Secrets Store from the Wrangler config; secrets are prompted from .dev.vars.example or .env.example. A subdirectory URL works only if the app is fully isolated in that subdirectory, but apps/worker imports the packages/protocol workspace. The docs do not cover Cloudflare Access, custom domains or routes, or any upstream update mechanism: the clone is an independent repo. Vaultwire production also depends on Cloudflare Access for the owner console and on OWNER_SUBJECT, and production infrastructure today lives in OpenTofu in the separate cloudflare-infra repo.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design note in the task states which Vaultwire resources the button can provision and which need another step (Access application and policy, owner identity, custom domain or workers.dev, secrets), with sources.
- [ ] #2 The design chooses how the Worker builds in isolation for the button (for example a generated standalone template repo or bundled protocol package) and how that artifact stays in sync with the monorepo.
- [ ] #3 The design states how a deployer learns about and applies updates (for example an upstream-sync workflow that opens pull requests in the clone, which Workers Builds deploys on merge), including Durable Object migrations and plugin and Worker version compatibility.
- [ ] #4 The design checks Workers Free plan limits for the full setup and lists what a deployer must do by hand.
- [ ] #5 The design lists the follow-up implementation tasks with acceptance criteria, and the owner approves it before implementation starts.
<!-- AC:END -->
