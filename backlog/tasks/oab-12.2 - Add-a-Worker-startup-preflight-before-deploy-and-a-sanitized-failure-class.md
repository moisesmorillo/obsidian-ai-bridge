---
id: OAB-12.2
title: Add a Worker startup preflight before deploy and a sanitized failure class
status: Done
assignee:
  - '@pi'
created_date: '2026-11-07T00:13:00Z'
updated_date: '2026-11-07T01:55:00Z'
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
- [x] #1 Every PR starts the production bundle in the local Workers runtime. Module evaluation errors fail the check and print the exact known error class.
- [x] #2 Wrangler deploy failures print only fixed known failure labels. Logs never include raw lines, URLs, ids, tokens, or response bodies.
- [x] #3 The startup preflight needs no Cloudflare credentials and makes no Cloudflare resource change.
- [x] #4 The local preflight documents and drops the unsupported unhandled_rejection_after_microtask_checkpoint flag in a temporary config, or proves local support.
- [x] #5 bun run check passes. Task, branch, and owner reviews pass.
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

Final branch review reopened R4. Wrangler 4.45.0 parses the global --env-file option, defaults to .env and .env.local in cwd, then assigns loadDotEnv output to process.env. CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false controls only the Worker binding loader. Both build and dev preflight launches now pass --env-file /dev/null and retain the sanitized child environment. Bun assertions cover both launch argument lists and fake inherited token and owner values. The safety guard blocked creation of a fake .env fixture. No alternate fixture was made. The hostile-dotenv runtime fixture remains an evidence limit. No vault, live-service, owner credential, deployment, or Cloudflare resource action occurred.

Final validation details: bun test/deploy-preflight.bun.ts returned exit 0. bun run docs:check returned exit 0. From apps/worker, env -i PATH="<inherited PATH>" bun run preflight returned exit 0. bun run check returned exit 0 with 2,091 passing Vitest tests, one skipped test, passing Bun assertions, and passing dry-run builds. git diff --check returned exit 0. The fake launch tests prove both command argument lists use --env-file /dev/null and both receive the allowlisted environment. A runtime fixture with fake .env values remains untested because the safety guard blocked fixture creation. No alternate fixture was created.

Final review closure: whole-branch reviewer dc7e6892 reviewed 4b6bc04..78764f3 and reopened R4. Commit c49abd5 fixes the global dotenv path. Scoped reviewer e3f6c578 approved R4 and found no fix-range regression. All prior findings remain fixed. Documentation review covered all new tooling declarations, test helpers, workflow messages, and this task. Structural review found one cohesive startup flow with separate failure-class ownership. Active diagnostics showed tooling-pattern notices only, with no TypeScript server error. Owner approved plan pn-e0aea4 and complete branch review pn-aee822 without changes. No product code, production config, dependency, vault, live service, deployment, or Cloudflare resource changed. Local startup does not prove production permissions or deploy success. The hostile-dotenv runtime fixture remains a stated coverage limit. An exploratory worker probe printed ambient environment data. Reports and task notes contain no values, and the parent stopped that method.

Owner CI2 brief continues PR #86 after Ubuntu CI failure. Keep the approved scope and branch. Trace local runtime reloads, add a regression, and test isolated runtime paths. No vault, live service, deployment, or Cloudflare resource action.

CI2 root-cause investigation: pinned Wrangler 4.45.0 with --no-bundle watches entry.moduleRoot recursively; resolveEntry sets moduleRoot to the main bundle directory when config base_dir is unset. The healthy Bun fixture put its bundle directly in the runtime root, so the watcher also observed sibling local-config, state, home, config, and cache writes. CI output showed repeated reloads until timeout. Regression RED: the fixture-layout assertion failed because dirname(healthy.js) equaled runtimeRoot. Fix: place healthy and global-call fixture bundles under runtimeRoot/worker-input, outside all writable runtime paths. GREEN: focused bun test/deploy-preflight.bun.ts passed. bun run check passed on macOS with lint, docs, typecheck, all tests, and builds. This local host does not verify the Linux watcher behavior; parent owns CI rerun. No workflow security, production code/config, credentials, vault, live service, deployment, or Cloudflare resources changed.

CI2 closure: Ubuntu CI run 42326403686 passed for ac47c82, including production preflight and bun run check. The isolated fixture input directory fixes the Linux reload loop. Scoped reviewer 62f29e68 approved 97a1e0c..ac47c82. Final branch reviewer f5b008cd approved 4b6bc04..ac47c82 and confirmed all six earlier findings remain fixed. Documentation and structural review found no issue. Active LSP probe found no errors in the changed test. The correction only changes fixture layout and adds its regression assertion, so the prior owner branch approval pn-aee822 still applies. No production code, workflow, failure label, dependency, vault, live service, deployment, or Cloudflare resource changed. Production permission and deployment proof remain outside this task.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added production-bundle startup validation to every PR check. Node Wrangler runs locally with private temporary state, fixed deadlines, loopback HTTPS, no inherited credentials, and an explicit empty global dotenv input. The local config omits only the unsupported compatibility flag. Startup and deploy failures print fixed known error classes without raw Wrangler lines. Focused regressions, credential-free preflight, docs check, full check, semantic reviews, and owner reviews passed. Full check reported 2091 passing Vitest tests and one skip, plus passing Bun assertions. The runtime hostile-dotenv fixture remains untested because the safety guard blocked its creation. No product or Cloudflare resource change occurred.
<!-- SECTION:FINAL_SUMMARY:END -->
