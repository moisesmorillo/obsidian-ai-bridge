---
id: OAB-37
title: Prove AC-30 on a fresh desktop fixture
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-04T18:03:00Z'
updated_date: '2026-11-05T11:28:00Z'
labels:
  - deferred
dependencies: []
references:
  - OAB-8.8
  - apps/plugin/tools/desktop-acceptance.ts
  - apps/plugin/test/desktop-acceptance.test.ts
documentation:
  - docs/spec.md
priority: medium
type: task
ordinal: 56000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three OAB-8.8 live tries did not complete AC-30. Suffix 04 collided locally. Suffix 05 stopped at a combined successor assertion.

Suffix 06 stopped at AC30_ASSERT_FINAL_CALL_COUNT: expected 3, observed 2. Individual call identities, statuses, and assertion-time queue data were not retained. Commit edc181e adds passing local characterization and does not reproduce the failure.

A later diagnostic-pair correction does not explain the historical missing third call. Trigger: A local regression explains that missing call and supports a reviewed tooling correction. The owner must authorize fresh disposable-vault credentials and a live fixture.

The current dev-2 client is revoked. Do not reuse historical fixture paths or infer further live authority.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One authorized desktop run proves immutable retry identity and bytes, plus a distinct successor with the confirmed precondition.
- [x] #2 Safe observations identify call counts, revisions, receipt equalities, and queue state for each final condition.
- [x] #3 The device and service retain the intended content and restored methods, or record the exact failed condition.
- [x] #4 No personal vault or protected historical fixture changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Use the reviewed plan at /tmp/oab-37-plan.md. First reproduce the two-call result locally. Correct only acceptance tooling and tests. Review and validate before one authorized live case. Preserve historical fixtures and stop if product sync changes are needed.

Supervisor decision: S1 owns the product fix under OAB-40. Retain the harness but skip its three timing cases with an OAB-40 reason comment. Complete independent tooling corrections, focused tests, docs:check, full check, and task review. Commit and stop. Do not enroll dev-2 or run live AC-30. Wait for the supervisor instruction after the S1 PR merges before rebase and harness activation.

Native enrollment completed under supervisor direction. One live AC-30 run passed. Complete the evidence task review, final branch review, and human Plannotator diff review before PR publication.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Stopped at the authorized sync boundary on 2026-11-04. Plan pn-406ba6 was approved. The local regression in apps/plugin/test/desktop-acceptance.test.ts uses real journal, publication, desktop, and reconciliation controllers with a synthetic committed feed. Three timing cases reach AC30_ASSERT_FINAL_CALL_COUNT with two fixture requests and one other-path request. The fixture remains at service revision 1 while feed replay reaches cursor 2. Cases cover delayed modify admission, debounce before the retry deadline, and debounce while the first PUT waits. This reproduces the failure class, not the historical live event order. The sync owner must assess the other-path publication before any tooling-only correction or live run.

Worker RED command: bun run --filter @obsidian-ai-bridge/plugin test -- test/desktop-acceptance.test.ts -t 'checks AC-30 feed replay across delayed modify and debounce orderings'. The expected-red wrapper returned shell exit 0 and printed observed-test-exit=1. One test failed and 40 were skipped. The earlier characterization passed one test with 57 skipped. Baseline desktop acceptance tests passed before the new regression.

No production sync or tooling correction, live vault action, credential enrollment, browser action, service request, deployment, commit, push, or PR ran. Dev-1 was not accessed. The failing test and task changes remain uncommitted on feature/oab-37-ac-30-live. Full checks and reviews did not run. Report and plan remain in ignored or temporary paths. Report to the supervisor under the S2 brief. Do not mark acceptance criteria complete.

Supervisor assigned the product defect to S1 as OAB-40. The three retained controller timing cases now stay skipped with an OAB-40 reason comment. Enrollment and live AC-30 wait for supervisor instruction after the S1 PR merges. The supervisor also approved one publication.test.ts fixture-path assertion update for the fresh generator default.

Independent tooling now validates oab-37/ac-30-response-lost-*.md fixture paths, uses the initial attention count, and retains bounded call identity labels, statuses, revisions, complete retry-receipt equality, and assertion-time queue observations. Diagnostic projection omits raw keys, paths, payloads, hashes, ETags, and epoch values.

Task review ed4d6e61 covered the three-file overlay on e810cde2fe879e2b1aba828d69a30f89c122b35a with the code-review skill and TypeScript profile. It requested direct failure-path cleanup proof and complete retry receipt equality. Corrective review 6077464f closes both findings after it inspected the final code and regression tests. The cleanup test installs the generated interceptor, injects fixture creation failure, omits separate cleanup, and proves exact original method identity. The receipt regression keeps equal ETags but changes seq. It failed before the complete seven-field comparison and passed after the correction. The diagnostic reports only a boolean. AC30_ASSERT_FINAL_RETRY_ETAG remains the compatibility code for the complete receipt mismatch.

Worker validation after corrections: desktop acceptance tests passed 44 with 3 OAB-40 cases skipped. Focused publication tests passed 2 with 56 skipped. bun run docs:check, bun run check, and git diff --check passed. The full check recorded 1,729 passing tests and 3 skipped cases, with lint, documentation, type checks, and builds. The receipt RED run recorded 1 failed, 1 passed, 45 skipped, and observed test exit 1 inside a successful expected-red wrapper. The new cleanup test passed immediately because the existing finally block already restored the method.

Review limits: the corrective reviewer could not read the supplied ignored report and correction-diff paths. It used the prior review and current worktree diff and did not rerun checks. Worker commands provide the validation evidence. Canonical tooling typecheck passes despite pre-existing editor alias diagnostics. Full branch and human diff reviews remain pending the future live checkpoint. No real vault, browser, credential, live service, deployment, push, or PR action ran. Keep OAB-37 In Progress and all live acceptance criteria unchecked. Prepare the scoped checkpoint commit and stop.

Supervisor authorized continuation after S1 PR #52 merged. Parent fetched and merged origin/main without conflicts. The worker enabled the three retained timing cases and ran them before any install or enrollment. Command: bun run --filter @obsidian-ai-bridge/plugin test -- desktop-acceptance.test.ts -t 'checks AC-30 feed replay'. Result: 3 failed, 44 skipped, exit 1. Delayed modify admission timed out after 30,020 ms. Debounce before retry wait reported AC30_ASSERT_REMOTE_CAPABILITIES. Debounce while first PUT is held timed out after 30,002 ms. Stop at the supervisor failure gate. These outcomes do not establish a remaining OAB-40 product defect. No further harness or sync correction, docs check, full check, install, enrollment, or live AC-30 ran. The harness activation and comment change remain uncommitted. Report the failing assertions to the supervisor.

Harness adaptation completed as 941d5c1517ea09e13e957cfdc95bba145fc5902c. The synthetic vault lacked readBinary support, and timed-out cases left the restore hook. The corrected harness restores the exact interception and clears its hook in finally. All three active timing cases pass with exactly three fixture calls and no other-path call. No product sync change. Desktop acceptance passed 47 tests, focused publication passed 2, and docs:check and bun run check passed. The full check recorded 1,783 passed and 1 skipped. Task review f635d9ee approved this commit against merge 5c56d7d with no findings.

Installed the current plugin in dev-2 through the guarded createInstallScript and scoped Obsidian host. The direct installer exceeded the macOS argument limit. A read-only local spawn probe recorded E2BIG for the 1,047,594-byte script. A private temporary-file loader then ran the same guarded install script and verified bundle and manifest hashes. Version 0.1.0. Main SHA-256 5b8d0a03144c0b4f51717c7f05781a684c1a967f01a9bbb5f101e4dceced3c61. Manifest SHA-256 eef1849b73dfb7f786ceb17ddee28dac995a9f197968daaceb23fb2b1ba0f347.

Enrollment blocker: the plugin created three disposable PKCE clients named oab-37 dev-2 through normal session.connect calls. Client IDs: AyjViXYUoI9ls-C2, g6shUHq0Et3EIK34, dFa_hcMcZYfOeBo5. Orca displayed the consent form without an Access PIN gate. The first native approval click yielded no captured callback. Fresh flows used native form requestSubmit. After explicit browser capture start, the third flow captured a POST to /authorize/consent but no recoverable callback URI. The page retained its authorization URL. No token exchange success was observed. The journal retained its old client ID e9R7UhafRVErfILb. Pending consent was canceled through plugin code. The registration and grant state of these three new clients remains unverified. No cleanup or revocation request ran for them.

Final scoped inspection: dev-2 retains Pause, one historical sent PUT, zero pending applies, four attention entries, and no reconciliation. All 51 protected oab-7.8/ and oab-8.8/ fixture paths, sizes, and hashes match the pre-install snapshot. The connected presentation after cancel does not prove fresh enrollment. Dev-1 was not accessed. No live AC-30 fixture or live AC-30 run started. No Cloudflare resource change, deployment, push, or PR ran. Stop and report the browser callback-capture blocker to the supervisor before more enrollment attempts.

Supervisor directed final-tab callback capture and the registered dev-2 protocol handler. The host exposes app.workspace.protocolHandler.handlers.get for ai-bridge/callback. This handler is reachable, so no system open fallback is necessary. No callback parameters were delivered because no callback URL was recovered.

The first follow-up client vbJclA4SRdXB7GBu received repeated submission before navigation settled. Its page later showed Invalid or expired consent. That result does not prove a service defect. The next flow registered client If7R501wwfsFx6kp and submitted its consent form exactly once. The browser URL wait timed out after 25,000 ms. A worktree-scoped orca tab list still recorded HTTPS /authorize, not an obsidian callback. The pinned page evaluation also showed /authorize with its consent form. Network capture contained one POST to /authorize/consent. No callback file or code exchange exists for this flow.

The current flow remains pending in Orca page a869c856-accc-4b69-b1ea-e9175acefca1 for supervisor inspection. The plugin reports connecting and retains Pause. Its journal still holds old client ID e9R7UhafRVErfILb. Do not claim enrollment success from presentation alone. No live AC-30 run, system open call, worker edit, resource change, push, PR, or branch review ran. Stop further fresh flows until supervisor direction.

The supervisor authorized native-browser enrollment after the Orca attempts. Parent canceled pending plugin consent, closed page a869c856, retained Pause and device name oab-37 dev-2, activated the exact dev-2 vault through its Obsidian URI, and displayed AI Bridge settings. The owner completed native-browser enrollment. A scoped journal read now confirms new client ID j-jAYgxDZ6cyAPVM, distinct from old e9R7UhafRVErfILb. The plugin reports connected, pending consent false, and Pause true. Before Resume it retains one historical sent PUT, zero applies, four attention entries, and no reconciliation. No dev-1 access occurred.

Live AC-30 passed once on 2026-11-05 at 11:23 UTC. Fixture: oab-37/ac-30-response-lost-20261105T112327115Z-a57bf836.md. Device client: j-jAYgxDZ6cyAPVM. The generated case ran through the current installed bundle against the deployed service. The case injects response loss only after the first service commit, while the real plugin retains the immutable sent operation and receives a later local edit.

Assertion-time observations: exactly three fixture PUT calls. First: HTTP 201, revision 1. Retry: HTTP 201, revision 1. Successor: HTTP 200, revision 2. Original and retry identities match. Their payloads and preconditions match. Complete seven-field receipts match. The successor uses a distinct key, edited payload, and the confirmed revision-1 precondition. No 422 occurred. Both pending queues are empty. No fixture or other-path operation remains. Four attention entries match the initial count.

All generated final assertions passed, and cleanup passed. For success evidence, the host script copied its existing bounded diagnostic object at assertion time without changing any case assertion or control flow. A separate scoped read confirmed service revision 2, live authority, expected edited-content hash, exact expected local text, base revision 2, matching base hash, empty queues, no reconciliation, and absent restore hook. The generated action also checks exact remote.put restoration. No raw operation key, payload, ETag, epoch value, credential, callback code, state, cookie, or owner subject entered these notes.

All 51 protected oab-7.8/ and oab-8.8/ fixture paths, sizes, and hashes match the pre-install snapshot after the live case. This is a local inventory comparison, not a complete service inventory audit. The normal Resume resolved the retained historical sent operation before the case. Parent did not discard or rewrite it manually. Dev-1 received no access. Parent paused dev-2 after final verification with empty queues and four retained attention entries.

Evidence limits: this is one live desktop run with a controlled response-loss injection against the deployed service. It does not prove every network schedule. Native-browser enrollment was owner-manual under supervisor authorization. Earlier Orca registrations and consent capture failures remain historical limits. No Cloudflare resource change or deployment ran. All four OAB-37 acceptance criteria now have evidence. Keep the task In Progress until final independent and human branch reviews complete.

Task acceptance review ef47a9d7 reviewed source 941d5c1, the task overlay, and safe live result, assertion-time observation, and post-run verification JSON. It passes all four acceptance criteria with no actionable finding. It did not rerun checks or live actions. It relies on the task notes for the verified journal client ID, the protected local inventory comparison, and no dev-1 access. It preserves the one-run and local-inventory limits.

Fresh parent validation after the live case passed both bun run docs:check and bun run check with exit 0. Full totals: tooling 56, protocol 307, plugin 522 passed and 1 skipped, Worker 661 plus 122 plus 115 passed. Total 1,783 passed and 1 skipped. Lint, documentation, type checks, and builds passed. No source changed after these checks. Origin main is current and already merged. Final whole-branch review and human diff review remain pending.
<!-- SECTION:NOTES:END -->
