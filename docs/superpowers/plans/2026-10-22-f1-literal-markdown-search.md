# Literal Markdown Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Complete OAB-6.7 with authorized, bounded, literal Markdown search through the real Vault Durable Object.

**Architecture:** Keep the existing FTS5 index and atomic mutation owners. Add a native search reader behind a small application gateway. Use shared read slots and response ownership for HTTP output.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Drizzle, SQLite FTS5, and the pinned Cloudflare Vitest runtime.

**Spec:** `docs/spec.md` sections 5.4, 6.1–6.2, 10, 12, and AC-15. AC-16 supplies the oversized Markdown exclusion case.

**Approval:** This plan awaits owner approval. Do not change product code or tests before approval.

## Global Constraints

- Use branch `feature/oab-6.7` in `~/.worktrees/obsidian-ai-bridge/feature/oab-6.7`.
- Use merged base `2c5cbe51e1b62046085add9e6d426f5240f67523`.
- Keep exact-revision mutations, permanent tombstones, and existing receipt behavior unchanged.
- Keep Zod schemas in `packages/protocol` as the only protocol shape definitions.
- Derive contract types from Zod schemas.
- Use published protocol exports across workspaces and workspace-local aliases within each workspace.
- Add no dependencies and make no schema-version change.
- Keep tokenizer `trigram case_sensitive 0 remove_diacritics 1`.
- Accept queries with 3–200 Unicode code points, not UTF-8 bytes or UTF-16 units.
- Accept result limits from 1 through 50, with default 20.
- Keep `snippet()` at no more than 64 tokens.
- Preserve the four shared isolate read slots and the 16-ticket per-client admission limit.
- Keep production authentication at default deny until F2 supplies an approved adapter.
- Do not deploy, change Cloudflare resources, or access the personal vault.
- Keep pruning, capacity enforcement, and aggregate runtime qualification in OAB-6.8.
- Keep deployed native retention measurements in OAB-6.8.2.
- Keep OAuth, MCP tools, plugin behavior, and semantic search outside this task.
- Document named semantic declarations with useful TSDoc.
- Write new prose, comments, and commit messages in Simplified Technical English.

## Dependencies

OAB-6.7 directly depends on OAB-6.4 and OAB-6.5. Backlog marks both prerequisites Done.

```text
OAB-6.7
├── OAB-6.4 [Done]
│   └── OAB-6.3 [Done]
│       └── OAB-6.2 [Done]
│           └── OAB-6.1 [Done]
└── OAB-6.5 [Done]
    └── OAB-6.3 [above]
```

PR #15 also completed OAB-6.6. Its bounded read infrastructure supplies integration patterns, not a new prerequisite edge.

OAB-6.8 waits for OAB-6.6 and OAB-6.7. OAB-6.9 then verifies server acceptance before F1 closure.

## Existing Behavior and Approach

`schema.ts` already creates and validates the exact FTS5 table. `vault-storage.test.ts` proves basic diacritic and literal `AND` behavior.

`text-files.ts` and `history.ts` update FTS inside mutation transactions. These paths cover text publication, blob replacement, rename, append, and restore.

The Worker has no search route. The protocol has no search contracts or query-length failures.

Current writers use the literal `.md` suffix for index membership. Preserve that rule and the current content classification.

Use a bounded native FTS query, not a full-vault application scan. Bind one quoted phrase and double each internal quote.

A JavaScript scan would transfer note bodies and bypass native ranking. Another tokenizer or search backend would change the approved contract.

Keep existing mutation code unless a failing search regression proves an index-maintenance defect. Do not refactor unrelated publication code.

### Proposed Public Contract

Implement `GET /v1/search?q=<query>&limit=<integer>` with `vault:read` scope.

```text
{
  epoch,
  results: [{path, etag, snippet, score}],
  indexed_files,
  unindexed_large_files
}
```

Use epoch-bound ETags, never bare revisions. Return the epoch even when no result matches.

`indexed_files` counts eligible current rows present in the index, independent of query and limit.

`unindexed_large_files` counts live `.md` blob rows above 1,000,000 bytes. Do not count Canvas files or unrelated attachments.

Rank by ascending native `bm25` score. Resolve equal scores by SQLite binary path order. Accept finite negative scores.

Return snippets as plain text without HTML markers. Request 64 FTS tokens with an ellipsis separator.

Also cap each selected snippet at 1,024 Unicode code points inside SQL before RPC serialization. This adds an application bound for long combining sequences.

Owner approval accepts this proposed snippet cap, coverage definition, and response field names.

Do not trim or normalize queries. Preserve spaces, punctuation, operators, quotes, and Unicode input for the native tokenizer.

Reject duplicate parameters, unknown parameters, missing `q`, and noncanonical integer limits with `400 invalid_request`.

Return `400 query_too_short` below three code points. Return `400 query_too_long` above 200 code points.

Check request syntax before authority access, as existing read routes do. Check identity and scope before admission or native data access.

### Native Authority and Lifetime

Add `SearchVaultGateway` with only `authorize`, `finishAdmission`, and `search` operations.

```ts
search(
  context: AuthorizationContext,
  request: SearchRequest,
  admissionId: string,
): Promise<SearchResponse>;

readSearch(
  gateway: SearchVaultGateway,
  context: AuthorizationContext,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<ReadOutcome<SearchResult>>;
```

Define `SearchRequest` as `{query, limit}`. Define `SearchResult` as the successful public body above.

Define `SearchResponse` as the canonical success-or-failure RPC result. Derive each type from its protocol schema.

Authorize the existing body-free, path-free read intent. Keep one active ticket for the complete response.

Validate current scope, revocation, ticket identity, ticket expiry, and ticket epoch in the native read transaction.

In the same synchronous transaction, select the epoch, ranked rows, current ETags, and coverage counts. Do not await between selections.

Join FTS matches to eligible current file rows. Do not select complete note bodies into application arrays or RPC results.

Use Drizzle parameterized SQL at the existing engine-specific FTS seam. Do not use `LIKE`, dynamic identifiers, or interpolated query text.

Reuse `createReadSession` from `application/reads.ts`. Export it with a narrow `finishAdmission` gateway parameter without changing existing behavior.

Use `assertReadDemand` before authorization and before and after native search. Join started RPC work before local slot release.

Settle known policy failures and completed local aborts. Keep unknown RPC outcomes charged until the original durable deadline.

Use `ownedReadResponse`, `jsonReadSource`, and `encodeJsonChunks` for successful search output.

Retain the slot and ticket after the final data chunk. Release only after EOF or joined cancellation and cleanup.

## Review Focus

1. Operator-like text and malicious SQL text remain literal data. They never broaden matches or execute SQL.
2. Astral characters, combining marks, and whitespace retain exact query-length and tokenizer behavior.
3. Concurrent mutations never mix old snippets with new ETags or inconsistent coverage counts.
4. Slow consumers and cancellation never release capacity over pending RPC work or durable cleanup.
5. Long combining sequences never send complete note bodies across RPC as snippets.

Task 1 owns tests for each condition below.

---

## Task 1: Complete the Search Delivery

One implementer owns tests, implementation, formatting, checks, and the commit. Keep one writer in the worktree.

### Files and Responsibilities

Create:

- `packages/protocol/src/schemas/search.ts`: canonical request, result, and RPC schemas.
- `packages/protocol/src/types/search.ts`: schema-derived types.
- `packages/protocol/test/search.test.ts`: contract boundaries and search failure encoding.
- `apps/worker/src/application/search.ts`: admission and demand checks.
- `apps/worker/src/infrastructure/sqlite/search.ts`: atomic native FTS selection and coverage.
- `apps/worker/src/transport/search.ts`: strict HTTP query validation and owned output.
- `apps/worker/test/application-search.test.ts`: admission, abort, and outcome certainty tests.
- `apps/worker/test/vault-search.test.ts`: native semantics, policy fences, consistency, and rollback tests.
- `apps/worker/test/http/search.test.ts`: real HTTP acceptance tests.
- `apps/worker/test/search-response.test.ts`: shared slots and lifetime barrier tests.

Change:

- `packages/protocol/src/schemas/files.ts`: canonical search length failures, messages, and status mappings.
- `packages/protocol/src/index.ts`: public search exports.
- `apps/worker/src/application/reads.ts`: export the existing session helper with its narrow settlement port.
- `apps/worker/src/infrastructure/durable-object/vault.ts`: compose the search store and expose RPC.
- `apps/worker/src/index.ts`: wire the search gateway without changing identity policy.
- `apps/worker/src/transport/worker.ts`: mount the router.
- `apps/worker/test/fixtures/http-worker.ts`: wire real search RPC and post-RPC fault injection.
- `apps/worker/test/entry.test.ts`: preserve production default-deny assertions for search.
- `docs/spec.md`: document implemented response fields, snippet cap, tie order, coverage, and strict query rules.

Change mutation owners only if a failing native regression proves a defect within this task.

### Step 1: Protocol RED

- [ ] Add failing schema and failure-encoding tests before implementation.
- [ ] Test query lengths 2, 3, 200, and 201 code points, including astral characters.
- [ ] Assert spaces and combining marks pass through unchanged.
- [ ] Test limits 0, 1, 20, 50, 51, fractions, and missing values.
- [ ] Assert the missing limit defaults to 20.
- [ ] Reject bare revisions, mismatched result ETag epochs, unknown response fields, and non-finite scores.
- [ ] Assert both search length failures encode as HTTP 400 with fixed safe messages.

Run from `packages/protocol`:

```sh
bun run test -- search.test.ts
```

Expect missing search exports or failed assertions, not a tool or configuration error.

### Step 2: Protocol GREEN

- [ ] Implement schemas and derived types with the exact public fields above.
- [ ] Add canonical search failures and HTTP mappings.
- [ ] Preserve the source query through validation.
- [ ] Run focused protocol tests and confirm zero failures.

### Step 3: Native and Application RED

- [ ] Add tests through the real Vault DO and real mutation paths before implementation.
- [ ] Cover `bge-m3`, `wrangler.jsonc`, `If-Match`, `/v1/files`, `cafe` against `café`, internal quotes, and literal `AND`.
- [ ] Include literal `OR`, `*`, `-`, `:`, and SQL-looking text with negative substring controls.
- [ ] Check uppercase content through native case folding.
- [ ] Test empty results, default 20 results, explicit 50 results, and deterministic rank ties.
- [ ] Assert plain snippets, finite native scores, and epoch-bound ETags.
- [ ] Check live Markdown, Canvas, attachments, oversized Markdown, and tombstones with exact coverage counts.
- [ ] Use a 1,500,000-byte Markdown blob for the AC-16 server exclusion case.
- [ ] Check update, append, restore, delete/recreate, and rename across Markdown and Canvas suffixes.
- [ ] Force failure after FTS changes and assert unchanged results, ETags, coverage, and head sequence.
- [ ] Interleave search and mutations. Assert each result reflects one committed native state.
- [ ] Test revoked grants, missing read scope, expired tickets, foreign tickets, and changed vault epochs.
- [ ] Test long combining sequences and assert snippets contain at most 1,024 code points before RPC output.
- [ ] Inspect RPC fields and assert complete note content never appears.
- [ ] Add barriers for abort before authorization, during authorization, and during search.
- [ ] Assert abort starts no later native demand and joins started work before capacity release.
- [ ] Distinguish canonical native denials from unknown RPC failures during cancellation.

Run from `apps/worker`:

```sh
bunx --no-install vitest run --config vitest.config.ts test/vault-search.test.ts test/application-search.test.ts
```

Expect missing search operations or failed assertions in the real runtime.

### Step 4: Native and Application GREEN

- [ ] Implement the gateway, native store, and DO composition.
- [ ] Bind one escaped FTS phrase as data and order by native score plus binary path.
- [ ] Select at most 50 rows and cap snippets before RPC serialization.
- [ ] Keep selection, metadata, coverage, and policy checks in one synchronous transaction.
- [ ] Reuse session ownership and demand checks.
- [ ] Correct mutation maintenance only when its failing regression identifies the exact defect.
- [ ] Run focused native and application tests and confirm zero failures.

### Step 5: HTTP and Lifetime RED

- [ ] Add real HTTP and lifetime tests before transport implementation.
- [ ] Verify every AC-15 example through HTTP.
- [ ] Test missing, duplicate, unknown, malformed, out-of-range, and noncanonical parameters.
- [ ] Assert `limit=01`, `limit=1.0`, and `limit=+1` fail without native data demand.
- [ ] Verify production default deny, test read scope, and current grant revocation.
- [ ] Hold search responses alongside content and manifest responses in the same four-slot pool.
- [ ] Assert a fifth read returns 429 with positive `Retry-After` and no native demand.
- [ ] Assert the final data chunk alone does not release capacity.
- [ ] Check EOF, cancellation, request abort, pending RPC, and pending settlement with explicit barriers.
- [ ] Inject post-search RPC loss and retain unknown outcomes until the original deadline.
- [ ] Check safe failures contain no query, note body, token, SQL, or exception text.
- [ ] Consume or cancel every response body after its assertions.

Run from `apps/worker`:

```sh
bunx --no-install vitest run --config vitest.http.config.ts test/http/search.test.ts
bunx --no-install vitest run --config vitest.config.ts test/search-response.test.ts test/entry.test.ts
```

Expect the absent route or failed ownership assertions before implementation.

### Step 6: Transport GREEN and Documentation

- [ ] Implement the router and gateway composition.
- [ ] Use shared response ownership and bounded JSON encoding, not a separate search slot pool.
- [ ] Document the implemented contract details from this plan in the specification.
- [ ] Document authority, Unicode units, snippet limits, coverage, and ownership effects with TSDoc.
- [ ] Run focused HTTP and lifetime tests and confirm zero failures.

### Step 7: Validate and Commit

- [ ] Format changes through the existing Biome setup.
- [ ] Run `bun run docs:check` during corrections.
- [ ] Run `bun run check` from the worktree root.
- [ ] Record actual RED commands and observed assertions in Backlog notes.
- [ ] Record retained-code exceptions without deleting working code or inventing earlier failures.
- [ ] Record results and limits in Backlog, not a separate evidence document.
- [ ] Commit after all checks pass.

Suggested title:

```text
feat(worker): add bounded literal Markdown search
```

## Acceptance and Publication

| OAB-6.7 criterion | Evidence |
| --- | --- |
| AC 1: literal trigram semantics | Native and HTTP AC-15 tests |
| AC 2: limits, ranking, snippets | Protocol boundaries, native ranking, bounded snippets, HTTP validation |
| AC 3: index membership and coverage | Mixed fixtures, blob transitions, AC-16 server assertions |
| AC 4: atomic index consistency | Mutation rollback, rename/delete/recreate, and native read interleavings |

Use one independent reviewer after complete implementation. Load the code-review skill and its TypeScript profile.

Review the complete branch before task closure. Record revision, documentation scope, structural candidates, validation results, and limits in Backlog.

Give each actionable finding an evidence-based closure entry. Nearby passing tests alone do not close a finding.

Open one human branch review against `main`. Address every annotation before the PR.

After acceptance, push the branch and create an English Conventional Commit-style PR. Never merge locally into `main`.

Remove the worktree after publication only when no local-only files remain. Preserve unpushed commits and local files.

This task proves server search only. It does not close F1 or qualify MCP, plugin behavior, deployed native memory, or aggregate platform headroom.

## Command Handling

The parent uses background shell tasks for installation, tests, and builds. End each command with pass/fail counts and its exit code.

Workers run their checks and wait for results. They report actual commands, results, and remaining limits.

Wrap expected RED commands so their task exits zero and records the observed code. Assert the expected failure from that output.

Do not classify a runtime setup error as a failing product test.
