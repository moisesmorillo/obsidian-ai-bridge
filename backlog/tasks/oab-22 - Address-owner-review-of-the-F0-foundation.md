---
id: OAB-22
title: Address owner review of the F0 foundation
status: In Progress
assignee:
  - '@Moises'
created_date: '2026-10-12 18:02'
updated_date: '2026-10-12 21:49'
labels: []
dependencies: []
references:
  - docs/spec.md
type: chore
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner review pn-ffdc61 found stale Action and tooling selections, missing useful documentation, and maintenance coupling between contracts and implementation. The owner validated lightweight layer separation and authorized the nine corrections plus enforceable AGENTS.md guidance. This is corrective F0 work, not authorization for future-phase features or deployment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CI and local tools use one mise configuration with exact versions, and Actions use immutable release commit pins.
- [ ] #2 Annotated root and plugin dependencies use verified current stable versions; required TypeScript and Workers test integration migrations preserve all existing behavior and runtime isolation.
- [ ] #3 Protocol contracts, inferred types and their public documentation are independently editable from codecs; public exports and path/ETag behavior remain compatible.
- [ ] #4 Useful TSDoc covers the annotated public declarations and inert plugin/Worker intent; AGENTS.md records operational lightweight layer rules without empty layers or duplicate shapes.
- [ ] #5 Fresh bun run check and frozen installation pass; independent review and human diff review close the corrections before publication.
- [ ] #6 Owner-requested workspace-local import aliases replace relative module imports throughout source and tests, resolve in TypeScript and real test/build runtimes, and preserve public package boundaries and runtime isolation.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
APPROVED in Plannotator pn-d3dfc4: docs/superpowers/plans/2026-10-12-f0-review-corrections.md. Execute its two serial deliverables using the owner-selected Superpowers subagent method. Task 1 owns protocol contract/type/codec separation and useful docs/AGENTS.md rules. Task 2 owns mise/CI/requested latest tooling and required TypeScript/Workers integration migrations. Independent task reviews, final whole-branch review, exact-head verification and human diff gate remain required. No F1 or deployment; remote CI remains OAB-2 publication acceptance.

Additional owner review pn-23690c: aliases throughout source/tests, confirmed scope in conversation. Pending plan approval: docs/superpowers/plans/2026-10-12-workspace-import-aliases.md. One bounded alias integration task; retain the selected subagent-driven method, exact dependency versions, public package exports, real Workers and browser plugin evidence. No implementation until plan gate.

Owner approved alias integration plan in pn-16fcc7. Execute its one task using preserved subagent-driven method, native private package imports and matching tsconfig paths, exact existing dependencies, consumer/isolation/runtime regressions, independent review and renewed final human gate.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner authorized all nine validated review corrections and AGENTS.md policy. Latest-package migrations are necessary compatibility work: TypeScript 7 lacks the legacy compiler API used by the isolation test; current Workers pool does not support Vitest 5. Replacing it with @cloudflare/vitest-plugin is justified by its verified peer support. New plan must be reviewed in Plannotator before implementation. Separate time-diagnosis artifacts live outside the repository.

Pre-correction baseline bg_run b0fb70dab passed at source/metadata HEAD dd23d706853aa40c766f62ae1d8ad359e36c3518: frozen install unchanged, Biome 29 files, all runtime/tooling typechecks, protocol26 + Worker5 + plugin2 =33 tests, all local builds including Worker dry-run, git diff --check clean. Task OAB-22 was the only untracked file at the check snapshot; the pending corrective plan was written afterward. No claim of post-correction success or remote CI. Implementation still waits for plan review pn-7b66e4.

Addressed pn-7b66e4 annotation: corrective plan uses the portable ~/.worktrees/ path, with no hardcoded /Users/ references. Future repository documentation uses repo-relative paths or ~/; shell examples use $HOME when expansion is needed. Plan approval still pending; no implementation started.

Owner approved corrected portable-path plan in pn-d3dfc4; implementation starts from the verified 33-test baseline.

Task 1 accepted: source commit250432b, real missing-module RED, final parent checkb2e33ff68 passed36tests/allstages; fresh independent reviewd54af9eb approved spec and quality with no findings. Contract/type/codec separation, meaningful docs and AGENTS.md rules implemented without public behavior changes. Begin Task 2 per approved plan; no overall closure, remote CI or final human acceptance claimed.

Verified compatibility rationale for one additional direct development dependency: installed Obsidian1.14.4 declares exact @codemirror/view6.43.13 and state6.7.6 peers. Initial approved installb517d6b84 resolved view6.43.14 and warned incorrect peer; lock and installed manifest independently checked by parent. Authorize only exact @codemirror/view6.43.13 in apps/plugin devDependencies and corresponding lock resolution; state already6.7.6 needs no change. Required peer satisfaction under the approved conditional scope, not a general upgrade or new runtime capability.

Task 2 accepted: source32caeb35ab4831a72fab82f65eb1643caf9ec967; parent full GREENb9b89314b passed frozen unchanged install, Biome35files, every workspace typecheck,40tests(protocol33/Worker5/plugin2), all local builds including Worker dry-run and diff check. Fresh independent review0d51816d approved spec and quality with no findings. Native TS7 CLI isolation and leaky controls retained; verified host-file cache incompatibility resolved with supported Worker-only fsModuleCache:false; removed TS7 baseUrl without widening roots; generated .vitest reports ignored/excluded only. Initial failures and stopped stages remain recorded in implementation report; no retrospective passing claims.

All nine owner annotation implementations mapped: 1 current immutable Action pins in CI;2 canonical mise.toml, no legacy Bun pin and README setup;3 meaningful plugin lifecycle/build TSDoc;4 requested plugin tooling/typings plus justified exact peer;5 default-deny Worker intent documentation;6 canonical protocol schemas/types/codecs/barrel and lightweight AGENTS boundaries;7 ETag contract/codec documentation;8 path contract/helper documentation;9 requested root dependencies with compiler and Workers migration. Task1 reviewd54af9eb and Task2 review0d51816d accept the implementations. Previous documentation-Minor deferrals are historical and superseded by250432b, not rewritten. Final whole-branch review, fresh exact-head check, owner diff review and real remote CI remain open; OAB-22 and OAB-2 not closed.

Final corrected whole-branch reviewdc2e391e approved65files/nofindings at438e221; fresh exact-headbc3c37519 passed40tests/allchecks/frozenunchanged/cleantree. Owner pn-23690c then requested one additional import-alias convention and selected all source/tests across the repo. Verified relative imports are present and protocol paths absent: confirmed maintenance convention gap, not functional bug; relative usage pre-existed and the schema split added nested imports. No source/config changes for aliases yet, no publication; previous final approval does not cover the new request.

Alias plan pn-16fcc7 approved before source changes; names #protocol/*, #worker/*, #plugin/* and #plugin-tools/build, source/tests scope. Previous source438e221 exact full40test checkbc3c37519 is the baseline; no redundant baseline rerun. Parent-run TDD and actual installed toolchain compatibility remain required.

Additional alias correction accepted: be21625ec3c4cd2fb19ddedcedf911276d1280e7, owner-approved plan pn-16fcc7, fresh task review7bb7dc53 spec/quality Approved with no findings. Parent complete GREENbb8d0167f: focused10 tests, frozen123/274 unchanged, Biome36files, all runtime/tooling typechecks,49tests(protocol41/realWorkers6/plugin2), local builds including Worker dry-run, diff clean. All40 prior cases retained plus9 alias cases. Native private package imports pair with TS paths; public consumer compiles/bundles/executes without private paths; relative value/type import policy diagnostics and allowed controls verified; compiler fixtures already copy actual package metadata; plugin tooling inherits aliases without leaking its roots/types into runtime. Initial invalid RED/harness failures remain history, separate editor diagnostic cause remains unproven, no suppression. Renew final whole-branch review/exact-head verification/human diff gate before publication; OAB22 and OAB2 remain In Progress.
<!-- SECTION:NOTES:END -->
