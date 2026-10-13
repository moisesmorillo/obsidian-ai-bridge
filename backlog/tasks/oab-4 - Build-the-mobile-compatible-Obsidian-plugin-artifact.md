---
id: OAB-4
title: Build the mobile-compatible Obsidian plugin artifact
status: Done
assignee:
  - '@pi'
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 15:08'
labels:
  - F0
  - plugin
dependencies:
  - OAB-2
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F0 must establish one production plugin package, not a parallel demo, before F3 implements synchronization. Its lifecycle is inert until the enrolled sync engine exists. Dependency purpose: Obsidian types define the host API and esbuild bundles the desktop/mobile-compatible plugin; no Node or Electron runtime API is allowed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The plugin manifest declares minAppVersion 1.13.0 and isDesktopOnly false.
- [x] #2 The build produces main.js and manifest.json in the same directory, with Obsidian external and no Node or Electron runtime dependency.
- [x] #3 Lifecycle tests prove no connection, vault mutation or persistent writes occur in the F0 entry point, and bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add lifecycle and artifact tests first, including the root aggregation-failure probe. 2. Declare and install Obsidian API types and esbuild for host typing and browser-platform CommonJS packaging; use existing Vitest for tests and add no test dependency. 3. Implement inert Plugin subclass, manifest, isolated web runtime typecheck and tooling typecheck. 4. Run plugin RED/GREEN, root check, exact-head frozen/check validation and negative aggregation probe. 5. Self-review scoped diff, commit feat: add mobile-compatible plugin build.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Dependency purposes before install: obsidian types package supplies host Plugin API types; esbuild bundles browser-compatible CommonJS plugin output. Vitest already exists at root and will be reused.

Implemented inert production Plugin lifecycle, manifest, browser CommonJS esbuild bundle and lifecycle/artifact assertions; tooling and web runtime types are checked separately. Dependency purposes before install: obsidian 1.8.7 supplies Obsidian host API types; esbuild 0.25.10 creates the bundled artifact; existing root Vitest is reused. TDD RED (parent bg_run b589a5f62): bun install && bun run --cwd apps/plugin test; Vitest launched; both suites failed on absent ../build and ../src/main, expected missing production implementation. Focused first GREEN attempt passed 2/2 tests, then typecheck uncovered optional metafile and required Plugin constructor parameters; corrections applied based on actual typings. Focused GREEN parent bg_run bf07eebe3 passed 2 files/2 tests, runtime/tool typechecks and plugin build. Root aggregation probe first stopped at Biome (bg_run b885327a0; formatting/import failures corrected with scoped Biome formatting). Intended failing assertion probe parent bg_run b2b07dad6 reached plugin artifact test after lint/typechecks, failed expected actual 0.1.0 vs deliberate expected 0.0.0; lifecycle and protocol/Worker tests passed. Probe assertion restored. Self-review changed the builtin check to derive names via node:module builtinModules (tooling test only). Final restored frozen check parent bg_run b46d4dfeb passed; after self-review correction final parent bg_run b6fcdd20c passed: frozen install, root check (Biome 27 files; all typechecks; 31 tests protocol24/Worker5/plugin2; all builds), git diff --check. Wrangler build was dry-run only, no deploy.

Parent acceptance ba85b9eb4 ran at reviewed head270f2588659d4fb56174ff0db9fbbb6161afa086: frozen install/full check/diff exited0;31 tests and all lint/typecheck/build stages passed. Independent reviewer7e825228-e1ff-457a-9e57-81b9f540ca60 approved spec and quality, no Critical/Important issues. One non-blocking TSDoc suggestion is recorded in the SDD ledger for final whole-branch triage. Actual Obsidian installation/mobile measurement are outside F0 and not claimed. OAB-4 criteria verified; remote CI remains separately pending in OAB-2.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the inert production plugin, minAppVersion1.13.0/mobile-enabled manifest, browser/CommonJS bundle and lifecycle/artifact assertions with separate runtime/tool types. Parent verified RED, strict-type corrections, actual negative aggregate-check failure, restored31-test full checks and exact-head acceptance. Independent spec/quality review approved; no vault installation, sync behavior or measured mobile claim.
<!-- SECTION:FINAL_SUMMARY:END -->
