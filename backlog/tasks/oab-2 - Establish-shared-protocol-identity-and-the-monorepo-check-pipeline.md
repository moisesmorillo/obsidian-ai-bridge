---
id: OAB-2
title: Establish shared protocol identity and the monorepo check pipeline
status: In Progress
assignee:
  - '@Moises'
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 16:34'
labels:
  - F0
  - protocol
dependencies: []
documentation:
  - docs/spec.md
  - docs/superpowers/plans/2026-10-12-f0-foundation.md
type: feature
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F0 needs executable contracts shared by all runtimes before backend or plugin behavior is built. The current repository has no package manifests or test pipeline. Dependency purpose: Zod defines the sole protocol shapes; TypeScript and Bun types check the workspaces; Vitest proves the contracts; Biome enforces repository conventions. Exact compatible versions must be pinned during implementation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Bun workspaces expose packages/protocol and can add apps/worker and apps/plugin without duplicate protocol definitions.
- [x] #2 Tests prove NFC path normalization, byte and segment limits, canonical lowercase keys, random-generation ETag syntax and unsafe revision rejection.
- [ ] #3 A frozen-lockfile install and bun run check pass locally and in CI; formatting, type errors and failed tests make the check fail.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add root and protocol workspace manifests/configuration plus path and ETag tests first; verify the protocol runner launches and fails on missing exports. 2. Implement Zod schemas and normalization/parsing exports; run focused protocol tests. 3. Add workspace lint/typecheck/test/build scripts and pinned read-only CI; resolve/pin dependencies and lockfile. 4. Run frozen install, full check, and temporary test/type/format failure probes; restore clean green state. 5. Self-review the scoped diff, record implementation/test evidence, commit feat: establish shared protocol identity and checks, and generate review package without finalizing task acceptance.

Correction round 2: retain the virtual compiler-API regression test and verify the current-config RED through the parent background runner before any config edits; split protocol runtime source and test/tool compilation; canonical typecheck checks both, build checks runtime only; verify process/Buffer/Bun rejection plus web/tool positive controls and full integrated green through parent bg_run. Remote CI criterion remains unchecked; no criteria or final status changes.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented root/protocol workspace manifests, pinned dependencies and lockfile, path/ETag schemas and exports, identity tests, Biome config, and read-only CI pinned to immutable Action commits. TDD RED: bun run --cwd packages/protocol test first could not launch without installed dependencies; after bun install, the runner started and both suites failed at the expected missing ../src/index export. GREEN: protocol suite 24/24 passed. Full validation: bun install --frozen-lockfile and bun run check passed (Biome, workspace typecheck, Vitest, build). Negative probes (each temporary and reverted; clean full check rerun): deliberately wrong path assertion caused test stage failure; invalid string-to-number source assignment caused TS2322/typecheck failure; formatting violation caused Biome lint failure. Dependencies purpose (already recorded on task): Zod sole protocol-shape owner, TypeScript/Bun types workspace checking, Vitest contract proof, Biome conventions. No acceptance criteria checked; pending independent review.

Correction round 1 (base b1e3f7b): added .bun-version (1.4.3), shared runtime-neutral tsconfig.base.json, and protocol tsconfig extension while retaining protocol-only ES2022/DOM lib and types: []. Negative existence check before correction confirmed both .bun-version and tsconfig.base.json missing. Verification: bun --version printed 1.4.3; .bun-version printed 1.4.3; CI remains pinned to bun-version: 1.4.3. `bun run --cwd packages/protocol tsc --showConfig -p tsconfig.json` showed inherited target es2022, module esnext, moduleResolution bundler, strict/noEmit/skipLibCheck true; protocol config preserved lib [es2022, dom], types [], and includes src/**/*.ts, test/**/*.ts, vitest.config.ts. Shared base contains no lib/types/runtime globals. Focused `bun run --cwd packages/protocol typecheck` passed. Initial full check caught Biome formatting in new base config; formatted that file and reran. `bun install --frozen-lockfile && bun run check` then passed; Vitest 2 files / 24 tests, lint/typecheck/build all passed. Lockfile unchanged. Correction changes limited to .bun-version, tsconfig.base.json, packages/protocol/tsconfig.json, and these OAB-2 notes; criteria remain unchecked and status remains In Progress.

Parent acceptance verification b00019da3 at 7e50e83: bun install --frozen-lockfile, bun run check and git diff --check exited 0; 24/24 tests, lint, types and build passed. Independent task review and scoped configuration correction review approved; no outstanding code findings. Criteria 1 and 2 verified. Criterion 3 is only locally verified: remote GitHub CI has not run and remains unchecked. Task remains In Progress pending real CI after branch publication. Subsequent local F0 tasks may consume the independently approved local dependency; this does not waive F0 exit gates.

New local isolation blocker from final whole-branch F0-I1: Vitest declaration imports brought Node ambient declarations into protocol production source despite types: []. Parent verified source probe process/Buffer passed under current config (83 Node declaration files); Bun is already rejected. Added packages/protocol/test/runtime-isolation.test.ts first with virtual overlay (no production source writes). Parent bg_run RED: `bun run --cwd packages/protocol test -- test/runtime-isolation.test.ts` exit 1; 2 tests executed, runtime isolation assertion failed because actual identifiers were [Bun] only (process/Buffer incorrectly accepted); tooling control passed. Awaiting approved narrow runtime/tools project split. Criterion #3 remains unchecked for remote CI; task remains In Progress. F0-M1/M2 documentation findings remain intentionally out of scope/deferred.

F0-I1 correction attempt: parent bg_run b2d9de6b1 ran focused isolation test, both protocol tsc projects, runtime build, frozen install, then root check. Actual result: focused runtime-isolation tests 2/2 passed (1.22s); runtime and tooling TypeScript projects both passed; runtime build passed; frozen install made no changes. Root check STOPPED at Biome because formatting/import ordering errors occurred only in new packages/protocol/test/runtime-isolation.test.ts and packages/protocol/tsconfig.tools.json; root test/typecheck/build stages did NOT run. Applied only Biome safe formatting to those two files, no rule or test logic changes. Re-request full frozen-install/root check; no full GREEN claimed until parent logs. Remote CI criterion #3 remains unchecked; OAB-2 remains In Progress; F0-M1/M2 doc deferrals untouched.

F0-I1 validation completed by parent bg_run b29bffd2d after Biome-only formatting of runtime-isolation.test.ts and tsconfig.tools.json. Exact actual summary: `bun install --frozen-lockfile` exit 0/no lock changes; `WRANGLER_SEND_METRICS=false bun run check` exit 0; Biome 29 files clean; all workspace typechecks passed including protocol runtime and tooling projects; tests 33 total passed (protocol 26 = 14 path + 10 ETag + 2 isolation, Worker 5, plugin 2); all builds passed (protocol runtime tsc, plugin artifact, Worker dry-run without bindings); `git diff --check` passed. This follows verified RED baeea4d5d and focused GREEN plus two-project typechecks/runtime build from b2d9de6b1, whose root pipeline stopped at Biome before global formatting. No source behavior/config/test logic changed after b29bffd2d validation; only this OAB-2 note update follows. CI criterion #3 remains unchecked pending remote CI; task remains In Progress and no criteria were checked. F0-M1/M2 are still intentionally deferred and untouched.

Final local approval: whole-branch Sol review2bed378c inspected53 files and found one Important F0-I1 ambient Node type leak; fix281cbb5 plus fresh scoped reviewe327d984 resolved it with no introduced breakage. Parent final exact-head acceptance b5be7d60a at281cbb58a14def8083b9cd837bcd156c622d400d exited0: frozen lock unchanged; Biome29 files; all workspace typechecks including runtime+tools protocol projects;33 tests(protocol26/Worker5/plugin2); all local builds and clean diff/tree. Local source gate is complete again. Two documentation Minors remain explicitly nonblocking/deferred until next relevant seam changes; not marked fixed. Human branch-diff review still pending, remoteCI3 still unchecked and official task remains In Progress. No deployment, personal vault access, measured device compatibility, full product acceptance or F0 completion claimed.
<!-- SECTION:NOTES:END -->
