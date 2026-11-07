---
id: OAB-12.2
title: Add a Worker startup preflight before deploy and a sanitized failure class
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T00:13:00Z'
updated_date: '2026-11-07T01:07:00Z'
labels: []
dependencies: []
parent_task_id: OAB-12
ordinal: 71000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PR #79 passed checks but failed deployment because module evaluation called crypto.randomUUID(). Deploy logs hid the runtime error. CI must test production startup without credentials and expose only fixed safe failure labels.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every PR starts the production bundle in the local Workers runtime. Module evaluation errors fail the check and print the exact known error class.
- [ ] #2 Wrangler deploy failures print only fixed known failure labels. Logs never include raw lines, URLs, ids, tokens, or response bodies.
- [ ] #3 The startup preflight needs no Cloudflare credentials and makes no Cloudflare resource change.
- [ ] #4 The local preflight documents and drops the unsupported unhandled_rejection_after_microtask_checkpoint flag in a temporary config, or proves local support.
- [ ] #5 bun run check passes. Task, branch, and owner reviews pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan gate: /tmp/CI1-deploy-preflight-plan.md. Build the production bundle with credential-free Wrangler dry-run. Start Node Wrangler locally with temporary HTTPS loopback configuration, a fixed test owner placeholder, and the unsupported compatibility flag removed only locally. Verify public metadata with fixed deadlines. Use one fixed-label classifier for startup and deploy failures. Add RED/GREEN tests first, run bun run check and real preflight, complete task and branch reviews, publish one PR, and remove the worktree.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner CI1 brief authorizes this CI task under OAB-12 despite gate dependencies. Common F5 copy-vault authorization date: 2026-11-06. This task needs no vault access, live-service case, deployment, or Cloudflare resource change.

Planning probes: baseline bun run check passed. Dry-run production bundle succeeded without credentials. Local runtime rejects unhandled_rejection_after_microtask_checkpoint. The production bundle serves metadata with HTTP 200 through HTTPS loopback and a fixed test-only owner placeholder. A temporary forbidden global call produces Disallowed operation called within global scope. Bun execution of the Wrangler CLI caused request timeouts. Node execution reached the Worker. No product source changed.

Owner approved plan pn-e0aea4. Supervisor override: no use of any vault or live service. Both dev vault clients are revoked. This CI task uses only tests, fakes, and isolated loopback runtime. Implementer commit c4b4943 adds preflight and failure labels. Reported RED: missing classifier and checkMetadata imports failed with observed exit 1 before implementation. Reported GREEN: focused Bun script tests, docs:check, actual credential-free preflight, and bun run check passed. Full check covered 2085 passing Vitest tests and one skipped test plus Bun script assertions. Task review is active. Local startup does not prove production resource permissions or deployment success.

Task corrective review 6eae6234 approved c5f4c69 after c4b4943. Closed all six findings: preserve supported flags, classifier-only safe output, exact fixed known classes, explicit dotenv isolation, bounded descendant process cleanup, and scoped tooling imports. Regressions first failed for flag filtering, exact class text, safe error output, and descendant cleanup. Focused Bun tests, docs:check, env -i PATH="$PATH" bun run preflight, and bun run check then passed. No product code changed. Rebased without conflict onto origin/main 4b6bc04. New code head f988360. Worker validates combined code before final review. Import decision: retain @worker/../tooling because no direct Worker tooling alias exists. No alias configuration changed.
<!-- SECTION:NOTES:END -->
