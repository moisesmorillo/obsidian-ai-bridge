# F2 Extension Test Cleanup Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for the approved task. One worker owns implementation, checks, and the commit. A separate reviewer checks the task.

**Goal:** Complete OAB-7.1 by reducing repeated Worker extension cases without changing the file classification contract.

**Architecture:** Keep exhaustive ASCII classification in the protocol unit test. Use four explicit forms per extension in Worker policy, SQLite, and HTTP tests. Change no production code.

**Tech Stack:** Bun, TypeScript, Vitest, the local Workers runtime, real SQLite Durable Objects, and local R2.

**Spec:** `docs/spec.md` sections 5.4, 10, 13, and 14. Tracking: OAB-7 criterion 4 and OAB-7.1.

## Approval and scope

This plan covers OAB-7.1 only. Human approval precedes implementation. OAB-7.2 through OAB-7.8 remain intent-only tasks with no approved implementation plans.

Main matches merged PR #20 at `3534d79a2b44cd5f1dbe8a23cfbf3e93b09a8f01`.
The isolated branch is `chore/oab-7-f2-planning`.
The worktree is `~/.worktrees/obsidian-ai-bridge/chore/oab-7-f2-planning`.

The frozen install and baseline `bun run check` passed with exit code 0 before source edits.
Focused before-and-after timings remain part of execution, not a result claimed by this plan.

## F2 task order

Each task depends on the previous task. OAB-7.1 depends on completed OAB-6.

| Order | Task | Delivery boundary |
| --- | --- | --- |
| 1 | OAB-7.1 | Criterion 4 test cleanup. This plan only. |
| 2 | OAB-7.2 | Real OAuth provider, PKCE, DCR, refresh, discovery, verified Access, consent, and REST identity. Local tests only. |
| 3 | OAB-7.3 | Access-protected client console and DO-first revocation before provider KV revocation. Local tests only. |
| 4 | OAB-7.4 | Authenticated Streamable HTTP MCP, initialization, instructions, metadata, and four read tools. Local tests only. |
| 5 | OAB-7.5 | Five conditional MCP mutation tools over the same authoritative operations. Local tests only. |
| 6 | OAB-7.6 | Local production-path OAuth, REST, MCP, and revocation integration. No deployed or real-client claim. |
| 7 | OAB-7.7 | Deployment and Access configuration. **Needs explicit owner authorization.** Use an authorized synthetic vault only. |
| 8 | OAB-7.8 | Real MCP Inspector, Claude Code, ChatGPT web, revocation checks, and owner account decision. **Needs explicit owner authorization.** |

The final task records Developer mode and iPhone availability in the owner's ChatGPT account, plus the owner's mobile client strategy.
Future task planning must verify current provider and client contracts before choosing implementation details or dependencies.

## Global constraints

- Preserve exact observed revisions, obsolete-revision rejection, absence safety, and visible collision recovery.
- Preserve the section 14 F1 server-only acceptance boundary.
- Worker tests do not prove plugin, real MCP client, deployed authentication, or device behavior.
- Keep production identity resolution default-deny until a tested real OAuth path replaces it in its own task.
- Keep OAB-6.8.2 Deferred. Do not start OAB-8 or later phases.
- Do not access the owner's personal vault or change Cloudflare resources.
- Plan approval grants no deployment or resource authorization.
- Change no production code, protocol shape, specification, dependency, limit, or test timeout in OAB-7.1.
- Use English, useful TSDoc, Biome, and existing workspace aliases.
- AC-08 includes device status and file preservation. Worker and MCP checks do not prove those effects.
- This decomposition does not waive AC-08 or approve a server-only F2 exit. Keep unresolved gate obligations open.

## Research and approach

The current production entry returns `null` for every identity. The HTTP test entry injects identities only within test configuration.
The DO already checks revoked grants. No production OAuth, MCP, or owner console path exists.

OAB-7 criterion 4 names `apps/worker/test/http/files.test.ts`.
The exhaustive HTTP extension matrix actually resides in `apps/worker/test/http/search.test.ts`.
Include that file to meet the criterion's workload goal. Keep the existing file-route checks unchanged unless current inspection finds relevant cases.

The three Worker matrices each generate four Markdown forms and 64 Canvas forms.
The policy matrix expands these into 136 threshold cases. The HTTP matrix creates 136 threshold files, plus one near-match file.
The SQLite lifecycle matrix runs every transition across 68 files.

Use these exact representative forms:

- Markdown: `md`, `MD`, `mD`, `Md`.
- Canvas: `canvas`, `CANVAS`, `cAnVaS`, `CaNvAs`.

Explicit lists keep the cleanup small and auditable. A shared generator adds an interface for three short lists.
Retaining exhaustive Worker matrices would violate the requested cost reduction.

## File scope and interfaces

| File | Action |
| --- | --- |
| `apps/worker/test/blob-put.test.ts` | Replace the exhaustive generator with explicit representative forms. Preserve both threshold sizes. |
| `apps/worker/test/vault-search.test.ts` | Reduce index and lifecycle matrices. Preserve every transition and exact result assertions. |
| `apps/worker/test/http/search.test.ts` | Reduce real HTTP threshold writes. Preserve range, manifest, SQL, FTS, hash, and coverage assertions. |
| `apps/worker/test/http/files.test.ts` | Inspect and run unchanged. It contains no exhaustive extension generator at the reviewed revision. |
| `packages/protocol/test/files.test.ts` | Run unchanged. Keep all 4 Markdown and 64 Canvas classifier combinations and near-match checks. |
| Backlog task records | Record actual commands, counts, timing, review closures, and final status through the CLI. |

No public interface changes. Tests continue to consume `classifyFilePath`, `usesBlobStorage`, real DO operations, and Worker HTTP routes.
Do not export a new production helper for test selection.

## Review focus

1. Preserve both 1,000,000-byte inline and 1,000,001-byte blob cases for each representative form.
2. Keep all six existing HTTP read-form selections present. Avoid a missing form that produces an `inline--1` fixture path.
3. Preserve Markdown-only FTS results and coverage counts. Canvas must remain absent from search across every lifecycle transition.
4. Preserve near-match blob behavior, exact bytes, hashes, range reads, and manifest metadata.
5. Preserve production default-deny checks. Test-only identity injection must not enter production composition.

## Task 1: OAB-7.1

### Step 1: Measure the focused baseline

- [ ] Read the task, this plan, and the scoped tests before edits.
- [ ] Use the existing worktree and installed frozen dependencies.
- [ ] Run each command below three times. Record Vitest counts and durations, plus median duration for each command.

Run from `apps/worker`:

```sh
bun x vitest run --config vitest.config.ts test/blob-put.test.ts test/vault-search.test.ts
bun x vitest run --config vitest.http.config.ts test/http/search.test.ts test/http/files.test.ts
```

Run from `packages/protocol`:

```sh
bun x vitest run --config vitest.config.ts test/files.test.ts
```

Use these identical commands after the change. Do not compare different selections or concurrent timing runs.
Record the workload separately from timing. A loop reduction may not change the number of named tests.

### Step 2: Add bounded-work assertions and verify RED

- [ ] Before replacing generators, add matrix-size assertions within the existing affected tests.
- [ ] In the policy threshold callback, assert `expect(thresholdCases).toHaveLength(16)`.
- [ ] In both SQLite matrices, assert eight selected forms before writes. The indexing test must use one combined list for this assertion.
- [ ] In the HTTP matrix, assert `expect(variants).toHaveLength(8)` before writes.
- [ ] Run the two focused Worker commands. Confirm assertion failures report 136 versus 16, or 68 versus eight.

Wrap expected failures so the shell records their exit codes and exits zero. Assert that the failure comes from the new bounds, not setup.
Do not change a production function to create RED. This task changes test workload, not product behavior.

### Step 3: Reduce only the selected matrices

- [ ] Replace the three Worker exhaustive generators with the exact representative lists above.
- [ ] Use all eight forms in each threshold and lifecycle matrix. Keep original operations, preconditions, keys, and transition assertions.
- [ ] Keep all existing HTTP read forms in the selected list. Verify every `variants.indexOf(extension)` result is nonnegative.
- [ ] Rename descriptions and comments that claim exhaustive Worker coverage.
- [ ] Preserve protocol exhaustive classification without changes. Preserve the separate cross-extension rename lifecycle test.

Expected workload: 16 policy threshold cases instead of 136.
Expected HTTP matrix: 16 threshold writes plus one near-match write instead of 137 total writes.
Expected SQLite matrix: eight files per lifecycle transition instead of 68.
Markdown coverage remains four. Do not reduce expected indexed counts to conceal missing coverage.

### Step 4: Verify GREEN and cost reduction

- [ ] Repeat all three baseline commands three times. Record counts and median durations against the baseline.
- [ ] Confirm the policy matrix removes 120 parameterized cases without adding unrelated tests.
- [ ] Confirm the HTTP and SQLite workload counts match Step 3 and all behavioral assertions pass.
- [ ] Run `bun run docs:check`, then `WRANGLER_SEND_METRICS=false bun run check` from the repository root.
- [ ] Run `git diff --check`. Confirm no production, protocol, configuration, dependency, or timeout changes.

The focused integration median must decrease. If timing noise hides the reduction, repeat the same comparison without changing assertions or timeouts.
If checks cannot pass, report the concrete blocker. Do not claim lower runtime from fewer loop iterations alone.
The full check includes `apps/worker/test/entry.test.ts`, which rejects forged identity headers before body processing.

### Step 5: Review, commit, and publish the bounded task

- [ ] The worker loads the code-review skill and TypeScript profile, completes its self-review, and records actual checks in OAB-7.1.
- [ ] Commit the bounded changes with `test(worker): reduce extension case integration work` after passing checks.
- [ ] A separate reviewer checks the complete task diff, documentation truth, and the five review-focus conditions.
- [ ] Complete the session-model whole-branch review. Record reviewed revision, scope, findings, evidence-based closures, and limits in task notes.
- [ ] Open one human branch review against `main`. Address every annotation before publication.
- [ ] Follow the branch completion skill. Push, create an English Conventional Commit PR, and verify actual remote CI before task closure.
- [ ] Close only OAB-7.1 when its criteria pass. Keep OAB-7 open. Do not start the next task automatically.

Keep evidence in tests, task notes, and the PR. Do not create a separate review or qualification report.

## Plan self-review

The scope covers OAB-7 criterion 4 only. Every other F2 deliverable maps to a later bounded task.
No platform feasibility probe is needed for this test-selection change. It uses the existing runtime and changes no capability or contract.
The plan keeps the HTTP read-form dependency, threshold values, search counts, lifecycle transitions, and classifier boundary explicit.
Human review is the next step. No implementation is authorized yet.
