# F0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining F0 foundation: a checked Bun monorepo, shared protocol identity, buildable Worker and mobile-compatible plugin packages, and actionable Backlog tracking.

**Architecture:** Preserve the approved v1.3 architecture and establish its three production packages, not a demo or second implementation. Protocol identity is defined once with Zod and consumed through workspace exports; the Worker and plugin entry points remain non-operational until their respective implementation phases. Each runtime has its own type environment and test configuration.

**Tech Stack:** Bun workspaces, TypeScript, Zod, Biome, Vitest, Hono, Wrangler, `@cloudflare/vitest-pool-workers`, Obsidian types, esbuild, GitHub Actions. OAuth and MCP dependencies are deliberately not installed until F2.

**Spec:** `docs/spec.md` v1.3, particularly §§5.1, 14, 15, 16 and 17. Read the spec and current `AGENTS.md` before execution. Backlog planning task: OAB-1; implementation tasks: OAB-2–OAB-5.

## Global Constraints

- `docs/spec.md` says what the product does; Backlog.md records committed and deferred work. No separate roadmap, milestone marker or qualification report.
- Every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions. F0 introduces no mutation operation.
- Protocol shapes are defined only by Zod schemas in `packages/protocol` and TypeScript types are inferred from them, not re-declared in consumers.
- Path: Unicode NFC, forward slashes, no leading slash, no `.`/`..` segments, no control characters, ≤ 512 bytes, ≤ 32 segments. `path_key = toLowerCase(NFC(path))` using JavaScript Unicode case mapping.
- Epoch: random 128-bit generation id (32 hex chars); ETag: `"<epoch>.<rev>"` (quoted string). Client-facing contracts never exchange a bare revision as a version precondition.
- Plugin: `isDesktopOnly: false`, `minAppVersion: 1.13.0`; no Node or Electron runtime APIs. Network will use `requestUrl` in F3, not a F0 substitute transport.
- English repository content; Conventional Commits; Biome formatting. State every dependency's purpose in its owning Backlog task before installation.
- Never touch the owner's personal vault or deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation. Never change Git identity.
- No dependencies, source code or deployment configuration are installed/written by this planning task. Implementation starts only after owner review of this plan.

### How Constraints Are Enforced

A written instruction is not an automated safeguard. Enforcement has three layers: executable checks, review of code/configuration and explicit owner authorization. The following table identifies which applies and when it becomes available; none is claimed to exist in the documentation-only baseline.

| Constraint | Enforcement and evidence | Owner / phase |
| --- | --- | --- |
| One product contract and one work tracker | Tasks link to the governing spec sections. Review rejects alternative roadmaps and contradictory contracts. A contract change must be tracked in Backlog and update `docs/spec.md`; a plan cannot silently override it. | Executor and reviewer, every phase |
| Conditional mutations, no inferred deletes, no obsolete overwrite, visible collisions | Regression tests against the real DO and plugin apply/publish paths, including stale epochs/revisions, absence, collision and interrupted apply. Follow the spec's explicit append/idempotency contract rather than inventing an `If-Match` requirement for append. Examples: AC-01, 03–06, 10–14, 25–26, 32, 39–44. | F1 server tests, F3 plugin tests, F3b restore tests; no mutation code in F0 |
| Zod is the sole protocol-shape definition | Workspace exports and inferred types in Task 1; consumers use those exports. Review rejects duplicate wire interfaces/schemas. Later boundary tests verify actual request/response parsing. TypeScript alone cannot detect every semantically duplicated shape. | F0 foundation; F1/F2 boundary enforcement |
| NFC, path limits and canonical keys | Task 1 table/boundary tests and shared schema validation. Later server/client entry points must call those schemas and have rejection tests. | OAB-2, then F1/F3 |
| ETag syntax, safe revisions and never-reused generation | Task 1 parser tests; later DO allocation and stale-generation regression tests, including restoring the same backup twice (AC-44). A regex does not prove randomness or uniqueness. | OAB-2, then F1/F3b |
| Mobile manifest and no Node/Electron runtime APIs | Manifest assertions, web-only source typechecking and esbuild import/input inspection. Real platform testing remains mandatory, not replaced by a bundle check. | OAB-4; F3 desktop and F5 mobile gates |
| Formatting, English content, commit convention and dependency reasons | Biome is an automated check. Review checks English text and Conventional Commits; the task must explain each dependency before installation. Frozen installs enforce resolved versions, not whether a dependency is justified. | OAB-2 pipeline; executor/reviewer each task |
| No unauthorized resources/vault access or Git-identity changes | F0 checks are local, have no production bindings/secrets, and CI has read-only permissions. The executor stops for explicit authorization before any sensitive operation; reviewer inspects commands/configuration and rejects identity changes. This is a workflow gate, not a sandbox guarantee: an agent with ambient credentials can still violate it. | Owner authorizes; executor/reviewer enforce the gate |
| Plan approval before implementation | Plannotator approval and addressed annotations; OAB-1 remains In Progress while review is pending. No task starts because a checkbox exists in this file. | Owner and executor |

`bun run check` must fail on a lint/type/test/build failure and CI must run the same command. Before proposing a PR, the executor verifies that run and the reviewer checks its evidence. A failing check is a release/merge blocker in this workflow; **GitHub branch protection is not configured by this plan**, so CI status alone is not a hard platform prohibition on merging. Mandatory status-check protection can be configured separately with owner agreement if required.

## Review Focus

1. Decomposed Unicode and non-ASCII paths must normalize consistently and obey byte limits, not UTF-16 length limits — Task 1 boundary tests.
2. ETags with an unsafe integer revision or a reused numeric-style epoch must not validate — Task 1 malformed ETag tests; generation uniqueness itself remains AC-44 in F3b.
3. Workspaces must not hide a failing suite, silently run zero tests, or pass CI using a different check command — Task 1 negative check probes, repeated after Task 3.
4. F0 entry points must not create an unauthenticated route, connect to a service or write to a vault merely because their bundles can load — Tasks 2 and 3 lifecycle/default-route tests.
5. Desktop builds must not accidentally admit Node/Electron into the mobile plugin, or check Workers using Node globals — Tasks 2 and 3 isolated type environments and bundle-input inspection.

---

## Verified Baseline and Scope

Baseline: `main` at `f4eb1ff`, clean checkout before planning.

- `d806c59`: spec v1.3, root agent rules, README, license and ignore file.
- `dcffcee`: Backlog initialized with `oab` task prefix and To Do / In Progress / Done statuses.
- `f4eb1ff`: mandatory Plannotator plan and branch-diff review when available.
- No `package.json`, lockfile, source packages, test suites or CI exist. `bun run check` is not executable yet; do not report a passing baseline.
- The owner selected **F0 first**, not a complete F0–F6 implementation plan. Bun 1.4.3 is installed on the planning machine; pin that version for this first pipeline unless execution reveals a documented incompatibility.
- Planning created OAB-2–OAB-5 as To Do tasks. Those files are tracked work, not proof that F0 has been delivered.

**Included:** package/tooling foundation, path and ETag contracts, production entry-point builds, local Workers runtime testing, plugin artifact checks, and Backlog inventory.

**Excluded:** DO schema and transactions, all sync API routes, tickets, receipts, search, OAuth, MCP, enrollment, sync engine, status panel, exports/imports, deployment, releases, actual Obsidian installation and real-vault testing. These remain F1 onward.

The spec's §17 questions (ChatGPT account capabilities, mobile secret storage, measured polling/storage, owner conventions) are later phase gates, not F0 blockers. Its fresh random epoch and AC-44 already address the historical repeated-restore generation concern; do not resurrect an obsolete spec review.

## Phase Sequence and Sources of Truth

There are **eight delivery stages** in spec §14: F0, F1, F2, F3, F3b, F4, F5 and F6 (seven numbered phases plus the separate backup stage F3b). This section explains that existing contract; it is not a second roadmap or a commitment to implement later stages from this F0 plan.

| Stage | What it delivers | What must precede it |
| --- | --- | --- |
| F0 | Checked monorepo and work tracking | Approved spec; this plan's OAB-2–OAB-5 complete |
| F1 | Vault authority: DO, sync API, conditional mutations, receipts, search and limits | F0 |
| F2 | OAuth, MCP, owner clients/revocation and real-client connectivity | F1 |
| F3 | Desktop plugin enrollment, reconciliation, sync/conflicts and status | F2 |
| F3b | Incremental backup, verified export and restore into a new vault | F1; can be delivered before/alongside F2/F3 |
| F4 | Mac-only real-vault coexistence, at most two weeks, with measurements | F3 **and** F3b's demonstrated restore; explicit personal-vault authorization |
| F5 | iPhone/iPad validation on a copy before the real vault | F4; applicable owner authorization |
| F6 | Cutover outside iCloud, with one sync owner per device | F5 and a fresh verified export |

The next plan after completing F0 is **F1**. The natural sequence is `F0 → F1 → F2 → F3`, with a separate `F1 → F3b` branch; both branches must converge before `F4 → F5 → F6`. This permits independent backup work but does not automatically select parallel agents or authorize implementation of both branches at once.

The recurring workflow is:

1. Verify the preceding stage's exit criteria using tests/real-platform evidence, not a phase label.
2. Pick the next eligible Backlog commitment. Research and split a broad phase task into small, independently testable tasks before executing it.
3. Write that phase/subsystem's bounded plan from the current spec and code; link it from the corresponding Backlog tasks. Open it in Plannotator and wait for review.
4. Execute one selected task at a time with TDD, checks and review; store progress and verification in that task.
5. Verify all applicable §14 exit cases before advancing. External validation that needs owner access stays blocked until that access is authorized/provided; it is not silently replaced by a mock.

| Question | Always consult | Role of other files |
| --- | --- | --- |
| What must the product do, and what are phase gates? | `docs/spec.md` | Tests prove selected requirements; plans cannot redefine them. |
| What is selected, in progress, blocked, complete or deferred? | Backlog.md, physically `backlog/tasks/*`, accessed through its CLI | Dependencies and task notes carry progress, evidence and reopening triggers. |
| How do we implement the currently approved slice? | The linked plan in `docs/superpowers/plans/` | The task's Implementation Plan is the current execution record and links the detailed file. If the approach changes, update both and re-review material changes. |
| What rules must an agent follow? | Current root `AGENTS.md` and applicable global instructions | Plans restate relevant rules but do not supersede them. |
| What actually exists and works? | Source code and freshly run tests/checks | README and task status summarize evidence; neither can substitute for it. |

If files disagree, stop rather than choose whichever is convenient: product intent comes from the spec, selected work/status from Backlog, and behavior must be verified in code. A discovered design issue becomes a Backlog task against the affected spec section; amend the spec only when that task changes a contract (§17.0), not through a new spec-only review cycle.

## File Responsibilities

All paths below are relative to the execution worktree. Preserve the existing `.gitignore`, `LICENSE`, `AGENTS.md`, `docs/spec.md` and Backlog configuration.

| Files | Responsibility |
| --- | --- |
| `package.json`, `bun.lock`, `.bun-version` | Private root workspace, reproducible dependency graph and Bun pin |
| `tsconfig.base.json`, `biome.json` | Strict shared TypeScript options and formatting/lint policy; no shared ambient runtime globals |
| `.github/workflows/check.yml` | Frozen install plus the same `bun run check` used locally |
| `packages/protocol/package.json`, `tsconfig.json`, `vitest.config.ts` | ESM workspace exports, web-standard types, protocol test runner |
| `packages/protocol/src/path.ts`, `etag.ts`, `index.ts` | Canonical path/key and version schemas plus public exports |
| `packages/protocol/test/path.test.ts`, `etag.test.ts` | Exact identity and boundary contracts |
| `apps/worker/package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts` | Worker-only type environment, local build and Cloudflare pool |
| `apps/worker/src/index.ts`, `test/entry.test.ts` | Default-deny Hono entry point and Workers runtime tests |
| `apps/plugin/package.json`, `tsconfig.json`, `vitest.config.ts` | Web/Obsidian source type environment and local lifecycle tests |
| `apps/plugin/src/main.ts`, `manifest.json`, `build.ts` | Inert production plugin lifecycle and CommonJS artifact construction |
| `apps/plugin/test/lifecycle.test.ts`, `artifact.test.ts` | No-side-effect lifecycle and bundle/manifest checks |
| `README.md` | Exact local install/check commands and honest F0 status |
| `backlog/tasks/*` | CLI-managed phase tasks and reopening triggers, never hand-edited |

Runtime source directories must not inherit Node/Bun globals. Build scripts and artifact tests can run in Bun/Node with a separate typecheck invocation; their imports must never enter `apps/plugin/src/main.ts`'s bundle.

## Execution Rules for Every Task

- **“Task” here means a Backlog.md task** (for this plan, OAB-2–OAB-5), not a delivery phase or a step checkbox. “Task 1” below maps to OAB-2, Task 2 to OAB-3, Task 3 to OAB-4, and Task 4 to OAB-5. OAB-1 tracks planning/review only.
- Read the selected Backlog task with `backlog task view OAB-2 --plain` (substitute its actual ID), verify its dependencies, mark it In Progress and assign the executor via `backlog task edit`, then record its current Implementation Plan with `--plan`, including the link to this detailed plan. Read the matching CLI guides first. Do not check its acceptance criteria until verified. The plan's step checkboxes help execution but never replace the Backlog task status or evidence.
- Use TDD for production behavior. Minimal manifests and test configuration may be bootstrapped to make the first written test runnable; a missing runner is not evidence of a red behavioral test.
- Run long installs, builds and suites with `bg_run`. Capture the red assertion/import failure, then the green result. Do not add intentionally failing files to a commit.
- Run `bun run check`, invoke the code-review skill, resolve findings, then read `backlog instructions task-finalization` and finalize only with evidence.
- Every task produces one independently reviewable deliverable and a focused Conventional Commit. Selective Git staging must include the task's CLI-managed updates.
- No check may contact a real Worker, R2 bucket, OAuth service, GitHub backup repository or vault. Local Miniflare/workerd tests and `wrangler deploy --dry-run` are build/test actions only; never run deployment without `--dry-run`.

### Task 1: Shared Protocol Identity and Check Pipeline — OAB-2

**Files:** Create the root and protocol files from the responsibility table, including their tests and `.github/workflows/check.yml`.

**Interfaces:**
- Consumes: spec §5.1; no pre-existing source interfaces.
- Produces from `@obsidian-ai-bridge/protocol`: `PathSchema`, `EpochSchema`, `ETagSchema`; `normalizePath(input: string): string`; `pathKey(input: string): string`; `formatETag(epoch: string, rev: number): string`; `parseETag(input: string): { epoch: string; rev: number }`. Schema-derived output types use `z.infer`, not hand-written copies of protocol shapes.
- Produces root commands: `lint`, `typecheck`, `test`, `build`, `check`. Root package name is `obsidian-ai-bridge`; workspace names are `@obsidian-ai-bridge/protocol`, `@obsidian-ai-bridge/worker`, `@obsidian-ai-bridge/plugin`. This prevents root script recursion when filtering workspaces.

- [ ] **Step 1: Write failing identity tests, then bootstrap only their runner.**

Write tests before the source exports. Establish a private ESM workspace root with `workspaces: ["apps/*", "packages/*"]`; add exact compatible versions of Zod, TypeScript, Vitest, Biome and build/test-only Bun types, then commit their resolved lockfile at Step 6. Bootstrap the protocol test configuration without production implementations. Use a web-standard `ES2022` / `DOM` type environment, strict checking and `noEmit`.

Representative assertions in `packages/protocol/test/path.test.ts`:

```ts
expect(normalizePath("Notes/cafe\u0301.md")).toBe("Notes/café.md");
expect(pathKey("Notes/CAFÉ.md")).toBe("notes/café.md");
expect(PathSchema.safeParse("a".repeat(509) + ".md").success).toBe(true);
expect(PathSchema.safeParse("a".repeat(510) + ".md").success).toBe(false);
expect(PathSchema.safeParse("é".repeat(255) + ".md").success).toBe(false);
expect(PathSchema.safeParse(Array(32).fill("a").join("/")).success).toBe(true);
expect(PathSchema.safeParse(Array(33).fill("a").join("/")).success).toBe(false);
```

Table-test rejection of `""`, `/a.md`, `a//b.md`, `a/./b.md`, `a/../b.md`, `a\\b.md`, trailing slash, NUL, DEL and C1 control characters. Preserve original casing in the normalized path; only `pathKey` lowercases it.

In `etag.test.ts`, with `const epoch = "e".repeat(32)`, assert round-trip of `formatETag(epoch, 1)` to `"\"" + epoch + ".1\""`, and `parseETag` returns `{ epoch, rev: 1 }`. Reject unquoted ETags, numeric epochs, non-hex/incorrect-length epochs, revision 0, negatives, fractions and `9007199254740992`. Use lowercase hex as the generated canonical form. Valid revisions must be positive safe integers; generation randomness is not this parser's responsibility.

- [ ] **Step 2: Run the protocol suite and confirm red.**

Run `bun run --cwd packages/protocol test`. Expected: test runner starts and fails because the tested production exports are missing, not because dependencies or the runner cannot launch.

- [ ] **Step 3: Implement the exports in `src/path.ts`, `src/etag.ts`, `src/index.ts`.**

`PathSchema` normalizes NFC before applying byte/segment checks; use `TextEncoder` for UTF-8 byte length and Unicode control-character validation. `pathKey` parses through the schema before JavaScript `toLowerCase`. `EpochSchema` and `ETagSchema` validate canonical syntax and safe revision bounds; `parseETag` derives its object schema in this package. `formatETag` validates both arguments rather than emitting an invalid string. Do not define file bodies, feed rows or MCP tools yet; those contracts belong to their F1/F2 tasks.

- [ ] **Step 4: Wire the reproducible root pipeline and CI.**

Root `lint` runs `biome check .`; `typecheck`, `test`, `build` invoke the matching script on every `@obsidian-ai-bridge/*` workspace. `check` runs lint, typecheck, test and build sequentially and propagates nonzero exits. Protocol `test` uses `vitest run` and fails on zero tests; protocol `build` checks exports with `tsc --noEmit`. Do not enable `passWithNoTests`. CI uses checkout, Bun 1.4.3, `bun install --frozen-lockfile`, then `bun run check`, with read-only repository permissions and no secrets. Pin third-party Actions to immutable commits when implementing.

- [ ] **Step 5: Verify green and verify the failure path.**

Run `bun install --frozen-lockfile` and `bun run check`; expected: tests pass, formatting and types pass, exit 0. Temporarily add, one at a time, a failing protocol assertion, a source type error and a formatting violation; confirm each makes `bun run check` exit nonzero, then remove/revert it and rerun green. This is a local harness probe, not an extra permanent test suite or a remote CI permission change.

- [ ] **Step 6: Review, finalize OAB-2 and commit.**

Check consumers can import workspace exports without copying a schema. Use the code-review skill, record evidence via Backlog CLI, and commit `feat: establish shared protocol identity and checks`.

### Task 2: Production Worker Entry Point in Its Actual Runtime — OAB-3

**Files:** Create all Worker files from the responsibility table; the root pipeline needs no task-specific bypass.

**Interfaces:**
- Consumes: Task 1's workspace/check conventions; imports shared schemas through `@obsidian-ai-bridge/protocol` when future handlers need them, never through duplicated definitions.
- Produces: `apps/worker/src/index.ts` default export with the Hono `fetch` handler; workspace `test`, `typecheck`, `build` scripts. No DO class, HTTP vault API or trusted-request test bypass is exposed.

- [ ] **Step 1: Write the failing runtime test and configure the Cloudflare pool.**

Use the installed pool's supported configuration factory, pointing to `apps/worker/wrangler.jsonc`. Select a mutually compatible exact Vitest/pool/Wrangler version set; if Task 1's Vitest version needs adjustment, update and verify all workspace suites together. Use a fixed tested `compatibility_date`; omit `nodejs_compat`, remote bindings, account IDs, domains and secret values.

In `test/entry.test.ts`, test through the production module using `SELF` from `cloudflare:test`:

```ts
const response = await SELF.fetch("https://worker.invalid/v1/vault");
expect(response.status).toBe(404);
```

Table-test `/mcp`, `/owner/clients`, unknown routes, and a `PUT /v1/files/Test.md` body: all return 404 with no storage operation. This proves default denial, not working API authorization. Do not implement health or demo endpoints to make the test pass.

- [ ] **Step 2: Run `bun run --cwd apps/worker test` and confirm red.**

Expected: local Workers runtime reports a missing production entry point or failed route assertion. No request goes to Cloudflare infrastructure.

- [ ] **Step 3: Implement the minimal Hono entry point and package scripts.**

Export an empty Hono application's `fetch`; its default 404 denies unimplemented routes. Set `wrangler.jsonc`'s `main` to `src/index.ts`. Use Cloudflare/Web types for application source, not Node/Bun ambient globals. `build` runs `wrangler deploy --dry-run --outdir dist`; `test` runs the local Workers pool. Reserve no live DO/R2/KV resources in F0.

- [ ] **Step 4: Run runtime tests, the dry-run build and `bun run check`.**

Expected: real local Workers runtime tests pass, dry-run artifact exists, root check includes this suite and exits 0. This is not a DO integration test; F1 must add the actual DO and transaction tests.

- [ ] **Step 5: Review, finalize OAB-3 and commit.**

Review the denied-route behavior, absence of debug/auth bypasses and absence of runtime Node globals. Record verification and commit `feat: add checked worker entry point`.

### Task 3: Mobile-Compatible Production Plugin Artifact — OAB-4

**Files:** Create all plugin files from the responsibility table. Generated output goes under `apps/plugin/dist/` and remains ignored.

**Interfaces:**
- Consumes: Task 1's root pipeline/workspace conventions; shared protocol exports are available for F3 without copying schemas.
- Produces: default `AIBridgePlugin extends Plugin` from `apps/plugin/src/main.ts`, with `onload(): Promise<void>` and `onunload(): void`; `dist/main.js`, `dist/manifest.json`; package `test`, `typecheck`, `build` scripts.
- Manifest identity, a planning choice: `id: "ai-bridge"`, `name: "AI Bridge"`, `version: "0.1.0"`, `author: "Moisés Morillo"`, `description: "Private vault synchronization and authorized AI access."`, `minAppVersion: "1.13.0"`, `isDesktopOnly: false`. This does not create or publish a release.

- [ ] **Step 1: Write failing lifecycle and artifact tests.**

`lifecycle.test.ts` mocks only the unavailable Obsidian host module, imports the actual plugin class, calls load/unload and asserts no calls to `requestUrl`, vault mutation methods, `saveData`, `saveLocalStorage` or secret-storage writes. No connection command or pretend-sync status is introduced.

`artifact.test.ts` invokes the real build once, parses the emitted manifest and asserts:

```ts
expect(manifest.id).toBe("ai-bridge");
expect(manifest.minAppVersion).toBe("1.13.0");
expect(manifest.isDesktopOnly).toBe(false);
expect(manifest.version).toBe("0.1.0");
```

Also assert both emitted files exist, the bundle is CommonJS with `obsidian` as its sole external runtime import, and esbuild's metafile contains no `node:*`, `electron`, Bun or Node builtin inputs/imports. Derive builtin names in the build/test environment, not in shipped plugin source. DOM types and Obsidian types must suffice for runtime-source typechecking.

- [ ] **Step 2: Run `bun run --cwd apps/plugin test` and confirm red.**

Expected: missing class/build/artifact assertion, not a real Obsidian launch or dependency-loader failure. Configure an alias for the mock host API only within tests.

- [ ] **Step 3: Implement the inert lifecycle and esbuild packaging.**

Use Obsidian's `Plugin` class and empty lifecycle hooks; F3 will supply behavior in this same class. `build.ts` uses esbuild with `bundle: true`, `format: "cjs"`, `platform: "browser"`, target `es2022`, `external: ["obsidian"]`, `metafile: true`, entry `src/main.ts`, output `dist/main.js`, and copies the manifest into `dist/`. Return/write build metadata for artifact assertions but do not ship it as a required runtime asset. Check build/test tooling separately from web-only runtime source.

- [ ] **Step 4: Run lifecycle/artifact tests and `bun run check`.**

Expected: entry point stays inert; manifest and bundle checks pass; all three workspaces build and test. Repeat the root failure-path probe with a failing plugin assertion to prove aggregate checks actually include the new suite. These unit/build tests do not satisfy F3's real-Obsidian or F5's mobile gates.

- [ ] **Step 5: Review, finalize OAB-4 and commit.**

Review source/build separation and bundle imports. Do not install into a vault, publish to BRAT or claim device compatibility has been measured. Record evidence and commit `feat: add mobile-compatible plugin build`.

### Task 4: Backlog Delivery Gates and Deferred Inventory — OAB-5

**Files:** Modify `README.md`; create/update task files exclusively with the Backlog CLI.

**Interfaces:**
- Consumes: successful Task 1–3 checks and the current task list.
- Produces: canonical tracking for later phase commitments and §16 deferred items; README with reproducible local commands. No later-phase implementation plan or source change is produced.

- [ ] **Step 1: Verify the tracking gaps before changing them.**

Read task-creation guidance and `backlog task list --plain`; search for existing phase/deferred tasks. Confirm missing records against §§14/16 rather than assuming task IDs. This documentation task uses CLI inventory evidence, not a contrived failing product test.

- [ ] **Step 2: Create intent-only tasks for later delivery gates.**

Create one bounded tracking task per F1, F2, F3, F3b, F4, F5, F6 with descriptions, spec references and §14 exit cases. Do not add speculative implementation plans to To Do tasks; each later phase must be researched/decomposed when picked up. Dependency edges: F1 after OAB-2/OAB-3/OAB-4/OAB-5; F2 after F1; F3 after F2; F3b after F1; F4 after F3 and F3b; F5 after F4; F6 after F5. Use returned real task IDs for all links.

Make authorization a separate gate: F2's real-client checks require a deployed authorized service; F4 requires a verified complete backup and a demonstrated restore, plus explicit owner authorization to use the personal vault; F5 tests a copy before the real vault; F6 requires a fresh verified export. Dependencies alone never authorize resource/vault access. F4 is at most two weeks, with coexistence mode and the plugin only on Mac.

- [ ] **Step 3: Create/reuse all nine §16 deferred tasks.**

Each has label `deferred`, stays To Do, and records why deferred, its seam and a testable reopening trigger (no implementation plan):

| Item | Trigger from the spec |
| --- | --- |
| Blob garbage collection | Unreferenced blobs > 1 GB |
| WebSocket push | Measured latency complaint or request cost > 50% of allowance |
| Embeddings / semantic search | Agents miss notes by synonym in real use |
| `.obsidian/` settings categories | Manual re-configuration becomes a daily cost |
| Append under a heading | A concrete agent workflow requires it |
| Packed baseline export | Vault above 5,000 items, or owner unwilling to wait days for first backup |
| NAS / second storage | R2 > 10 GB or desire for an additional off-Cloudflare copy |
| Windows / Linux | A device exists |
| E2E encryption | Owner requirement changes; redesign required |

- [ ] **Step 4: Update README and verify the full F0 gate.**

Document Bun 1.4.3, `bun install --frozen-lockfile`, `bun run check`, the three package responsibilities and default-deny/inert entry points. State that sync is not implemented or deployed. Keep `docs/spec.md` as the product contract and Backlog as work tracking; do not add a roadmap or certification report.

Run `backlog task list --plain`, view each new task and verify gate/trigger coverage. Run `bun install --frozen-lockfile` and `bun run check` in a clean execution checkout; expect all suites, all package typechecks, formatting and builds to pass without secrets. Validate the first actual CI run when authorized branch publication occurs; do not label CI green from local success alone.

- [ ] **Step 5: Review, finalize OAB-5 and commit.**

Use code-review for the complete executable configuration and accompanying docs; record CLI and test evidence. Commit `docs: record delivery gates and deferred work`. F0 is complete only when its implementation tasks have verified acceptance criteria and the integrated check is green.

## Self-Review and Coverage Boundary

- §14 F0: existing repo/rules preserved; Task 1 delivers workspaces, protocol and CI; Tasks 2/3 deliver runtime-specific package builds; Task 4 records later work and deferrals.
- §5.1 identity: Task 1 owns all schemas and tests. DO uniqueness, monotonic revision allocation and random epoch creation remain F1/F3b behaviors, not schema-parser claims.
- §15 layout/tooling: package locations and checks match the approved layout. OAuth/MCP libraries wait for F2; production tests never duplicate protocol shapes.
- §16: Task 4 tracks all nine deferred items with reopening triggers.
- §§6–13 and F1–F6: intentionally not implemented here. Their cases remain attached to later delivery gates, including AC-44. None of the 44 product acceptance cases is declared satisfied merely by F0 builds.
- Review Focus: each of the five conditions has an owning test/probe above. Runtime and build-tool types remain separated; root commands do not recurse; the default-deny Worker and inert plugin do not promise functional synchronization.

## Review and Execution Handoff

Open this file in Plannotator with approval enabled and wait for the owner's feedback before implementation. This planning branch contains the plan and tracking only; OAB-1 remains In Progress until feedback is addressed.

No execution method has been selected. After plan review, ask the owner to choose:

- **Native (recommended for this F0 scope):** execute the three small code deliverables in this session, with the required per-task code-review workflow and a fresh whole-branch review. Lowest overhead for foundational interfaces that share one pipeline.
- **Subagent-driven:** fresh implementer and reviewer per task, then a whole-branch review; stronger independent gates at higher context cost. Use explicit model routes from the root/global agent rules.

Before finishing either branch, run fresh verification, open the branch diff against `main` in Plannotator and address every annotation. Follow finishing-a-development-branch only after the applicable review gates pass; default integration is push + English Conventional-Commit-style PR, never a local merge into main. Do not remove the worktree while owner review is pending.
