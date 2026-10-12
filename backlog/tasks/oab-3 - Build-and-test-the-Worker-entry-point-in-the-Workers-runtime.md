---
id: OAB-3
title: Build and test the Worker entry point in the Workers runtime
status: Done
assignee:
  - '@pi'
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 14:29'
labels:
  - F0
  - worker
dependencies:
  - OAB-2
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Before F1 implements the vault authority, prove that the production Worker package builds and its entry point runs inside the local Cloudflare test runtime. No public API or authentication bypass is introduced in F0. Dependency purpose: Hono is the specified transport router; Wrangler provides local builds; Cloudflare worker types and the Vitest pool validate the actual target runtime. Additional exact dependencies: @cloudflare/vitest-pool-workers runs tests in the actual local Workers runtime; Vitest provides the test runner; @cloudflare/workers-types provides Worker source globals; TypeScript checks source with its Worker-only type environment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The production Worker entry point is exercised using the Workers Vitest pool, not a Node-only substitute.
- [x] #2 Unimplemented routes deny requests and introduce no public vault operations or development authentication bypass.
- [x] #3 The local dry-run build and bun run check pass without remote deployment, secrets or production resource access.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a Workers-pool runtime test for default-deny routes and a PUT file request; verify it fails before implementation. 2. Add the minimal Hono Worker entry point, Cloudflare/Wrangler/Vitest pool configuration, and workspace scripts with dependency purposes recorded here. 3. Run focused tests and local dry-run build, then run the frozen-install and full root check once. 4. Self-review scope and commit the focused change without checking acceptance criteria.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
TDD RED: after adding the five-case runtime test, pool config and wrangler.jsonc but before apps/worker/src/index.ts existed, `bun run --cwd apps/worker test` launched Vitest/Workers pool and failed loading the production module path, as expected. GREEN: minimal empty Hono app made `bun run --cwd apps/worker test` pass 5/5 in local Workers runtime; `bun run --cwd apps/worker typecheck` passed; `bun run --cwd apps/worker build` passed with Wrangler dry-run and no bindings. Initial dry-run established installed pool runtime supports compatibility_date 2025-07-12; the initially selected 2025-10-14 generated a warning/fallback and was replaced. Exact versions: Hono 4.9.6 (specified router), @cloudflare/vitest-pool-workers 0.8.57 (Workers runtime tests), @cloudflare/workers-types 4.20251014.0 (Worker source globals), Wrangler 4.45.0 (local dry-run builder); existing root Vitest 3.2.4 satisfies pool peer range 2.0.x-3.2.x. Full validation: bun install --frozen-lockfile && bun run check passed with Biome 17 files, worker+protocol typechecks, protocol 24 tests, Worker 5 tests and dry-run builds. Added Biome exclusion for generated **/dist after observing built output itself is otherwise linted and fails; final Biome rule uses supported !**/dist folder pattern. No remote CI/resources/secrets accessed. OAB-3 remains In Progress; criteria unchecked.

Parent acceptance b4c758e8c ran at exact head 9727d464c829d20b475f7e7c9800b611e5af9e2c: frozen install and full check exited 0; 24 protocol + 5 real local Workers-pool tests, lint/types/build passed. Wrangler telemetry disabled; dry-run output reports no bindings and exits without deployment. Independent reviewer b6c47e1b-c510-4505-8963-52c9d73086ff approved spec and task quality with no findings. All three OAB-3 criteria verified. This is F0 Worker foundation only, not F1 APIs or DO tests; remote GitHub CI remains separately pending in OAB-2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the default-deny Hono production entry, real local Workers-pool route tests, isolated source types and reproducible Wrangler dry-run build. Verified exact head 9727d46 with parent check b4c758e8c (29 tests plus lint/typecheck/build, exit 0) and independent spec/quality approval. No deployment or vault access; no functional sync API claim.
<!-- SECTION:FINAL_SUMMARY:END -->
