# F1 History Mutations Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` after owner approval. Each task includes tests, implementation, checks, and its commit.

**Goal:** Complete OAB-6.4 after the owner-approved OAB-6.8.1 measurement prerequisite.

**Architecture:** Reuse durable admission and atomic mutation coordination. Keep canonical contracts in Zod, route mechanics in transport, and publication policy in SQLite owners. All new mutations share the existing authority.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Drizzle, SQLite Durable Objects, Vitest, and the pinned local Workers runtime.

**Spec:** `docs/spec.md` sections 5, 6, 8, 10, 12, and 13. Backlog tasks OAB-6.4 and OAB-6.8.1 define this delivery boundary.

## Approval Gate

This document proposes work. No product implementation starts before explicit owner approval.

The owner approved two planning decisions:

- Complete OAB-6.8.1 measurements before OAB-6.4 changes publication SQL.
- `as_conflict_copy: true` restores at the same path, preserves displaced history, and checks the current destination ETag.

The flag does not create another path. Clarify that interpretation through OAB-6.4 without unrelated spec changes.

## Starting State

- Fetched `origin/main`: `58b074f`.
- GitHub merged PR #10 at `9c59238`. PR #11 changes execution instructions.
- Branch: `feature/oab-6.4`.
- Worktree: `~/.worktrees/obsidian-ai-bridge/feature/oab-6.4`.
- Preserve the owner's original checkout, branch, and working files.
- OAB-6.3 is complete. The owner selected OAB-6.8.1 as an explicit prerequisite here.
- This planning turn does not install dependencies or run baseline tests. Approval precedes those actions.

## Global Constraints

- Every mutation uses exact observed authority state. Append observes the current revision during server processing.
- Absence never deletes. An obsolete revision never overwrites. Every collision leaves visible files or revisions.
- Destination revisions continue for each exact path's lifetime. Rename never inherits source numbering.
- Inline text has a 1,000,000-byte maximum. Paths have a 512-byte and 32-segment maximum.
- Tickets keep their original 60-second deadline. Preserve the 16-client and 1,024-global admission limits.
- Keep receipts client-scoped. Preserve fingerprints, replay rules, and ticket ownership.
- Publish files, revisions, feed, FTS, counters, and receipts in one synchronous transaction.
- Do not await inside a transaction or retain a native cursor across an await.
- Authorize before body consumption and content effects. Recheck scope, revocation, epoch, and ticket ownership at commit.
- Define protocol shapes only in `packages/protocol`. Derive types from Zod.
- Use workspace aliases, public cross-workspace exports, and useful TSDoc for semantic declarations.
- Add no dependencies. Do not change Git identity.
- Do not access the personal vault or change Cloudflare resources. Builds use local dry-run mode only.
- Do not claim plugin behavior, deployed behavior, full F1 completion, or aggregate capacity qualification.

## Review Focus

1. Async append hashing can race with another mutation. Recheck the exact input snapshot before publication.
2. Case-only rename can meet live-key uniqueness. Tombstone the source before the destination write in the same transaction.
3. Rename can target an old tombstone. Continue destination numbering and preserve both histories.
4. Restore retries can meet a later delete. An old precondition cannot publish again.
5. Encoded filenames can resemble command suffixes. Parse raw routing syntax before exactly one path decode.

Tasks 3 and 4 include regression cases for each condition.

## File Structure

Retain these owners:

- `packages/protocol/src/schemas/admission.ts`: common descriptors and admission refinements.
- `packages/protocol/src/schemas/files.ts`: existing results, failures, and HTTP policy.
- `packages/protocol/src/codecs/files.ts`: canonical failure encoding.
- `apps/worker/src/application/admission.ts`: immutable fingerprints and operation scopes.
- `apps/worker/src/infrastructure/sqlite/admission.ts`: authority checks and ticket consumption.
- `apps/worker/src/infrastructure/sqlite/mutations.ts`: replay and atomic publication coordination.
- `apps/worker/src/infrastructure/sqlite/text-files.ts`: inline publication and append.

Add focused owners:

- `packages/protocol/src/schemas/history.ts`: command requests and retained-history results.
- `packages/protocol/src/types/history.ts`: inferred public types.
- `apps/worker/src/application/history.ts`: command gateway and admission orchestration.
- `apps/worker/src/infrastructure/sqlite/history.ts`: rename, history listing, and conditional restore.
- `apps/worker/src/transport/history.ts`: history and command route mechanics.
- `apps/worker/test/vault-publication-budgets.test.ts`: native workload measurements.
- `apps/worker/test/fixtures/publication-budgets.ts`: measurement collection and SQLite record-size calculation.
- `apps/worker/test/vault-history.test.ts`: rename and restore invariants.
- `apps/worker/test/vault-append.test.ts`: append races, replay, and refusals.
- `apps/worker/test/http/history.test.ts`: real HTTP behavior.

Extend existing fixtures and public exports. Share publication mechanics only where they express the same invariant.

## Task 1: Measure Existing Publication — OAB-6.8.1

**Files:** Add the measurement test and fixture above. Extend existing SQLite constructors only for a typed optional query observer.

**Interfaces:** The observer receives SQL text and bind count, never bind values. It cannot replace native storage, cursors, or transactions.

- [ ] Install dependencies with `bun install --frozen-lockfile` inside the isolated worktree.
- [ ] Run baseline `bun run check`. Stop and report baseline failures before implementation.
- [ ] Add failing measurement tests for create, update, DELETE, successful replay, and rejection.
- [ ] Assert positive observed query counts and at most 100 bound parameters per query.
- [ ] Separate reservation, authorization, commit, and settlement counts. Exclude setup and measurement SQL.
- [ ] Collect application SQL through the native Drizzle adapter's typed logger hook.
- [ ] Account for direct SQL outside that adapter separately. Distinguish SQL dispatch counts from successful native outcomes.
- [ ] Verify actual native results and rollback state for each measured operation.
- [ ] Run 1,000,000-byte Markdown and Canvas workloads with bounded worst-case metadata.
- [ ] Include a 512-byte normalized path, 2,048-byte client identity, 128-character key, and safe maximum integer fields.
- [ ] Measure every file, revision, and receipt column using SQLite record encoding, including headers, serial types, and varint sizes.
- [ ] Test the size calculator against known small records, UTF-8, NUL bytes, nulls, and integer width boundaries.
- [ ] Report content bytes, encoded record bytes, receipt JSON bytes, and `sql.databaseSize` growth separately.
- [ ] Assert complete records and individual strings/blobs stay below the documented 2 MB limit.
- [ ] Do not substitute JSON object size or database growth for complete SQLite record size.
- [ ] State that whole-runtime memory remains unmeasured. Successful workloads do not prove aggregate headroom.
- [ ] Keep observations in tests and their output. Do not add an evidence document.
- [ ] Run focused native tests, `bun run docs:check`, and `bun run check`.
- [ ] Commit as `test(worker): measure native publication SQL and row sizes`.
- [ ] Request one independent task review. Close OAB-6.8.1 only after evidence satisfies all four criteria.

**Measurement boundary:** The cited storage API exposes cursors and database size, but no complete SQL trace API.
A logger counts application dispatch, not SQLite internal FTS statements or implicit transaction control.
State that limit explicitly during review.

If native evidence cannot satisfy OAB-6.8.1 without an SDK replacement, stop and ask the owner before new publication SQL.

## Task 2: Define Canonical History Commands — OAB-6.4

**Files:** Add protocol history schemas, inferred types, and `packages/protocol/test/history.test.ts`. Extend admission schemas, failures, codecs, exports, and fingerprint tests.

**Interfaces:**

- `RenameRequestSchema`: strict `{to}` with canonical `PathSchema`.
- `RestoreRequestSchema`: strict `{source_rev, as_conflict_copy?}` with a positive safe revision and optional boolean.
- `HistoryRequestSchema`: strict `{path, epoch?}` for current-vault retained history.
- `HistoryResultSchema`: ascending retained `{rev, hash, size, deleted, origin, at}` entries, without content bodies.
- `FileCommandSchema`: discriminated rename/append/restore command bodies with their authority descriptors.
- Derive request and result types from Zod. Reuse `MutationReceipt` for success.
- Rename success identifies the destination and its ETag.

- [ ] Write failing tests for strict bodies, normalized paths, safe revisions, and existing admission refinements.
- [ ] Add canonical `tombstone` 409, `path_occupied` 409, `idempotency_key_required` 428, and unsupported append content 415 failures.
- [ ] Keep failure messages and statuses in protocol owners. Do not add another transport status table.
- [ ] Extend current-epoch queries to cover new operation scopes without content access.
- [ ] Enforce a mandatory append key at application and native authority boundaries.
- [ ] Bind both rename paths and restore source revision/flag into immutable command fingerprints.
- [ ] Hash exact bounded command JSON bytes. Verify command identity against that hash at commit.
- [ ] Bind append identity to exact input bytes, not the resulting file or an earlier snapshot.
- [ ] Preserve existing PUT and DELETE fingerprint compatibility.
- [ ] Test changed destinations, source revisions, flags, append bytes, clients, epochs, and preconditions under one key.
- [ ] Clarify the owner-approved restore meaning in `docs/spec.md` sections 6.1 and 8.
- [ ] Run protocol tests, `bun run docs:check`, and `bun run check`.
- [ ] Commit as `feat(protocol): define history mutation contracts`.
- [ ] Request one independent task review before Task 3.

## Task 3: Publish Native History Commands

**Files:** Add application/native history owners and native tests. Extend text storage, admission integration, fixtures, and Vault composition.

**Interfaces:**

- `executeFileCommand(gateway, context, descriptor, key, readCommand)` reserves before bounded body reads.
- `HistoryVaultGateway.commitFileCommand(context, intent, ticketId, command, key?)` returns the canonical mutation result.
- `HistoryVaultGateway.readHistory(context, request)` returns retained metadata after native policy checks.
- `Vault` delegates these methods to the SQLite history owner.
- Extend existing text mutation contracts for append with a mandatory key and observed epoch.

### Rename

- [ ] Write failing native AC-14 and AC-26 cases before implementation.
- [ ] Check the live source and exact ETag. Reject deleted sources and identical source/destination paths without content effects.
- [ ] Allow case-only rename. Reject another occupied destination key with `path_collision` and `existing_path`.
- [ ] Set source `from_rev = source.rev + 1`. Set destination `to_rev = destination.rev + 1`, or 1 when absent.
- [ ] Publish one rename entry with destination path/revision/hash and source path/tombstone revision.
- [ ] Give both file heads the same sequence. Write both revision rows and preserve older rows.
- [ ] Tombstone the source before writing the destination inside the same transaction.
- [ ] Move text bytes or an existing immutable blob reference without R2 writes.
- [ ] Adjust live counts once and update FTS for both paths and extensions atomically.
- [ ] Test missing sources, stale ETags, aliases, old destination tombstones, numeric overflow, and Markdown/Canvas transitions.
- [ ] Force failures after publication stages. Compare exact snapshots, including admissions and claims.
- [ ] Edit the destination later. Verify the rename revision still returns its original bytes.

### Append

- [ ] Write failing native tests for concurrent distinct keys and same-key response loss.
- [ ] Read current live text after authorization. Preserve exact UTF-8, including BOM, NUL, and non-ASCII bytes.
- [ ] Prepare candidate bytes and SHA-256 outside the synchronous transaction.
- [ ] Compare candidate epoch, revision, kind, deletion state, and content identity before publication.
- [ ] If state changes, discard the candidate and repeat preparation against current state without consuming ownership.
- [ ] Use the original ticket deadline as the retry deadline. Never extend it or publish after expiry.
- [ ] Recheck authority and state in the final transaction. Publish only the verified candidate.
- [ ] Test intervening PUT, DELETE, rename, revocation, epoch change, and ticket expiry.
- [ ] Return 404 for missing paths, 409 for tombstones, 415 for blobs, and 413 for oversized results.
- [ ] Test exactly 1,000,000 result bytes, one byte above, empty input, and multibyte boundaries.
- [ ] Reject missing keys with 428. Replay identical keys once. Reject changed bytes with 422.
- [ ] Check complete immutable publication state on every refusal.

### History and Restore

- [ ] Write failing native tests for exact retained bytes and restore after a later delete.
- [ ] List retained metadata without full content materialization. Consume native cursors synchronously.
- [ ] Select source history from the current epoch and exact destination path. Return `revision_pruned` for missing retained sources.
- [ ] Reject deleted source revisions with `invalid_request`. Do not invent content for tombstones.
- [ ] Enforce the current destination ETag for live files and tombstones.
- [ ] Return `path_occupied` for live destinations unless `as_conflict_copy` is true.
- [ ] With consent, restore the same path and retain the displaced revision unchanged.
- [ ] Restore text or existing immutable blob references without R2 content access or writes.
- [ ] Reject live-key aliases when restoring a tombstoned spelling.
- [ ] Create a new revision and ordinary PUT feed entry. Update FTS, counters, and receipt atomically.
- [ ] Test unkeyed restore, lost response, later DELETE, and old-precondition retry. Expect 412 without resurrection.
- [ ] Test keyed replay after later DELETE. Return the original receipt without another publication.
- [ ] Test write-only precondition failures. Never return current content without read scope.
- [ ] Test actor eviction/recreation and exact retained reads with the real pinned runtime.
- [ ] Repeat measurements for rename, append, and restore. Compare SQL and row observations without aggregate claims.
- [ ] Run focused native suites, `bun run docs:check`, and `bun run check`.
- [ ] Commit as `feat(worker): preserve history through atomic file commands`.
- [ ] Request one independent task review before Task 4.

## Task 4: Expose Real HTTP Commands and Verify the Branch

**Files:** Add transport history routes and HTTP tests. Extend worker composition, file route parsing, gateway fixtures, and existing HTTP regressions.

- [ ] Write failing real `SELF.fetch` tests for all commands and history listing.
- [ ] Register `POST /v1/files/*path:rename`, `:append`, `:restore`, and `GET /v1/history/*path`.
- [ ] Detect literal command suffixes in the raw pathname before one percent decode.
- [ ] Test percent signs, spaces, Unicode, encoded suffix filenames, and double-encoded path characters.
- [ ] Preserve PR #10 path identity regressions. Reject malformed paths without publication effects.
- [ ] Use strict JSON for rename/restore and exact raw UTF-8 for append.
- [ ] Reserve before body reads. Enforce actual byte limits without trusting Content-Length.
- [ ] Reuse cancellation and uncertain settlement. Do not release uncertain ownership through guessed outcomes.
- [ ] Keep production identity denial. Inject test identity only in test composition.
- [ ] Test scopes, revocation, missing append key/epoch, malformed ETags, collision details, and size/kind refusals.
- [ ] Test delayed-body interleaving with explicit read-demand barriers, not timers as ordering proof.
- [ ] Test response loss, replay, and restore/delete/retry through HTTP and native state inspection.
- [ ] Verify rename needs no later PUT and keeps its exact destination revision readable after later edits.
- [ ] Keep history content-free. Use the existing revision-pinned endpoint for historical bytes.
- [ ] Run `bun run docs:check` and `bun run check`.
- [ ] Commit as `feat(worker): expose conditional history mutation routes`.
- [ ] Request one independent task review and one final whole-branch review against `main`.
- [ ] Use `code-review` with its TypeScript profile. Check documentation truth and state-policy ownership.
- [ ] Probe changed TypeScript paths with active LSP diagnostics. Do not call inconclusive probes clean.
- [ ] Record each actionable finding and evidence-based closure in task notes, not another document.
- [ ] Open one human branch review against `main`. Address all annotations before publication.
- [ ] Read Backlog finalization instructions. Close OAB-6.4 only with direct passing-test evidence for its criteria.
- [ ] Use the branch-finishing skill. Push and create an English Conventional Commit PR after approval and passing checks.
- [ ] Never merge locally into main. Remove the linked worktree only after all commits reach the remote.

## Commands and Execution

Run commands from the isolated worktree. Long commands use `bg_run` and end with pass/fail counts and exit status.

```sh
cd apps/worker
bunx vitest run --config vitest.config.ts test/vault-publication-budgets.test.ts
bunx vitest run --config vitest.config.ts test/vault-history.test.ts test/vault-append.test.ts
bunx vitest run --config vitest.http.config.ts test/http/history.test.ts test/http/files.test.ts
```

Run protocol tests with `bun run --filter '@obsidian-ai-bridge/protocol' test`.
Run final `bun run check` from the repository root for every task.

Wrap expected RED failures so the background command exits zero and prints the observed test exit code.
Inspect the exact behavioral assertion. Syntax errors and fixture exceptions do not prove functional RED.

Implementers own complete tasks, debugging, checks, and commits. The parent examines results without routine test repetition.
Use explicit configured models. Stop and report agent-launch or runtime failures.

## External Contract References

Read on 2026-10-19:

- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/platform/limits/

The storage contract defines `sql.databaseSize` in bytes and synchronous cursors.
It states that `transactionSync` rolls back when its synchronous callback throws.
The limits contract sets 100 bound parameters and a 2 MB maximum for each string, BLOB, or row.
Local pinned-runtime tests, not current web documentation alone, decide this branch's behavior.

## Self-Review

- OAB-6.4 criterion 1 maps to Task 3 rename and Task 4 immutable HTTP reads.
- Criterion 2 maps to Task 2 key/epoch contracts and Task 3 append races/refusals.
- Criterion 3 maps to retained-byte restore and keyed/unkeyed retry tests.
- Criterion 4 maps to native actor/interleaving tests and real HTTP tests.
- OAB-6.8.1 remains a prerequisite until measurement review confirms all four criteria.
- Tasks 3 and 4 contain tests for all five Review Focus conditions.
- Existing schema 3 stores rename fields and immutable revisions. No migration is planned.
- Blob upload integrity remains OAB-6.5. Feed endpoints remain OAB-6.6. Search remains OAB-6.7.
- Retention, capacity guards, and aggregate budgets remain OAB-6.8. MCP and plugin behavior remain outside this branch.
