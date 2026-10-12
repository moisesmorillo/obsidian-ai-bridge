---
id: OAB-2
title: Establish shared protocol identity and the monorepo check pipeline
status: In Progress
assignee:
  - '@Moises'
created_date: '2026-10-12 13:17'
updated_date: '2026-10-12 13:58'
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
- [ ] #1 Bun workspaces expose packages/protocol and can add apps/worker and apps/plugin without duplicate protocol definitions.
- [ ] #2 Tests prove NFC path normalization, byte and segment limits, canonical lowercase keys, random-generation ETag syntax and unsafe revision rejection.
- [ ] #3 A frozen-lockfile install and bun run check pass locally and in CI; formatting, type errors and failed tests make the check fail.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add root and protocol workspace manifests/configuration plus path and ETag tests first; verify the protocol runner launches and fails on missing exports. 2. Implement Zod schemas and normalization/parsing exports; run focused protocol tests. 3. Add workspace lint/typecheck/test/build scripts and pinned read-only CI; resolve/pin dependencies and lockfile. 4. Run frozen install, full check, and temporary test/type/format failure probes; restore clean green state. 5. Self-review the scoped diff, record implementation/test evidence, commit feat: establish shared protocol identity and checks, and generate review package without finalizing task acceptance.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented root/protocol workspace manifests, pinned dependencies and lockfile, path/ETag schemas and exports, identity tests, Biome config, and read-only CI pinned to immutable Action commits. TDD RED: bun run --cwd packages/protocol test first could not launch without installed dependencies; after bun install, the runner started and both suites failed at the expected missing ../src/index export. GREEN: protocol suite 24/24 passed. Full validation: bun install --frozen-lockfile and bun run check passed (Biome, workspace typecheck, Vitest, build). Negative probes (each temporary and reverted; clean full check rerun): deliberately wrong path assertion caused test stage failure; invalid string-to-number source assignment caused TS2322/typecheck failure; formatting violation caused Biome lint failure. Dependencies purpose (already recorded on task): Zod sole protocol-shape owner, TypeScript/Bun types workspace checking, Vitest contract proof, Biome conventions. No acceptance criteria checked; pending independent review.

Correction round 1 (base b1e3f7b): added .bun-version (1.4.3), shared runtime-neutral tsconfig.base.json, and protocol tsconfig extension while retaining protocol-only ES2022/DOM lib and types: []. Negative existence check before correction confirmed both .bun-version and tsconfig.base.json missing. Verification: bun --version printed 1.4.3; .bun-version printed 1.4.3; CI remains pinned to bun-version: 1.4.3. `bun run --cwd packages/protocol tsc --showConfig -p tsconfig.json` showed inherited target es2022, module esnext, moduleResolution bundler, strict/noEmit/skipLibCheck true; protocol config preserved lib [es2022, dom], types [], and includes src/**/*.ts, test/**/*.ts, vitest.config.ts. Shared base contains no lib/types/runtime globals. Focused `bun run --cwd packages/protocol typecheck` passed. Initial full check caught Biome formatting in new base config; formatted that file and reran. `bun install --frozen-lockfile && bun run check` then passed; Vitest 2 files / 24 tests, lint/typecheck/build all passed. Lockfile unchanged. Correction changes limited to .bun-version, tsconfig.base.json, packages/protocol/tsconfig.json, and these OAB-2 notes; criteria remain unchecked and status remains In Progress.
<!-- SECTION:NOTES:END -->
