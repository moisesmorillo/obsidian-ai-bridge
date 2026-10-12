# F0 Owner-Review Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, preserving the owner's selected execution method. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the nine annotations from pn-ffdc61 and the owner's validated maintainability requirement without adding F1 behavior.

**Architecture:** Separate existing protocol schemas/public contracts, inferred types, and executable codecs by reason to change. Document lightweight inward dependencies in AGENTS.md; create further layers only when a real responsibility exists. Centralize runtime pins in mise and migrate requested tooling without weakening runtime isolation or real Workers tests.

**Tech Stack:** Bun 1.4.3; Node 24.21.0 (existing supported LTS runtime, not a claim of newest Node current release); mise; Zod; TypeScript 7; Vitest 5/Cloudflare plugin; Hono; esbuild; Obsidian typings.

**Spec:** `docs/spec.md` v1.3, F0 and §15; owner review pn-ffdc61 and subsequent approved architecture clarification. Tracking: **OAB-22**. This replaces only the reviewed implementation choices, not the product contract or the historical F0 plan.

## Global Constraints

- Work only in `~/.worktrees/obsidian-ai-bridge/chore/f0-plan`, branch `chore/f0-plan`. Baseline source is `281cbb5`; metadata head `dd23d70`.
- Every mutation is conditional on the exact observed revision; absence never deletes; obsolete revisions never overwrite; every collision leaves two visible files or revisions.
- No personal-vault access, deployment, Cloudflare resource mutations, new operational endpoints, sync, OAuth, backup, or future-phase implementation.
- Preserve plugin id `ai-bridge`, `minAppVersion: 1.13.0`, `isDesktopOnly: false`, browser/CommonJS build and inert lifecycle. New typings do not authorize raising the host floor.
- Zod in `packages/protocol` remains the only owner of protocol shapes. Infer types; do not duplicate interfaces or add protocol shapes to handlers.
- Preserve all existing public exports, validation behavior and 33 baseline test cases. Internal source paths may change; package consumers use its root export.
- Long installs/tests/builds use parent `bg_run`. A child lacking that tool requests one checkpoint and waits for the actual outcome; no speculative success or foreground workaround.
- One writer at a time. A passing focused checkpoint is not proof that later pipeline stages ran. No task closure or F0 completion without the relevant evidence.
- No new parser, architecture framework, OpenAPI generator, dependency-updater service, empty layers, generic repositories, or schema/type duplication.

## Review Focus

1. Public imports retain the same schema objects and function semantics; contract modules do not depend on codecs. Task 1 surface tests plus review of six small modules.
2. NFC happens before UTF-8 limits; path keys lowercase without changing display paths. Task 1 preserves existing boundary cases.
3. ETag formatting/parsing retain quoted format and positive safe revisions; docstrings describe validation, not proof of random/unique epochs. Task 1 existing invalid-input matrix.
4. TypeScript migration must still reject `process`, `Buffer`, `Bun` in runtime, permit web globals, and permit Node in tooling; unrelated compiler failures cannot masquerade as successful rejection. Task 2 durable probes and leaky-config control.
5. Vitest migration must execute the unchanged five Worker tests inside Workers and preserve inert plugin artifacts; Node mocks or deleted assertions are unacceptable. Task 2 actual integration checks.

## File Ownership Map

| Files | Responsibility |
| --- | --- |
| `packages/protocol/src/schemas/path.ts`, `schemas/etag.ts` | Canonical schemas, validation predicates and public contract documentation; no codec imports |
| `packages/protocol/src/types/path.ts`, `types/etag.ts` | Documented `Path`/`ETagParts` inferred from canonical schemas; type-only imports |
| `packages/protocol/src/codecs/path.ts`, `codecs/etag.ts` | Existing normalization/key and parse/format functions; consume schemas/types |
| `packages/protocol/src/index.ts` | Stable public barrel; no implementation |
| Existing `src/path.ts`, `src/etag.ts` | Remove after moving responsibilities; no redundant forwarding modules |
| `packages/protocol/test/contracts.test.ts` | Independent contract/codec surface and public-barrel compatibility tests |
| Existing path/ETag tests | Preserve all cases and behavior; already import public barrel |
| `packages/protocol/test/runtime-isolation.test.ts` | Update probe target to stable `src/index.ts`, then migrate compiler instrumentation in Task 2 |
| `apps/plugin/src/main.ts`, `apps/plugin/build.ts`, `apps/worker/src/index.ts` | Useful lifecycle/build/module-intent TSDoc; no new operational behavior |
| `AGENTS.md` | Enforceable architecture/documentation review rules, not a second product specification |
| `mise.toml`, `.bun-version`, `.github/workflows/check.yml`, `README.md` | One canonical runtime configuration, matching CI/development instructions; retire redundant Bun pin |
| Root/plugin/Worker manifests, `bun.lock`, `biome.json` | Requested exact stable versions and necessary Workers integration replacement |
| `apps/worker/vitest.config.ts`, relevant tooling type references | Supported Cloudflare Vitest plugin configuration/types, not runtime changes |
| `packages/protocol/test/toolchain.test.ts` | Durable mise/CI consistency, immutable Action pins and requested version assertions |

## Task 1: Separate Contracts and Implementation; Close Documentation Findings

**Interfaces:** Keep `PathSchema`, `EpochSchema`, `ETagSchema`, `Path`, `ETagParts`, `normalizePath(input: string): string`, `pathKey(input: string): string`, `formatETag(epoch: string, rev: number): string`, `parseETag(input: string): ETagParts` unchanged through `src/index.ts`. The parts schema becomes an internal module export solely so codec/type modules share it; do not add it to the package's public barrel.

- [ ] **Write RED surface tests** in `test/contracts.test.ts`: independently import the planned schema and codec modules; assert schema modules export only `PathSchema` or `EpochSchema`/`ETagSchema`/`ETagPartsSchema`, codecs export only their two functions, and the public barrel exports identical schema/function references. Keep Path/ETagParts assignments typechecked from their inferred type modules.
- [ ] **Run focused RED**: `bun run --cwd packages/protocol test -- test/contracts.test.ts`. Expected: missing new modules before moving implementation. Existing behavioral cases stay intact.
- [ ] **Move responsibilities** according to the file map. Keep `isValidPath` with its schema, NFC transform and exact existing checks. Keep ETag validation and the parts object schema in the schema module. Infer existing aliases with type-only imports. Do not reinterpret regexes, limits, errors or revision rules during this structural correction.
- [ ] **Update isolation overlay target** from deleted `src/path.ts` to stable `src/index.ts`; retain every existing negative/web/tooling assertion. Keep the legacy compiler instrumentation for this task so the deliverable remains independently green on the baseline toolchain.
- [ ] **Add useful TSDoc** to schema/type/codec declarations, private validation predicate, `AIBridgePlugin`/hooks and `buildPlugin`. Document input/output, relevant limits/normalization and thrown validation errors. Worker module documentation explains deliberate absence of routes and effects; avoid comments that merely repeat `new Hono()`.
- [ ] **Record AGENTS.md rules**: contracts and public API docs outside handlers; canonical Zod/inferred types; transport→application, application independent of platform SDKs; infrastructure behind necessary small ports; wiring-only composition; no empty layers or one interface per function. Review asks whether a contract/doc-only change forces unrelated implementation edits. Future API operation documentation stays separate from its handler; do not invent operations now.
- [ ] **Verify GREEN**: focused protocol tests, protocol typecheck, plugin tests/typechecks/build, then `bun run check`. Reviewer checks import direction and meaningful docs, not folder names alone. Confirm no behavior/manifest changes.
- [ ] **Commit and independently review** the meaningful deliverable before Task 2. Resolve scoped findings without replaying implementation.

## Task 2: Centralize Tools and Migrate Requested Latest Stable Dependencies

**Exact verified targets (2026-10-12):**

| Item | Target |
| --- | --- |
| Bun / Node / mise executable | `1.4.3` / `24.21.0` LTS / `2026.10.8` |
| checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`) |
| mise-action | `08ae2a091c038e1e05ec6f5115dc5c69d5a2a6b8` (`v5.1.2`) |
| Biome / Bun typings | `2.5.15` / `1.4.3` |
| TypeScript / Vitest | `7.0.2` / `5.0.4` |
| esbuild / Obsidian typings | `0.28.2` / `1.14.4` |
| Workers Vitest integration | Replace `@cloudflare/vitest-pool-workers` with `@cloudflare/vitest-plugin` `1.4.0` |

Do not silently sweep unrelated Hono, Zod, Wrangler or workers-types versions. Change an additional direct version only if a verified peer/type compatibility requirement demands it, recording why in OAB-22; a wider modernization is separate scope.

- [ ] **Write RED toolchain tests**: `mise.toml` owns exact Bun/Node pins; legacy `.bun-version` is absent; CI uses verified immutable checkout/mise pins and no setup-bun/duplicated runtime-version inputs; frozen install/check remain; annotated manifest versions and new plugin selection equal the target table. Assert both runtime and tooling typecheck commands remain. Run this file before changing configuration and confirm failure on baseline choices.
- [ ] **Set canonical tool config and CI**: create `mise.toml` with exact Bun/Node pins; remove `.bun-version`; replace setup-bun with pinned mise-action, explicitly pin its mise executable version. Continue `bun install --frozen-lockfile` and `bun run check`, preserve read-only CI permissions. Update README development setup to trust/install repo mise config and use its environment; no edits to global machine configuration.
- [ ] **Upgrade requested manifests and lock** to table targets; update Biome schema URL. Use `bun install` once for the intentional graph change, then frozen installs for evidence. Root scripts keep their aggregation/failure behavior.
- [ ] **Migrate Workers tests** with `defineConfig` from `vitest/config` and `cloudflareTest` from `@cloudflare/vitest-plugin`, `plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })]`, keeping `test.include: ['test/**/*.test.ts']`. Update only relevant old package/type references. Preserve all five real Workers cases and local-only execution; no remote bindings or deployments.
- [ ] **Migrate compiler regression to the installed TypeScript 7 CLI**, not a retained TypeScript 5 dependency or unverified unstable API. Create isolated temporary fixture projects mirroring actual protocol src/tests/configs, exact base config and dependency resolution. Add probes only to temporary copies of `src/index.ts` or existing test file; never mutate real sources. Invoke the installed compiler with `--noEmit --pretty false -p <fixture-config>`; preserve actual include roots so accidentally importing tooling exposes globals and fails the guard. Clean temporary files in `finally`.
- [ ] **Assert diagnostic integrity**: runtime fails only for the three expected missing globals, web probes are clean; separate tooling succeeds with process/Buffer. Fail on missing config/files/compiler, unrelated diagnostics or unexpected process status. Add a temporary leaky-runtime-config control that includes tooling roots and proves the detector catches accepted Node globals rather than merely finding the word "process" in output.
- [ ] **Run focused GREEN** for toolchain/isolation, real Worker tests and plugin tests/typechecks/build. Then frozen install + complete `bun run check` + `git diff --check`. Correct formatting only within the changed scope; no suppressed tests, ambient leaks or platform substitutions to make it pass.
- [ ] **Commit and independently review** latest-tool compatibility, restored isolation, old-reference removal, exact pins and absence of operational changes.

## Integrated Acceptance and Publication

- [ ] Final independent whole-branch review includes the actual owner findings, source split, docs and upgraded executables. Review must not mistake useful documentation for production platform qualification.
- [ ] Parent runs fresh frozen installation and full check at the reviewed exact source head; records actual outcomes once, not assumed stages. Existing 33 behavioral cases remain, plus correction regressions.
- [ ] Map all nine annotations to changed files/evidence in OAB-22; replace previous doc-Minor deferrals with actual resolution evidence, not rewritten history.
- [ ] Open human branch-diff review against `main`; address all annotations before publication. Then follow existing push/PR policy and require real remote CI before closing OAB-2 or declaring F0 complete. Do not start F1 automatically.

## Execution Boundaries and Proportion

Two tasks, because contract/documentation ownership and compiler/CI compatibility are separately reviewable deliverables. Preserve the already selected subagent-driven method and prescribed explicit model routes. Avoid extra scouts, full implementation restarts and identical checks on an unchanged head; distinguish purposeful RED/GREEN, independent review and final acceptance. A failed process needs its real logs before retrying.

The separate execution-time investigation is read-only and outside the repository; it does not alter this plan's scope or authorize changes to Superpowers, global Pi configuration, issues or exports.

**Approval:** Approved by the owner in Plannotator `pn-d3dfc4` on 2026-10-12, after replacing the machine-specific home path with `~/`.
