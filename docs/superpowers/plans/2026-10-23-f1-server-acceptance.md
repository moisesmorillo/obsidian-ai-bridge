# F1 Server Acceptance Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` to implement this plan. Track each step with its checkbox.

**Goal:** Complete OAB-6.9 with executable server acceptance tests, corrected contracts, and explicit limits on client claims.

**Architecture:** Keep the real Worker routes, application operations, SQLite Vault authority, and local R2 integration. Extend existing tests instead of adding an acceptance framework. Keep canonical wire schemas in `packages/protocol`.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Drizzle, SQLite Durable Objects, Vitest, and local workerd.

**Spec:** `docs/spec.md`, especially sections 5, 6, 10, 12, 13, and 14. Read root `AGENTS.md` and OAB-6.9 before execution.

**State:** Owner plan approval is pending. No product implementation starts before approval.

## Global constraints

- Work only in `~/.worktrees/obsidian-ai-bridge/feature/oab-6.9-f1-server-acceptance`.
- Base: `9233c22`, merged PR #18. Main matches `origin/main`.
- OAB-6.1 through OAB-6.8 each have status `Done`.
- OAB-6.8.2 keeps status `Deferred`. Do not deploy or access the personal vault.
- Do not change the admission model, slot model, authentication composition, or dependency versions.
- Do not add platform probe tests, evidence documents, synthetic clients, or another plugin.
- Every mutation keeps exact observed-revision conditions and atomic publication.
- Absence never means deletion. Obsolete revisions never replace newer state.
- Keep both visible states for collisions. Preserve tombstones, retained history, pins, receipts, and original admission deadlines.
- Preserve the 1,000,000-byte inline limit and 25,000,000-byte blob limit.
- Preserve SQL limits of 100 parameters, 100 columns, and 2 MB per row or value.
- Use workspace aliases and published cross-workspace exports as root `AGENTS.md` states.
- Write useful TSDoc for named semantic declarations, including test helpers.
- Use Backlog CLI commands for task changes. Do not edit task markdown directly.

## Owner decisions and design

The owner chose these rules through one question batch:

1. Authorize server-only F1 exit after server tests, reviews, and actual remote CI pass.
2. Match Markdown and Canvas extensions without case distinctions.
3. Preserve `renamed_to` for the source tombstone lifetime, including after feed pruning.

Server-only exit does not qualify plugin apply, conflict copies, base advancement, offline recovery, or UI behavior. It does not qualify MCP transport or deployed native memory. Keep those obligations under OAB-8, OAB-7, and OAB-6.8.2 respectively. These existing task boundaries do not add implementation scope.

Plan approval also approves the narrow spec amendments below. No later owner decision belongs inside the approved execution plan.

### Approaches

- **Selected:** Extend native and HTTP suites with named server portions. This keeps assertions close to the actual operation owners.
- **Rejected:** Add a separate acceptance registry or framework. It adds another source that can disagree with executable assertions.
- **Rejected:** Simulate plugin state to satisfy mixed cases. This gives false client acceptance before real plugin tests.

For rename hints, use a nullable `files.renamed_to` column. Publish the destination path atomically with the source tombstone. Do not derive this authority from the prunable feed. The hint names the immediate destination of that rename, not a live redirect or a transitive rename chain.

Clear the hint when any later mutation replaces the current source state. Live destination rows and ordinary delete tombstones carry no hint. A destination can later move or disappear without changing the original tombstone hint.

Use fresh schema version 6. Reject versions 1 through 5 without migration, repair, or replacement identity. Generate relational DDL through the existing Drizzle tooling. Do not apply a generated migration to any remote resource.

## Planning evidence and feasibility

The isolated baseline passed `bun install --frozen-lockfile` and `bun run check`, exit 0. Its 1,052 tests include 621 native Worker tests and 108 HTTP tests. Documentation, formatting, types, schema drift checks, and dry-run builds also passed.

The dependency records confirm real SQLite publication, immutable blob verification, bounded reads, literal search, retention, and distributed admission. Production identity resolution still denies access by default. HTTP fixtures inject identities only through the test entry and use real Vault bindings.

Source inspection confirms these corrections:

- DELETE rejects a supplied epoch header before mutation handling.
- Historical GET without an epoch returns `epoch_mismatch` instead of `revision_pruned`.
- Precondition failures lack a rename destination field.
- Error schemas omit `importing` and `vault_retired`.
- Storage and FTS use lowercase-only suffix checks, but large flags already ignore case.
- `reserveAdmission` and eager read collectors remain callable only through obsolete or test paths.
- README still describes the F0 state.

No new platform capability is needed. The nullable rename hint adds at most one 512-byte path to each current file row. It adds no revision or feed payload field and no new admission row. Existing complete-row budget tests must include the new column. Existing bounded JSON encoding must also cover the extra error field.

Native row, SQL, admission, and runtime checks already execute in the baseline. Reuse them for regression coverage. They do not prove total heap usage, native buffer release, or deployed headroom. Do not reopen OAB-6.8.2 or add a platform experiment.

## Review focus

1. Feed pruning must not remove a current tombstone's rename hint. Slice 1 tests this through real retention.
2. Recreate, restore, delete, and repeated rename must not carry an obsolete hint. Slice 1 tests these transitions.
3. Extension case must agree across text publication, rename, restore, search counts, and large flags. Slice 2 tests this matrix.
4. Collector removal must not remove native interleaving assertions. Slice 3 moves them to the lazy read API.
5. Failure encoding must preserve scope redaction and bounded chunks with a maximum-length hint. Slice 1 tests both properties.

## Execution ownership

One native implementer subagent owns the complete OAB-6.9 task and the three sequential slices below. It owns RED/GREEN, debugging, formatting, `bun run docs:check`, `bun run check`, and commits. Use the configured subagent model explicitly at high thinking. Keep one writer in the worktree.

The parent reviews once after the task with one reviewer subagent. The session model then owns the complete branch review. Do not request routine edit approval or repeat the worker's checks between steps.

Preserve existing correct implementation. For a new regression, observe an assertion failure before changing production code. Wrap expected failures so the shell records their exit codes without reporting a task failure. Record a test-first exception if retained behavior already passes a new characterization test.

## Slice 1: Correct protocol and HTTP failure contracts

**Files:**

- Change `packages/protocol/src/schemas/admission.ts`, `schemas/files.ts`, and `codecs/files.ts`.
- Change `apps/worker/src/transport/files.ts` and the existing mutation failure encoder if needed.
- Change `apps/worker/src/infrastructure/sqlite/schema-model.ts`, `schema.ts`, `admission.ts`, `history.ts`, and `text-files.ts`.
- Regenerate `apps/worker/drizzle/` artifacts and `src/infrastructure/sqlite/schema.generated.ts` through existing tooling.
- Extend protocol failure tests and Worker `http/files.test.ts`, `http/history.test.ts`, `vault-history.test.ts`, and `vault-storage.test.ts`.
- Extend `mutation-response.test.ts`, `vault-retention.test.ts`, and existing complete-row publication tests.
- Amend `docs/spec.md` sections 5.2, 6.1, and 6.2 for the chosen hint and schema rules.

**Interfaces:** Preserve existing gateway signatures. Extend inferred canonical failure types with optional `renamed_to`. Add canonical `importing` and `vault_retired` variants, with bounded retry seconds and `new_vault_id` respectively. Reuse existing vault identity validation or define its schema in protocol if no owner exists.

- [x] Add RED tests for stale DELETE with `X-Vault-Epoch`: expect 412, unchanged bytes, and unchanged publication state.
- [x] Test DELETE with current, stale, absent, malformed, and conflicting epoch observations. Preserve scope and revocation precedence.
- [x] Accept an explicit canonical DELETE epoch. Keep header-free DELETE compatible when its quoted If-Match supplies the epoch.
- [x] Reject conflicting header and ETag epochs as `invalid_request`. Return `epoch_mismatch` for an obsolete epoch.
- [x] Add historical GET tests without an epoch: expect 410 `revision_pruned` for inline and blob paths.
- [x] Keep malformed or obsolete explicit epoch handling distinct from missing historical selection authority.
- [x] Add canonical schema and encoder tests for `importing` with `Retry-After`, and `vault_retired` with `new_vault_id`.
- [x] Do not implement import, activation, retirement, OAuth, or owner endpoints. This slice adds error contracts only.
- [x] Add rename-source failure tests for stale PUT, DELETE, and rename requests. Assert the exact immediate `renamed_to` path.
- [x] Test hint survival after native retention removes the matching feed row, and after object restart.
- [x] Test hint replacement through recreate, restore, ordinary delete, and another rename. Assert transaction rollback preserves the previous hint.
- [x] Add protocol refinement tests that reject hints outside complete tombstone precondition details.
- [x] Test read-authorized and write-only failures. Never include note content without `vault:read`.
- [x] Test bounded failure encoding with a maximum-length destination path and escaping-heavy current content.
- [x] Run focused tests and record their assertion failures before product edits.
- [x] Add the nullable current-row hint, schema version 6, generated DDL, and atomic transition handling.
- [x] Extend fail-closed schema tests for version 5 and malformed current definitions. Preserve all data on rejection.
- [x] Extend existing row-budget assertions to cover the current schema without a new platform probe suite.
- [x] Run focused suites, `bun run docs:check`, and `bun run check`. Expect all checks to pass.
- [x] Commit with `fix(worker): correct F1 failure contracts`.

## Slice 2: Use one extension case policy

**Files:**

- Add classification to `packages/protocol/src/codecs/files.ts` and export it through `src/index.ts`.
- Change `apps/worker/src/application/blobs.ts` and relevant SQLite `text-files.ts`, `history.ts`, `reads.ts`, and `search.ts` consumers.
- Extend protocol tests, native text/history/search tests, and HTTP blob/search tests.
- Amend `docs/spec.md` sections 5.4 and 10 to state case-insensitive extension matching.

**Interfaces:** Export `classifyFilePath(path: string): "markdown" | "canvas" | "other"` from protocol. This pure classification does not normalize or change path identity. SQL coverage predicates must match it, with parity tests for every extension case.

- [x] Add RED classification tests for lowercase, uppercase, mixed case, near matches, and names without an extension.
- [x] Add native and HTTP tests at 1,000,000 and 1,000,001 bytes for Markdown and Canvas case variants.
- [x] Assert exact bytes, storage kind, large flags, range reads, FTS membership, and coverage counts.
- [x] Test create, update, append, rename, delete, recreate, and restore across the extension matrix.
- [x] Assert Canvas stays outside FTS. Preserve literal search, ranking, and query limits.
- [x] Observe the focused failures before changing classifiers and SQL predicates.
- [x] Reuse the canonical classifier across JavaScript consumers. Keep SQL mechanics in SQLite infrastructure.
- [x] Run focused suites, `bun run docs:check`, and `bun run check`. Expect all checks to pass.
- [x] Commit with `fix(protocol): unify file extension case rules`.

## Slice 3: Complete executable F1 acceptance and remove unused APIs

**Files:**

- Extend existing `apps/worker/test/http/` file, history, blob, read-recovery, search, and capacity suites.
- Extend native tests only where an HTTP assertion cannot inspect the authoritative invariant.
- Change `apps/worker/src/infrastructure/durable-object/vault.ts` and `src/application/reads.ts`.
- Adapt `application-reads.test.ts`, `vault-read-interleavings.test.ts`, `vault-admission.test.ts`, and `vault-admission-global-limit.test.ts`.
- Change `README.md` and the section 14 gate wording in `docs/spec.md`.

**Interfaces:** Keep `beginMutation`, `authorize`, `openManifestRead`, `openHistoryRead`, and `openChangesRead`. Remove only Vault RPC `reserveAdmission`, the three eager application collectors, their private collection helper, and unused imports. Keep the admission authority's internal reservation mechanics and the separate native history gateway.

- [x] Give every F1 acceptance ID below an executable named server assertion and a statement of its proof boundary.
- [x] Add missing assertions before product corrections. Do not replace assertions with metadata-only mappings.
- [x] Replace collector-based tests with direct lazy-session demand and explicit settlement. Preserve ordering, ceilings, expiry, and interleaving assertions.
- [x] Replace obsolete RPC tests with supported mutation admission calls. Preserve distributed client/global limit and authorization checks.
- [x] Remove unused APIs and tests that prove only their existence. Do not recreate eager collectors under another name.
- [x] Update README to describe implemented Worker behavior and default-deny production authentication.
- [x] State that plugin sync, MCP/OAuth service, deployment, and device acceptance remain outside this result.
- [x] Record the owner-approved server-only F1 interpretation in section 14. Preserve each later client acceptance obligation.
- [x] Run protocol, native, HTTP, and production-entry tests. Confirm test identity headers cannot bypass production authentication.
- [x] Run `bun run docs:check` and `bun run check`. Expect all checks to pass.
- [x] Commit with `test(worker): complete F1 server acceptance`.

### Executable coverage contract

This table guides test placement. It is not an evidence report or a substitute for executable assertions.

| Spec case | Server assertion | Unqualified portion |
| --- | --- | --- |
| AC-01 | Lost HTTP commit response, exact receipt retry, one revision and feed entry | Client retry persistence |
| AC-03 | Two writers share a base. First bytes remain and second write gets 412 | Offline queues, conflict copies, device convergence |
| AC-04 | Delete wins, stale edit gets tombstone details, no resurrection | Local trash and conflict copies |
| AC-05 | Rename wins, stale source edit gets destination hint, destination bytes remain | Device rename effects and link handling |
| AC-06 | Stale DELETE gets HTTP 412 and preserves newer bytes | Delete cancellation and attention UI |
| AC-11 | Equal bytes retain equal hashes across distinct revisions | Base advancement and no local write |
| AC-12 | A 40-day cursor expires. Manifest keeps explicit tombstones | Reconciliation and local conflict effects |
| AC-14 | Unicode path-key collision fails. Case-only rename succeeds | Device path collision UI |
| AC-15 | Every section 10 literal example uses real FTS and bounded snippets | Client presentation |
| AC-16 | A 1.5 MB Markdown blob keeps exact bytes, large flag, ranges, and search exclusion | Plugin transfer and panel |
| AC-17 | Payload mismatch and UUIDv7 age/skew limits keep exact errors and state | Client retry UI |
| AC-18 | Stale rename gets 412 and keeps the remote edit | Local destination cleanup |
| AC-21 | Manifest captured head, concurrent row, immutable feed, and explicit pruned-revision response | Apply, no-op, and current-read fallback |
| AC-22 | Tombstone append gets 409. Oversized result gets 413 without partial state | MCP transport |
| AC-25 | Feed keeps rev 2 identity after current content reaches rev 3 | Stale-feed apply no-op |
| AC-26 | Rename into a ten-revision tombstone uses destination rev 11 | Plugin behavior |
| AC-27 | Write-only 412 includes revision metadata without content | Client presentation |
| AC-28 | Revoked 20 MB upload reaches no local R2 write or body demand | Deployed transport observation |
| AC-29 | HTTP append without a key gets 428. Exact keyed retry creates one revision | MCP tool schema and transport |
| AC-34 | REST create and append with old epoch get 409 before effects | MCP tools and real backup restore |
| AC-38 | Two clients share a key but keep independent receipts | Client key generation |
| AC-40 | Rename source tombstone identity remains below a newer source revision | Local source-side no-op |
| AC-43 | Both file and storage caps reject content mutations. Reads and deletes continue | Panel limit display and deployed headroom |

## Acceptance, review, and publication

- [ ] The implementer reports actual RED/GREEN commands, final commit, complete checks, and any test-first exceptions.
- [ ] One independent task reviewer loads `code-review` and its TypeScript profile, then reviews the complete task diff.
- [ ] Close each finding with direct evidence. Use a scoped re-review for corrections.
- [ ] The session-model branch reviewer examines the complete branch, semantic comments, contracts, state transitions, and test boundaries.
- [ ] Record reviewed revision, structural candidates, validation scope, finding closures, and limits in task notes or the PR.
- [ ] Open one human branch review against `main`. Address each annotation before PR creation.
- [ ] Push the branch and inspect actual remote CI for the final reviewed head. Local checks do not replace it.
- [ ] Read `backlog instructions task-finalization` before checking criteria or changing terminal status.
- [ ] Close OAB-6.9 and OAB-6 only when their evidence and the approved server-only exit rule support closure.
- [ ] If task closure changes the commit, repeat final-head review and remote CI coverage before the completed-task claim.
- [ ] Keep OAB-6.8.2 deferred and later client obligations open. Do not create another evidence document.
- [ ] Follow `finishing-a-development-branch`: open an English Conventional Commit PR and remove the worktree after safe publication.
- [ ] Never merge into main locally. Never delete a branch with unpushed commits.

## Planning checklist

- [x] Read OAB-6.9, its direct and transitive dependencies, OAB-6, OAB-6.8.2, `AGENTS.md`, and `docs/spec.md`.
- [x] Synchronize main and create the isolated branch.
- [x] Inspect current contracts, affected code, test entry boundaries, and CI configuration.
- [x] Run the clean local baseline without deployment.
- [x] Resolve open decisions in one owner question batch.
- [x] Check plan coverage, interfaces, resource effects, and proof limits.
- [ ] Receive owner plan approval before implementation.
