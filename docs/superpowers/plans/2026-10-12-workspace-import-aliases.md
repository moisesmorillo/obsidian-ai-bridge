# Workspace Import Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One writer, one task review, then final branch review and the existing human publication gate.

**Goal:** Address owner review `pn-23690c`: replace relative module imports throughout source and tests with workspace-local aliases, without changing behavior or public package boundaries.

**Architecture:** Proposed builder choice: private `#protocol/*`, `#worker/*`, `#plugin/*` aliases point to each workspace's `src`. TypeScript `paths` and native package `imports` agree; native package-scoped resolution prevents public protocol consumers from needing another workspace's private tsconfig. `#plugin-tools/build` addresses the existing build helper from tests, never production source. No resolver dependency or global catch-all alias.

**Tech Stack:** Existing TypeScript 7.0.2, Bun 1.4.3, Vitest 5.0.4, Cloudflare Vitest plugin 1.4.0, esbuild 0.28.2, Biome 2.5.15; no version changes.

**Spec:** Owner review `pn-23690c` and subsequent choice “Todo el repo”; `docs/spec.md`, `AGENTS.md`, OAB-22 acceptance criterion 6. Alias spelling above is a proposed technical choice, not a prior owner naming instruction.

## Global Constraints

- Continue in the existing linked worktree `~/.worktrees/obsidian-ai-bridge/chore/f0-plan`, branch `chore/f0-plan`; source baseline `438e2212c131a02a319e90c279859658c4e6816e` passed 40 tests and all local checks.
- Change module imports/re-exports, not filesystem paths, URLs, tsconfig `extends`, dependency imports, or resource names.
- Between packages use `@obsidian-ai-bridge/protocol` and its existing public exports. Private aliases do not authorize importing another workspace's internals.
- Zod remains the only protocol shape owner. Preserve schema/type/codec boundaries, public references, validation and every existing test case.
- Preserve source-only runtime roots, separate tooling checks, `types: []`, platform libraries, the exact Obsidian declaration mapping, and the native compiler isolation guard.
- Preserve plugin id `ai-bridge`, `minAppVersion: 1.13.0`, `isDesktopOnly: false`, inert lifecycle, browser/CommonJS output and only Obsidian externalization.
- Keep five real Workers cases and `test.fsModuleCache: false`; no mocks, skips, cache deletion, versions/dependency sweep or weakened checks.
- No `baseUrl` (removed in TS7), new dependency, product feature, deployment, resource/vault access, release, or global machine changes.
- Parent runs long installs/tests/builds with `bg_run` and returns actual outcomes. Child waits through ordinary supervisor checkpoints; no foreground substitute.
- Repository documentation uses relative or `~/` paths. Existing approved plans/reviews are history, not to be rewritten.

## Review Focus

1. TypeScript succeeds but runtime cannot resolve an alias: exercise actual protocol, plugin and Workers tests, plus their existing builds.
2. Public raw-TS protocol consumers lack the producer's tsconfig: compile and bundle a temporary consumer of the public package export, without adding an application dependency just for the fixture.
3. Alias changes undermine ambient isolation: mirror actual paths/package metadata in temporary compiler fixtures; retain exact missing-global, browser, tooling and leaky-config controls.
4. Tooling aliases pull Node/Bun into plugin runtime: keep tooling imports out of production source and preserve artifact builtin/externalization assertions.
5. Mapping drift or relative imports return: contract-test exact `paths`/`imports` pairs and enforce relative-import policy with the existing Biome rule; do not mistake filesystem strings for module imports.

## File Map

- Modify `packages/protocol/{package.json,tsconfig.json}`: source alias ownership and native runtime mapping; tooling inherits source mappings.
- Modify `apps/worker/{package.json,tsconfig.json}`: its own source alias, not protocol private paths.
- Modify `apps/plugin/{package.json,tsconfig.json}`: its own source/build aliases; retain `obsidian` mapping and source roots. Inspect inherited tooling config before changing it.
- Modify `packages/protocol/src/index.ts`, `src/codecs/{path,etag}.ts`, `src/types/{path,etag}.ts`: module specifiers only. Schema modules' external Zod imports do not need changes.
- Modify `packages/protocol/test/{contracts,path,etag}.test.ts` and `apps/plugin/test/{artifact,lifecycle}.test.ts`: consume corresponding private aliases, preserving assertions.
- Modify `packages/protocol/test/runtime-isolation.test.ts`: copy actual package metadata in addition to actual sources/tests/configs if needed for native import resolution; retain guard semantics and `finally` cleanup.
- Create `packages/protocol/test/import-aliases.test.ts`: exact mapping/policy contracts and public-consumer resolution regression using existing tools and temporary fixtures.
- Modify `apps/worker/test/entry.test.ts`: add a targeted private alias import assertion while preserving the five existing `SELF.fetch` cases in the real runtime.
- Modify `biome.json`, `AGENTS.md`: import convention and existing `style/noRestrictedImports` policy; generated directory exclusions unchanged.
- Test existing plugin/browser artifact, Worker dry-run and compiler projects. Change a Vitest/build config only for a demonstrated alias-resolution requirement, preserving existing platform/external/mock semantics and recording why.
- `bun.lock`: only if existing workspace metadata requires refresh; no graph/version changes. Parent owns Backlog metadata.

## Task 1: Integrate and Prove Workspace-Local Aliases

**Consumes:** Existing public `PathSchema`, `normalizePath`, `ETagSchema`, `formatETag`, `parseETag`; existing `buildPlugin()`; inert Worker and plugin entry points.

**Produces:** No new product API. Aliases below work for internal source/tests; public protocol imports remain independently consumable.

| Workspace | TypeScript `paths` | Native package `imports` |
| --- | --- | --- |
| Protocol | `#protocol/*` → `./src/*` | `#protocol/*` → `./src/*.ts` |
| Worker | `#worker/*` → `./src/*` | `#worker/*` → `./src/*.ts` |
| Plugin | `#plugin/*` → `./src/*` | `#plugin/*` → `./src/*.ts` |
| Plugin tooling | `#plugin-tools/build` → `./build.ts` | `#plugin-tools/build` → `./build.ts` |

- [ ] **Write RED mapping/policy regression first.** `import-aliases.test.ts` asserts these exact entries, absence of `baseUrl`, preservation of the Obsidian target and public protocol export, and the relative-import restriction. Request parent focused run before changing configuration; baseline must fail for missing alias configuration, not unrelated diagnostics.
- [ ] **Declare mappings.** Add only the table entries, preserving existing paths and compiler options. Package imports stay private and workspace-local. Do not move the maps to the ambient-neutral shared base or add resolver libraries.
- [ ] **Migrate module specifiers.** Use `#protocol/schemas/etag`, `#protocol/types/etag`, `#protocol/codecs/etag`, `#protocol/index`, `#plugin/main`, and `#plugin-tools/build` as applicable. No schema/codec bodies, lifecycle effects, public export additions or fixture assertion removals.
- [ ] **Keep compiler fixtures faithful.** Copy actual package metadata and aliases into temporary projects where required; changing a runtime include to admit tooling must still fail the guard. Retain clean web probes, successful tooling Node globals, exact three missing runtime globals, unrelated-diagnostic rejection and cleanup.
- [ ] **Prove runtime and public consumption.** Existing protocol module/reference tests now run through aliases. Worker test imports `#worker/index` in the actual Workers pool and checks its default-deny handler, alongside the unchanged five SELF cases. A temporary external consumer imports the public package, validates `Notes/example.md` and a valid quoted ETag using the actual compiler and installed esbuild; consumer config must not define `#protocol/*`. Clean fixtures in `finally`, no demo or persistent parallel package.
- [ ] **Enforce the convention.** Document private aliases/public boundaries and tooling exclusion in AGENTS. Configure existing Biome `style/noRestrictedImports` with `patterns: [{ group: ["./*", "../*"], message: "Use workspace-local import aliases." }]`. Verify actual relative value/type import diagnostics and allowed native/builtin/public imports using temporary stdin fixtures; source and tests remain linted. Do not add a parser dependency or suppress existing rules.
- [ ] **Run GREEN and commit.** Scoped Biome check/write first; parent frozen install + complete `bun run check` + `git diff --check`. All 40 existing cases and new regressions must pass, all runtime/tooling checks and local builds must actually run. Commit owned files only after actual success; report RED/GREEN and any resolution adjustment, not speculative later stages.
- [ ] **Review and publication gates.** Fresh task reviewer checks spec/quality; address concrete findings with scoped retained-writer fixes and re-review. Final whole-branch review and fresh exact-head verification precede a new human diff review. No PR or task closure before human feedback; OAB-2 still requires actual remote CI, and F1 does not start automatically.

## Execution

Preserve the owner-selected subagent-driven method: fresh planned implementer `openai/gpt-6-luna:medium`, full task reviewer `openai/gpt-6-luna:high`, scoped re-review `openai/gpt-6-luna:medium`, final whole-branch reviewer `openai/gpt-6.1-sol:medium`. One integration task, no extra scouts or repetitive unchanged-head checks.

**Approval:** Approved by the owner in Plannotator `pn-16fcc7`. Alias implementation starts after the planning checkpoint; no alias code was changed before approval.
