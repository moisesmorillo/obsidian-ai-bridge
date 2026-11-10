---
id: OAB-60
title: >-
  Design self-hosted Vaultwire setup: Deploy to Cloudflare button versus
  OpenTofu recipe
status: To Do
assignee: []
created_date: '2026-11-10T18:18:00Z'
updated_date: '2026-11-10T18:23:00Z'
labels: []
dependencies: []
references:
  - https://developers.cloudflare.com/workers/platform/deploy-buttons/
  - https://developers.cloudflare.com/workers/ci-cd/builds
  - https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs
priority: medium
type: spike
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The owner wants anyone who finds the repository to install the whole Vaultwire infrastructure in their own Cloudflare account with one click, like the Deploy to Cloudflare buttons in Cloudflare template repos, and to learn about and apply later updates to their Worker. Known facts from the Cloudflare deploy-button docs (read 2026-11-10): the button clones a public GitHub or GitLab repo into the deployer's account, deploys through Workers Builds, and provisions KV, D1, R2, Durable Objects, Queues and Secrets Store from the Wrangler config; secrets are prompted from .dev.vars.example or .env.example. A subdirectory URL works only if the app is fully isolated in that subdirectory, but apps/worker imports the packages/protocol workspace. The docs do not cover Cloudflare Access, custom domains or routes, or any upstream update mechanism: the clone is an independent repo. Vaultwire production also depends on Cloudflare Access for the owner console and on OWNER_SUBJECT, and production infrastructure today lives in OpenTofu in the separate cloudflare-infra repo.

Owner addition 2026-11-10: compare the button with a second option, an OpenTofu/Terraform recipe plus a written guide in this repo, so each deployer provisions only what they need. The Cloudflare provider can manage Access applications and policies, DNS, custom domains, R2 and KV, which the button does not cover. Durable Objects come from Worker migrations at wrangler deploy, so a recipe likely combines OpenTofu for account resources with Wrangler for the Worker. The owner's production already uses OpenTofu in the separate cloudflare-infra repo. Updates with a recipe are manual (pull, tofu apply, wrangler deploy).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A design note in the task states which Vaultwire resources the button can provision and which need another step (Access application and policy, owner identity, custom domain or workers.dev, secrets), with sources.
- [ ] #2 The design compares the Deploy to Cloudflare button and an OpenTofu/Terraform recipe with a guide on: provisioned resources, Access, custom domain, monorepo fit, optional components, update path, Workers Free limits, deployer skill, and maintenance cost.
- [ ] #3 For each option the design states how a deployer learns about and applies updates, including Durable Object migrations and plugin and Worker version compatibility.
- [ ] #4 The design recommends one option or an ordered combination, and for the button states how the Worker builds in isolation from the monorepo.
- [ ] #5 The design lists what a deployer must do by hand and the follow-up implementation tasks with acceptance criteria, and the owner approves it before implementation starts.
<!-- AC:END -->
