---
id: OAB-47
title: 'Owner console redesign: Bordeaux and copper'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-07T21:08:00Z'
updated_date: '2026-11-07T22:24:00Z'
labels:
  - worker
  - ui
  - F6
dependencies: []
priority: medium
ordinal: 83000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: restyle every Worker HTML page with the approved design (direction F, Bordeaux and copper, Deep navy layout). Design canvas: https://claude.ai/artifact/KZQUbRknmconpgDCzMiWqb (owner only). Decisions: no Tailwind and no front-end dependency; one hand-written stylesheet with CSS custom properties embedded in the Worker as a string module and served inline in a <style> tag (CSP friendly, no external requests); system font stack in production (Sora is design-only); responsive with flex and grid, phone width stacks the sidebar into a chip bar and tables scroll in a box; real buttons, links and labels, 4.5:1 contrast, no inline event handlers. Pages: /owner/clients, /owner/clients/:id/grants, /owner/measurements, /owner/exports, /owner/blob-gc and /authorize consent. Phase 1 (foundation): tokens stylesheet, page shell (sidebar, header, cards, table, buttons, status dot), split owner page rendering into pure render functions under apps/worker/src/transport/owner-pages/ with snapshot tests, restyle clients and grants. Phase 2: measurements, exports, blob-gc. Phase 3: consent page in the OAuth module. Behavior, routes, CSRF, Access checks and forms do not change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Phase 1: a tokens stylesheet module exists with the approved palette and is served inline on every owner page. Clients and grants pages render with the new shell. Render functions are pure and covered by HTML snapshot tests. Existing owner tests stay green.
- [x] #2 Phase 2: measurements, exports and blob-gc pages use the shell and components. Numbers, links, forms and CSRF behave as before.
- [x] #3 Phase 3: the consent page uses the same tokens and a centered card. Approve and Deny keep their names and semantics.
- [x] #4 Phone width: the sidebar becomes a horizontal chip bar, cards stack, tables scroll horizontally. Checked with a DOM test at 390px or an equivalent assertion on the CSS.
- [x] #5 No new dependency, no external request from the pages, no inline event handlers. bun run check and Worker preflight green.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Owner console foundation implementation plan
Goal: Apply the approved Bordeaux and copper design to clients and grants without behavior changes.
Architecture: Keep Access, escaping, CSRF, registry calls, pagination, responses, and form semantics in their current boundaries. Pure page render functions consume escaped view models. One shell embeds one stylesheet.
Tech stack: TypeScript, inline CSS, existing Vitest tests. No new dependency.
Spec: Owner brief S10-console-foundation.md and COMMON-NIGHT.md, approved direction F. Repository contract: docs/spec.md and docs/api/f2.md.

## Owner decisions
The owner authorizes phase 1 without Plannotator. Use the supplied palette and system font stack. No external requests, live service calls, vault access, deployment, or Cloudflare changes.
Default: Service metadata shows unknown when current handlers lack authoritative values. Do not invent healthy state, version, or epoch.
Default: Apply the shell and inline stylesheet to measurements, exports, and blob-gc through render-only changes. Preserve their content for phase 2.
Default: Keep OAB-47 In Progress because phases 2 and 3 remain outside this branch.

## Task 1: Build and integrate the console foundation
Files: apps/worker/src/transport/owner-pages/{tokens.css.ts,shell.ts,clients.ts,grants.ts}, apps/worker/src/transport/owner.ts, tests and snapshots under apps/worker/test, docs/api/f2.md.
- [ ] Add failing snapshot tests for shell, clients, and grants. Assert every token and the 390px chip-bar, stacked-card, scroll-table, and 16px-padding rules.
- [ ] Assert empty states, all registry states, pending cleanup, remove eligibility, encoded pagination, and escaped hostile names and ids. Preserve CSRF values, action, method, button names, disabled state, input name, and maxlength.
- [ ] Run the new tests and record their expected failure before implementation.
- [ ] Add OWNER_CONSOLE_CSS, renderOwnerShell, renderClientsPage, and renderGrantsPage with documented internal view models. Keep escapeHtml unchanged in owner.ts.
- [ ] Pass escaped values from handlers. Render the shared frame with active navigation, system fonts, tokens, components, responsive rules, and honest service metadata.
- [ ] Wrap other owner HTML pages only where no logic change is needed. Keep JSON output unchanged.
- [ ] Document the design and token table. Add useful TSDoc to semantic declarations.
- [ ] Run focused render tests and existing test/f2/owner.test.ts. Run bun run docs:check, bun run check, and Worker preflight. Commit the complete task.

## Review focus
Check escaping at the handler boundary and URL encoding for hostile identifiers. Check all forms against the original markup. Check mixed and pending states without false token-health claims. Check empty pages and pagination. Check phone overflow and keyboard navigation.

## Acceptance and publication
- [ ] Fresh task review with the code-review skill and TypeScript profile. Resolve findings through the implementer.
- [ ] Rebase on origin/main. Complete a separate whole-branch review with the session model. No Plannotator.
- [ ] Record reviewed revision, documentation scope, structural candidates, checks, limits, and finding closures in task notes.
- [ ] Check only phase 1 criteria that this branch proves. Leave later phases open.
- [ ] Push and open one PR against main. First body line: OAB-47 phase 1: visual only, no behavior change.
- [ ] Remove the worktree, report the PR URL, and stop.

Final scope: Keep measurements, exports, and blob collection markup unchanged for phase 2, as the owner brief allows. The shared shell and stylesheet serve clients and grants in this branch. Task and branch reviews completed. Scoped review accepted F1, F2, and F3. AC4 and AC5 have test and source evidence. AC1 remains open for inline styling on every owner page. AC2 and AC3 remain outside this phase.

## Phase 3: Consent page
Goal: Apply the approved design to consent without behavior changes.
Owner decisions: The owner skips Plannotator. Reuse OWNER_CONSOLE_CSS without edits. Show scope ids alone when protocol descriptions do not exist. Omit Requested on unless provider metadata supplies it. No live requests, dependencies, deployment, or vault access.
- [ ] Add failing renderer snapshots and exact form-contract tests. Cover escaped metadata, known scopes, and optional request time.
- [ ] Add consent.ts as a pure renderer with an escaped view model and shared tokens. Keep auth types outside the renderer.
- [ ] Replace only the HTML construction in oauth.ts. Preserve validation, hidden fields, form action and method, names, values, and response headers.
- [ ] Run focused render and OAuth tests, docs:check, bun run check, and Worker preflight. Commit implementation.
- [ ] Complete independent task and whole-branch reviews. Record revision, findings, documentation scope, checks, and limits.
- [ ] Rebase onto origin/main. Push one PR with the mandated first body line. Remove the worktree and report the URL.
Review focus: HTML escaping, exact form contracts, no invented scope descriptions or timestamps, token reuse, narrow edit boundaries, and phone overflow.
Allowed changes: oauth.ts, new owner-pages/consent.ts, consent tests and snapshots, and this task through the CLI. Do not edit other owner pages, workflows, or plugin tooling.

## Phase 2 implementation plan
Goal: Restyle measurements, exports, and blob cleanup without behavior changes.
Architecture: Pure render functions consume escaped view models. Handlers keep authorization, validation, escaping, CSRF, response headers, and gateway calls.
Tech stack: Existing TypeScript, CSS string, Vitest, and snapshots.
Spec: Owner brief S12-console-phase2.md, COMMON-NIGHT.md, S10-console-foundation.md, docs/spec.md, and docs/api/f2.md.

### Owner decisions
The owner skips Plannotator and authorizes implementation and publication without another gate. Keep tokens unchanged. Extend shell section selection and shared component rules only as needed. No dependencies, external requests, live calls, vault access, or Cloudflare changes. Keep OAB-47 In Progress.
Default: Derive export cards from listed completed snapshots. Calculate the next UTC hour from server time. Do not invent unavailable inventory or storage capacities. Unknown measurements show Unknown. Unavailable inventory stays visibly unavailable. Bars show observations without invented capacity percentages.

### Task 1: Complete the three phase 2 pages
Files: owner-pages/{measurements.ts,exports.ts,blob-gc.ts,shell.ts,tokens.css.ts}, transport/owner.ts, test/owner-pages.test.ts and its snapshots. No OAuth, workflows, or plugin changes.
- [ ] Add snapshots and form, CSRF, download URL, unknown, stale, failed, empty, and unavailable-state assertions. Run tests before implementation and record RED.
- [ ] Add documented renderMeasurementsPage, renderExportsPage, and renderBlobGcPage functions with escaped view models. Extend active shell sections. Preserve existing measurement facts and safety messages.
- [ ] Add stat cards, storage bars, four slot segments, export tables, collection steps, and safety panels with existing tokens.
- [ ] Replace only the three HTML render paths in owner.ts. Keep routes, JSON, statuses, headers, POST logic, and CSRF unchanged.
- [ ] Run focused page and F2 owner tests, docs:check, bun run check, and Worker preflight. Commit.

### Review focus
Preserve measurement coverage, windows, latency boundary, retained samples, and isolate limitations. Check escaping and encoded download links. Check empty and failed exports. Check all collection phases, delete claims, failures, unavailable inventory, and safety text. Do not imply unknown capacity is zero.

### Acceptance and publication
- [ ] Independent task review with code-review skill and TypeScript profile. Resolve findings.
- [ ] Rebase on origin/main. Complete a whole-branch review on the session model.
- [ ] Record revision, documentation scope, structural candidates, actual checks, limits, and finding closures through the CLI. Keep the parent task In Progress.
- [ ] Push and open one PR against main. First body line: OAB-47 phase 2: visual only, no behavior change.
- [ ] Remove the worktree, report the PR URL, and stop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope: owner brief S10 covers phase 1 only. The owner skips Plannotator for this branch. No live service calls or Cloudflare changes. No new dependency.

Phase 1 implementation uses pure clients and grants renderers with escaped view-model values. Added CSS token and responsive assertions plus HTML snapshots. RED: focused render suite failed because owner page modules did not exist (exit 1). GREEN: focused render suite, F2 owner suite, docs:check, bun run check, and Worker preflight passed. Known limit: measurements, exports, and blob-GC keep their existing markup in phase 1; later phases remain open.

Branch-review fix closures at cc287667caf133e1f3a3525bc51eac0500cc46ed: F1 closed by focused table-driven tests for No accepted grants, Revoked, Mixed active and revoked history, Active registry grant, and Remove absent/enabled/disabled. Tests assert CSRF field counts and values, POST actions, Rename/Revoke/Remove button text, name input, and maxlength. Focused render suite passed 5/5, owner.test passed 4/4, owner-cleanup.test passed 6/6. F2 closed by asserting base .owner-layout flex-wrap:wrap and adding that declaration while retaining 390px and 16px rules. Focused render suite passed 5/5. F3 closed by asserting grants output marks Clients with aria-current=location and updating renderOwnerShell TSDoc to describe page or containing-section selection. Updated snapshots; focused render suite passed 5/5. docs:check passed. bun run check passed, including lint, type checks, all suites, and dry-run build. Worker preflight passed (exit 0). Task remains In Progress for phases 2 and 3.

Review closure: task review and whole-branch review used the code-review skill and TypeScript profile. Whole-branch revision: cc287667caf133e1f3a3525bc51eac0500cc46ed. Scoped review accepted all three fixes at 36d3488af564b7c3943ee27ae3cbdc18a9d4bae7. F1: five focused render tests cover all labels and Remove outcomes. F2: base flex wrapping has a direct CSS assertion. F3: grants select Clients with current-location semantics and a direct assertion. No open finding remains. Documentation scope: new renderer declarations, local view models, shell contract, CSS constant, handler mappings, and docs/api/f2.md token table. Structural candidates: owner.ts remains mixed but low-risk within this visual change. Page renderers, shell, and CSS each remain cohesive. Registry mutation policy remains unchanged. Limits: CSS assertions replace a 390px browser test. No browser, contrast measurement, live service call, deployment, or vault access occurred. The new stylesheet serves clients and grants only. AC1 stays unchecked because every owner page includes later phases. AC2 and AC3 remain open. Rebased onto origin/main 586008f after the plugin release changes. A content-preserving merge retains the original remote task seed commit, so publication needs no force-push. Final project check and Worker preflight follow on the rebased tree.

Phase 3 RED evidence: `cd apps/worker && bunx vitest run --config vitest.config.ts test/consent-page.test.ts` failed as expected because `@worker/transport/owner-pages/consent` did not exist. It reported 0 tests and one failed suite. Focused existing OAuth baseline: `bun test apps/worker/test/f2/oauth.test.ts` could not load `cloudflare:test` under bun test. The first baseline command used an unmatched glob and was invalid. Vitest unit config baseline is pending dependency/runtime setup.

Phase 3 implementation: Added the pure consent renderer and replaced only OAuth HTML assembly. The view model carries escaped client, host, redirect URI, scopes, handle, and optional request time. It reuses protocol scope ids and the shared stylesheet. RED: the new render test failed because the module did not exist. GREEN: `cd apps/worker && bunx vitest run --config vitest.config.ts test/consent-page.test.ts test/owner-pages.test.ts` passed 8 tests. `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts` passed 32 tests. This Vitest command is the valid OAuth baseline; the earlier `bun test` command could not load `cloudflare:test`. `bun run docs:check` passed. `bun run check` passed: lint, docs, typecheck, tests, and dry-run builds exited 0. Test suites passed: Worker unit 54 files/761 tests, HTTP 9/132, F2 10/142, protocol 19/314, tooling 9/101, plugin 30/838 with 1 skipped. Worker tests printed expected injected failure and disconnect diagnostics but passed. `bun run --filter '@obsidian-ai-bridge/worker' preflight` passed with exit 0. Self-review found no actionable issue. No live requests or Cloudflare changes.

Branch review F1 closure: Kept the Approve button first in DOM order so Enter in the client-name field submits `decision=approve`. CSS order places Deny left of Approve on desktop. The mobile column places Deny above Approve. Updated the consent snapshot. RED: `cd apps/worker && bunx vitest run --config vitest.config.ts test/consent-page.test.ts` failed because the rendered button order was `deny`, then `approve`, instead of the required `approve`, then `deny`. GREEN: `cd apps/worker && bunx vitest run --config vitest.config.ts test/consent-page.test.ts test/owner-pages.test.ts` passed 8 tests. `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts` passed 32 tests. The form contract test now asserts submit order, exact form fields, desktop CSS order, and mobile stack order. `bun run docs:check` passed. `bun run check` passed. Worker unit tests passed 761/761, HTTP passed 132/132, and F2 passed 142/142. Protocol passed 314/314, tooling passed 101/101, and plugin passed 838 with 1 skipped. Worker preflight passed with exit 0. Worktree had no unrelated lockfile change. OAB-47 remains In Progress.

Phase 3 review closure: task reviewer approved 2e60be5. Whole-branch review examined 2e60be5 against da71681 and found F1: reversed DOM button order changed implicit Enter submission to denial. Fix d4308e6 restores Approve first in DOM order and uses CSS for visual order. A failing default-submit test preceded the fix. Scoped review closed F1 at d4308e6 with direct DOM-order, CSS, and snapshot evidence. No finding remains open. Documentation scope: consent view model, escaped fields, optional time, and renderer contract. Structural assessment: consent.ts is cohesive presentation code. oauth.ts remains mixed but low-risk, with unchanged provider state transitions. Final checks: focused render 8/8, OAuth 32/32, docs:check, bun run check, and Worker preflight passed. Review limits: no browser visual test, contrast measurement, live call, deployment, or vault access. AC3 is complete. Task stays In Progress as instructed. Unrelated generated lockfile metadata remains in a named Git stash outside this branch.

Scope: OAB-47 phase 2 follows S12. Tokens remain unchanged. No dependency, live service call, Cloudflare change, deployment, or vault access occurred. OAB-47 remains In Progress.

Phase 1 remains complete on the merged base. Its clients and grants renderers, shell, CSS, snapshot tests, review closures, and validation evidence remain as previously recorded.

Phase 2 adds pure escaped-view-model renderers for measurements, exports, and blob cleanup. The owner handler changes only these HTML render paths. Routes, statuses, response headers, JSON output, POST behavior, CSRF fields, and form actions remain unchanged. Measurement facts and safety statements remain visible. Unknown values do not display as zero. CSS token values remain unchanged.

RED: Added imports and tests, then ran bun test apps/worker/test/owner-pages.test.ts with a recorded expected nonzero exit. It failed with exit 1 because the three renderer modules did not exist. GREEN: bun test apps/worker/test/owner-pages.test.ts passed 8 tests and 6 snapshots. The F2 suite passed 4 tests with the configured Vitest runner. The initial F2 baseline attempt used Bun and failed to resolve cloudflare:test.

Validation: bun run docs:check passed. bun run check passed. It included lint, docs, all type checks, 761 Worker tests, 142 F2 tests, 132 HTTP tests, 838 plugin tests with 1 skipped, 314 protocol tests, 101 tooling tests, and dry-run builds. Worker preflight passed with exit 0. Existing Worker test runs printed expected cancellation and injected SQLite error diagnostics.

Self-review scope: Reviewed the phase 2 working-tree diff against its base, all new declarations, renderer call sites, escaping boundaries, response behavior, measurement facts, export actions and download links, blob safety statements, and token changes. No actionable finding remains.

Limits: Blob status exposes idle, marking, and deleting, with no separate clear phase. Idle highlights Inventory because the GET also runs preview. Clear stays visible without a false phase claim. The inventory schema does not report page counts, so the page states that explicitly. No browser review or live request occurred.

Corrective review RED: focused owner-page Vitest tests fail on the requested Unknown timestamp labels and honest R2 binding label. Expected phase tests pass for all three renderer states. No route, authorization, or Bun lock changes made.

Corrective review GREEN: owner page Vitest suite passed 11 tests. F2 owner Vitest suite passed 4 tests after its rendered Unknown expectation changed. The measurements renderer displays Unknown for absent timestamps. Tests preserve Unknown (storage_error) and measurement safety text. Blob renderer tests cover unavailable dry-run text and the Unknown (R2_BUCKET binding) label. Direct phase tests cover idle to Inventory, marking to Mark, and deleting to Delete. Handler inspection confirms null preview or status still returns 403 Forbidden. The pure renderer still supports null preview, but the route does not expose that state. This route limitation preserves the owner authorization contract. The handler does not claim a physical R2 bucket name or add a config field. docs:check passed. bun run check passed, including 764 Worker tests, 142 F2 tests, 132 HTTP tests, 838 plugin tests with 1 skipped, 314 protocol tests, 101 tooling tests, type checks, lint, and dry-run builds. Worker preflight passed. Corrective self-review confirmed unchanged 403 handling, routes, headers, POST, and CSRF behavior. No Cloudflare config or bun.lock changes.

Phase 2 final review: code-review task review examined ec06881. Whole-branch review examined 14cff5625f2502a0e1f7072ecd8c00d0a890e8fc against main da71681 and returned APPROVE WITH NOTES. No blocking finding remains. F1 disposition: retain the existing null-result 403 authorization contract. The pure renderer supports unavailable inventory, but the current gateway has no distinct listing-unavailable result. This is a presentation limit under the owner order to preserve routes and statuses, not a new authorization defect. A future gateway contract change can expose this state. F2 fixed: the handler shows Unknown (R2_BUCKET binding), with a renderer assertion. Phase tests cover idle, marking, and deleting. The protocol has no separate Clear phase. Documentation audit covered three view models, three render functions, two measurement helpers, shell, CSS constant, and changed handler mappings. No material declaration gap remains. Structural candidates: owner.ts stays mixed but low-risk. Renderers, shell, and stylesheet stay cohesive. Durable state policy stays in existing owners. Validation: worker output confirms 11 focused page tests, 4 F2 owner tests, docs:check, bun run check, and Worker preflight passed. Parent inspected the recorded check output. The static reviewer ran git diff --check successfully but did not repeat tests. No browser, contrast measurement, live request, hosted CI proof, deployment, or vault access. Restored detailed phase 1 notes. Unrelated setup lock metadata remains in a named Git stash and does not ship. AC1 and AC2 now have render and regression evidence. Keep OAB-47 In Progress for phase 3.

Rebase integration after be8cd0c: the consent renderer still embeds OWNER_CONSOLE_CSS. The focused consent test reproduced one snapshot mismatch. Snapshot comparison confirms identical markup outside style and identical consent-specific CSS. Only the shared OWNER_CONSOLE_CSS portion changed. Updated only consent-page.test.ts.snap for the shared phase 2 stylesheet. No product source, consent test, token, OAuth, or other snapshot files changed. The parent range-diff confirms both product commits remain unchanged. OAB-47 remains In Progress. Focused consent and owner-page suites passed 14 tests. bun run check passed, including 767 Worker tests, 142 F2 tests, 132 HTTP tests, 838 plugin tests with 1 skipped, 314 protocol tests, 101 tooling tests, lint, type checks, documentation checks, and dry-run builds. Worker preflight passed with exit 0. Snapshot delta validation passed. No external requests occurred.
<!-- SECTION:NOTES:END -->
