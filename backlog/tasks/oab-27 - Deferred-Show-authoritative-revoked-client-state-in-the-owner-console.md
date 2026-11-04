---
id: OAB-27
title: 'Deferred: Show authoritative revoked client state in the owner console'
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T16:48:00Z'
updated_date: '2026-11-04T22:53:00Z'
labels:
  - deferred
  - owner-console
dependencies: []
references:
  - OAB-7.8
documentation:
  - docs/spec.md
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-7.8 finding S2 remains open. At 16:46Z on 2026-10-28, revoked probe noscope and probe rw stayed listed, but the revoked MCP Inspector 7.8 client disappeared. Registry grant counts and Revoke actions do not prove active authority.

Trigger: before the owner relies on console listings for client-state decisions, explain retained history and show authoritative revocation and cleanup state. Preserve DO-first denial and assess the different listing outcomes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The console distinguishes active, revoked, and cleanup state from retained grant history with authoritative data.
- [ ] #2 Tests explain retained revoked clients and removed clients, including repeated revocation and provider cleanup outcomes.
- [ ] #3 Revoked grants still fail at the DO before reads or writes, regardless of console or provider cleanup state.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execute item 2 of the approved shared S3 plan. Add failing registry, owner-rendering, schema, and durable-denial tests. Project durable revocation independently from retained grant history and provider cleanup. Add only canonical protocol fields that the console authority needs. Render active, revoked, no-grant, and cleanup states without sensitive data. Preserve owner filtering, bounded pagination, repeated revocation, re-consent, DO-first denial, and storage version. Run docs:check and bun run check, then task review, whole-branch review, and human branch review. Publish PR 2 and stop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner merged PR 48 as 88e3c89. Main is current. Prior timeout worktree does not exist. Supervisor directs item 2 under plan approval pn-f7baf3. Owner explicitly approves decision 2: only durable revocation fields needed by the console in packages/protocol, with tests. No protocol identity transition, deployed state cleanup, vault access, or resource changes belong to OAB-27.

Item 2 implementation evidence.

TDD RED: `bun run --cwd packages/protocol test -- test/auth.test.ts` exited 1 with the expected strict-schema rejection of `active_grant_count`. `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/registry.test.ts test/f2/owner.test.ts` exited 1 with 4 expected failures across 2 files: the durable projection fields and console state labels were absent.

Focused GREEN: protocol auth schema test passed 2/2. Worker F2 registry, owner, and OAuth suites passed 32/32 tests across 3 files. These tests cover no-grant, active, all-revoked, mixed re-consent history, pending and completed provider cleanup, interrupted cleanup recovery, repeated revocation, owner filtering, escaped HTML, retained history, and DO denial after provider cleanup. The real DO test checks the same old grant at read and mutation authorization boundaries. Provider cleanup success also confirms removed provider KV rows while durable registry history remains visible.

Validation: `bun run docs:check` passed. `bun run check` passed lint, docs, all workspace type checks, tests, and dry-run builds. Results: tooling 56 tests/5 files, protocol 306/17, plugin 483/23, worker 883/53, total 1,728 tests across 98 files. All check phases exited 0. Worker logs include expected injected network and SQLite failures in existing fault tests.

Limits: no deployment, Cloudflare change, provider service access, or vault access occurred. The historic OAB-7.8 Inspector disappearance remains unexplained. This implementation shows durable registry clients after provider cleanup, but does not infer why that historic client listing differed. No provider listing is an authority source, and durable registry state does not prove token currency or expiry.

Task review at cc81e8d964b2e1e4f0c4848fd8211bf31091b495: APPROVE WITH NOTES. No blocker or correctness defect. The reviewer verified canonical durable projections, bounded owner filtering, state labels, denial-before-effects tests, documentation, and cohesive ownership. Non-blocking note: nested state expressions at owner.ts 85–92 and 128–133 reduce audit clarity. Carry this note to whole-branch review for explicit disposition. Active lens probe also found these expressions. Two unrelated throwing-call findings lie outside the changed hunks, so they do not form diff findings. Validation uses worker-reported RED/GREEN and full-check evidence, not a reviewer rerun. No remote CI evidence yet.

Whole-branch review at 6558c244d9e20a30604a5a7970834d3a9dc3cfa9 against main 88e3c89: APPROVE WITH NOTES. Reviewed all eight files, canonical contracts, registry transitions, presentation state matrix, SQL limits, owner filtering, escaping, TSDoc, and denial-before-effects evidence. No blocking or correctness finding. Optional NIT disposition: retain the compact presentation expressions for this PR. Registry and HTML tests plus source review cover their mapping. They neither enforce authority nor own durable transitions. A classifier remains an optional readability change, not missing task behavior. Unchanged throwing-call diagnostics remain outside this diff. git diff --check passed. Worker reports full check with 1,728 tests across 98 files. No live-service, remote CI, coverage, or historical-disappearance proof is claimed. Human review follows.
<!-- SECTION:NOTES:END -->
