# Review Quality Enforcement Implementation Plan

> **For agentic workers:** Use `executing-plans` for native execution. Use `subagent-driven-development` only if the owner selects delegation.

**Goal:** Close the baseline audit findings in one PR and prevent mechanical documentation regressions.

**Architecture:** Keep documentation checks and shared test configuration in root tooling.
Keep production contracts with their semantic owners.
Preserve the SQLite schema, transaction boundaries, protocol behavior, and runtime isolation.

**Tech Stack:** Bun, TypeScript 7, Biome, Vitest, native Workers tests, Drizzle, and development-only documentation parsers.

**Spec:** `docs/spec.md`, the accepted audit in this conversation, and task OAB-24.

## Global Constraints

- Use branch `chore/review-quality-enforcement` in `~/.worktrees/obsidian-ai-bridge/chore/review-quality-enforcement`.
- Deliver one PR against `main`. Do not merge locally.
- Do not change Cloudflare resources, git identity, the personal vault, or later F1 scope.
- Keep protocol shapes canonical in `packages/protocol`. Do not add competing persisted or transport shapes.
- Preserve exact schema admission, atomic bootstrap, existing identity, and failure without repair.
- Keep all new tooling dependencies outside production imports and bundles.
- Record any dependency reason and exact selected version in OAB-24 before installation.
- Use English and Simplified Technical English for new prose.
- Get human approval of this plan before implementation.
- Get human approval of the branch diff before publication.

## Execution Method

Proposed method: native execution in this session, with test-first tooling work and a final independent semantic review.
The owner can select subagent-driven execution in the plan feedback.
No implementation starts before that feedback.

## Review Focus

- Missing internal documentation must fail the gate, not only missing exported API comments.
- Generated code and ordinary local variables must not create false documentation obligations.
- Tooling imports must not introduce Node or parser dependencies into production.
- Shared alias conversion must preserve exact matching and existing configured consumer behavior.
- Invalid bootstrap factories must leave no partial schema or metadata.

## Finding Ledger

| Finding | Planned closure |
| --- | --- |
| Storage models lack contracts | Task 2 documents each table and non-obvious fields. |
| Worker construction and binding contracts lack documentation | Task 2 documents bindings, augmentation, and constructor effects. |
| Test helpers lack contracts | Tasks 2 and 3 document named validation helpers. |
| Three alias conversion implementations | Task 3 gives conversion one tooling-only owner. |
| Repeated storage teardown | Task 4 gives the fixture operation one owner. |
| Missing bootstrap input cases | Task 4 tests each failure and rollback boundary. |
| No documentation gate | Task 1 adds tested syntax and declaration checks. |
| Weak review enforcement | Task 2 changes AGENTS.md and Task 5 records finding closure. |
| No fresh pinned validation | Task 5 records fresh results from the isolated worktree. |

Coverage percentages remain unknown.
This PR adds explicit behavior cases and records that limit.
Do not claim numerical coverage or add a coverage provider without checking native Workers support.

## Task 1: Add Tested Documentation Checks

**Files:**
- Create: `tooling/documentation.ts`
- Create: `tooling/check-documentation.ts`
- Create: `tooling/test/documentation.test.ts`
- Create: `tooling/vitest.config.ts`
- Create: `tooling/tsconfig.json`
- Change: `package.json`
- Change: `bun.lock`
- Change: `tsconfig.aliases.json`
- Change: `packages/protocol/test/import-aliases.test.ts`

**Interfaces:**
- `checkDocumentation(path: string, source: string): DocumentationFinding[]`
- `DocumentationFinding` contains `path`, `line`, `declaration`, `rule`, and `message`.
- The CLI exits nonzero when findings exist or source reading or parsing fails.
- Add tooling scripts to the root check, typecheck, and test commands.
- Add `@tooling/*` as a tooling-only alias. Preserve the existing source aliases.

**Dependency decision:**
Use `@microsoft/tsdoc` for comment syntax and `@ast-grep/napi` for TypeScript syntax inventory.
TypeScript 7 does not provide the legacy compiler API used by many documentation examples.
First verify the package APIs, native support, and exact versions.
If either package fails that probe, stop and revise the plan rather than invent another compiler layer.

**Mechanical policy:**
Check named functions, function-valued bindings, classes, interfaces, type aliases, enums, and named methods.
Check exported semantic bindings, runtime schemas, and authoritative constant objects.
Check constructors with executable bodies.
Check all tracked hand-written TypeScript source, tooling, configuration, and named test helpers.

Do not demand separate comments for imports, re-exports, anonymous callbacks, ordinary locals, trivial literals, or obvious fields.
Exclude generated files by explicit path or a tested generation marker.
Do not use visibility as an exemption.
Property-level semantics and comment truth remain manual review duties.

Parse existing TSDoc blocks and reject syntax diagnostics.
Reject absent or empty documentation for selected declarations.
Do not claim that a parser detects every empty paraphrase, stale guarantee, or false contract.
Keep declaration selection small and explicit, not a generic configurable lint framework.

- [x] Verify parser APIs and record exact dependency versions and reasons in OAB-24.
- [x] Write tests before the checker implementation.
- [x] Test exported functions, internal helpers, private methods, accessors, constructors, interfaces, schemas, and function-valued bindings.
- [x] Test missing comments, empty comments, malformed tags, misplaced comments, and unreadable or malformed source.
- [x] Test documented declarations, generated files, anonymous callbacks, ordinary variables, and re-exports as allowed controls.
- [x] Observe meaningful RED for the absent checker. Package-loader failures do not count as behavior RED.
- [x] Implement the inventory and TSDoc check behind the stated interface.
- [x] Add CLI integration tests with cause-specific findings and exit codes.
- [x] Connect the gate to `bun run check` without weakening existing checks.
- [x] Extend alias contract tests for the new tooling alias without relaxing existing assertions.
- [x] Run the focused tooling tests and tooling compiler.
- [x] Commit with `feat(tooling): enforce declaration documentation checks`.

## Task 2: Correct Contracts and Agent Rules

**Files:**
- Change: `apps/worker/src/infrastructure/sqlite/schema-model.ts`
- Change: `apps/worker/src/env.ts`
- Change: `apps/worker/src/infrastructure/durable-object/vault.ts`
- Change: named hand-written declarations selected by the gate across `apps/`, `packages/`, and `tooling/`
- Change: `AGENTS.md`

**Contracts:**
Document all ten relational models and `vaultSchema`.
Explain live-path uniqueness, revision identity, client-scoped receipts, pin ownership, units, and important nullable fields.
Distinguish physical schema constraints from application obligations.
Do not promise that storage bootstrap implements later mutation, authorization, retention, or export behavior.

Document `WorkerBindings`, exported `Env`, its global augmentation, and constructor side effects.
Keep useful existing contracts unless review finds a specific error.
Do not add tags solely to repeat obvious types.

**Agent rules:**
State declaration coverage, useful semantic contracts, explicit exemptions, and constructor duties.
State operation-specific array guidance without banning loops or conditionals.
State that green automation does not replace the code-review skill or its TypeScript profile.
State that every actionable finding needs a supported closure entry.
Keep one root AGENTS.md.

- [x] Run the new gate against the baseline and retain concrete missing-contract findings.
- [x] Add useful documentation with implementation, callers, tests, and specification evidence.
- [x] Document important test and configuration helpers selected by the same mechanical policy.
- [x] Add the agreed AGENTS.md rules with short, separate paragraphs.
- [x] Run documentation checks and manually compare each new contract with behavior.
- [x] Confirm that documentation edits do not change generated DDL or runtime behavior.
- [x] Commit with `docs: define semantic contracts and review duties`.

## Task 3: Share Tooling Alias Conversion

**Files:**
- Create: `tooling/vite-aliases.ts`
- Create: `tooling/test/vite-aliases.test.ts`
- Change: `apps/worker/vitest.config.ts`
- Change: `apps/plugin/vitest.config.ts`
- Change: `packages/protocol/vitest.config.ts`
- Change: `packages/protocol/test/runtime-isolation.test.ts`
- Change: `packages/protocol/test/import-aliases.test.ts`

**Interface:**
`resolveViteAliases(repositoryRoot: string, paths: Record<string, string[]>, names: readonly string[]): Array<{ find: string; replacement: string }>`

Keep selected names and workspace-specific options in each workspace.
Retain one authoritative mapping in `tsconfig.aliases.json`.
Do not put tooling exports in the production protocol package.

- [x] Write tests for wildcard aliases, the exact plugin-build alias, missing mappings, and repository-root resolution.
- [x] Observe RED before implementing the shared resolver.
- [x] Implement the helper and replace the three conversion copies.
- [x] Preserve copied fixture dependencies when test configurations import the new tooling helper.
- [x] Keep negative compiler controls cause-specific. Do not accept missing-tooling errors as successful isolation evidence.
- [x] Run resolver tests, alias tests, runtime-isolation tests, and all three native workspace suites.
- [x] Confirm that production source projects cannot get tooling globals or parser imports.
- [x] Commit with `refactor(tooling): share test alias conversion`.

## Task 4: Consolidate Persistence Fixtures and Cover Input Failures

**Files:**
- Change: `apps/worker/test/vault-storage.test.ts`

**Interface:**
Add documented `clearApplicationSchema(storage: DurableObjectStorage): void` in the native test file.
It removes only the known application tables in the existing safe order.
It does not run against production or the personal vault.

- [x] Add direct entropy tests for buffers shorter and longer than 16 bytes.
- [x] Add native initialization cases for invalid epoch results and unsafe creation timestamps.
- [x] For each initialization failure, assert no application schema or metadata remains.
- [x] Also verify that valid existing storage does not call either bootstrap factory.
- [x] Record that new coverage can pass immediately when current behavior is already correct.
- [x] Do not change correct production behavior merely to manufacture a RED result.
- [x] Consolidate the three teardown copies after the existing scenarios pass.
- [x] Preserve independent corruption, view-only, unknown-only, rollback, identity, and data-preservation assertions.
- [x] Run the complete native persistence suite and documentation checks.
- [x] Commit with `test(worker): cover bootstrap input failures`.

## Task 5: Verify, Review, and Publish One PR

**Files:**
- Update OAB-24 only through the Backlog CLI.
- Update this plan's checkboxes as steps complete.

- [x] Confirm the frozen worktree baseline result before implementation.
- [x] Run `bun install --frozen-lockfile` after the final lockfile change.
- [x] Run `bun run check` with the installed pinned tools.
- [x] Probe changed TypeScript paths with active diagnostics. Disclose unavailable or inconclusive editor results.
- [x] Run `git diff --check` and `backlog doctor`.
- [x] Run the complete code-review skill and TypeScript profile against the whole branch.
- [x] Reassess the storage initializer, schema model, generator, and shared tooling owners.
- [x] Record each audit finding as fixed, rejected, accepted deferral, or still open, with evidence.
- [x] Open the branch diff against `main` in Plannotator and address every annotation.
- [x] Verify the final reviewed source after any correction.
- [x] Close OAB-24 only after its acceptance evidence exists.
- [ ] Push the branch and create one English Conventional Commit PR.
- [ ] Remove the worktree only after all commits exist on the remote branch.
- [ ] Report the PR URL, validation evidence, and any explicit residual limits.

## Execution Rulings

Vite configuration loads before aliases exist. A private tooling workspace supplies native package resolution through a public export.

The shared reader owns trusted JSON loading as well as conversion. Each workspace keeps its own selected aliases and test settings.

Consumer fixtures no longer rewrite historical aliases. They test unchanged current source.

Production restrictions cover private aliases, public tooling exports, and parser dependencies. Native compilers remain separate from editor diagnostics.

## Approval Boundary

This plan authorizes no deployment, resource mutation, schema change, dependency sweep, or later feature.
The earlier failed check used a global Biome binary in an uninstalled checkout.
Only the isolated pinned baseline can establish the starting validation state.
