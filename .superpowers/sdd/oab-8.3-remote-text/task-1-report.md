# OAB-8.3 Remote text task report

## Result

Implemented revision-pinned text apply, durable conflict recovery, exact-hash echo state, and the Obsidian text adapter. The Backlog task remains In Progress.

## Changed files

- `packages/protocol/src/schemas/device-state.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/test/device-state.test.ts`
- `apps/plugin/src/sync/device-journal.ts`
- `apps/plugin/src/sync/text-apply.ts`
- `apps/plugin/src/infrastructure/text-vault.ts`
- `apps/plugin/test/device-journal.test.ts`
- `apps/plugin/test/text-apply.test.ts`
- `apps/plugin/test/text-vault.test.ts`
- `apps/plugin/test/obsidian.ts`
- `backlog/tasks/oab-8.3 - Apply-remote-text-and-preserve-durable-conflict-copies.md`

No dependency or lockfile changed. No polling, publishing, reconciliation, status panel, browser, vault, or deployed service changed.

## TDD evidence

- RED: `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` failed one test. Old state lacked the new `pending_apply`, `base`, `expected_writes`, and `attention` defaults.
- RED: `bun run --filter '@obsidian-ai-bridge/plugin' test -- device-journal.test.ts` failed because `DeviceJournal.beginApply` did not exist.
- RED: the first text-apply run failed because `text-apply.ts` did not exist. After the initial implementation, the process-race test failed because the user edit remained at the original path instead of yielding the remote text plus conflict copy.
- GREEN: the focused protocol test passed 9 tests. The final focused plugin run passed 45 tests across journal, apply, and adapter tests.
- Added restart tests for prepared state, conflict-copy creation, copied state, edited copies, and a confirmed write before base commit. Added tests for create races, case-folded collision, rename sides, explicit delete, identical text, obsolete revisions, and exact-hash echoes.

## Commands and results

- `backlog instructions overview` — passed.
- `backlog instructions task-execution && backlog task view OAB-8.3 --plain` — passed. The task was In Progress before edits.
- `bun install --frozen-lockfile` — passed. It installed existing locked dependencies only.
- `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` — RED first, then passed 9 tests.
- `bun run --filter '@obsidian-ai-bridge/plugin' test -- device-journal.test.ts` — RED first, then passed during focused validation.
- `bun run --filter '@obsidian-ai-bridge/plugin' test -- text-apply.test.ts` — passed 14 tests.
- `bun run --filter '@obsidian-ai-bridge/plugin' test -- device-journal.test.ts text-apply.test.ts text-vault.test.ts` — passed 45 tests.
- `bun run docs:check` — passed.
- `bun run check` — passed with exit code 0. Biome, documentation checks, type checks, tests, and builds all passed.
- Full check test totals: tooling 56, protocol 297, plugin 87, and Worker 646. Total: 1,086 passed.
- Worker tests printed expected injected network and SQLite failure diagnostics. All Worker test files and tests passed.

## Self-review

Canonical Zod schemas own persisted apply and base shapes. TypeScript types derive from those schemas. The journal validates full-document read-back and exact remote revision identity before base changes.

The application engine imports no Obsidian SDK type. The infrastructure adapter uses `Vault.process`, `Vault.create`, local trash, and `Vault.rename`. Pinned reads include epoch and revision, then verify the SHA-256 digest.

The engine serializes operations. The journal serializes durable transitions. Process writes compare the exact observed string inside the host callback. Conflicts persist a deterministic path, source, mode, and hash before copy effects. Recovery verifies the copy before it applies the remote entry.

The stateful policy has one application owner in `text-apply.ts`. The adapter owns host mechanics. Tests cover the core revision, conflict, rename, collision, and recovery rows. No separate policy owner or dependency drift appeared in this self-review.

## Host limits and residual concerns

Obsidian exposes no conditional trash or rename API. The adapter rechecks file identity and exact bytes before those operations. A user edit can still occur between that recheck and the host effect. The code does not claim an atomic guarantee for trash or rename.

Tests use isolated fake vaults. They do not run inside the Obsidian host or two real vaults. Parent-owned live validation remains in OAB-8.8. The conflict name uses the stable device UUID because current device state has no separate friendly device name.

The plugin does not yet wire a feed or pinned-text transport into `main.ts`. This task exposes the apply API and provider port only. Feed scheduling and publishing remain outside this scope. The first review round also found that conflict names used a UUID. The correction below supplies the required friendly device name.

No blocker appeared in self-review. The parent must run the independent review and any live validation that it owns.

## Commit and final state

- Commit: `dce8af8bf532398bd2d3f94eccb49b244fee0a1f`.
- `git diff --check` and `git diff --cached --check` passed after commit.
- The worktree was clean after the first implementation commit. The task remains In Progress.

## Review correction round

**Prior revision:** `dce8af8bf532398bd2d3f94eccb49b244fee0a1f`. The Backlog task remains In Progress.

### RED and GREEN evidence

- RED: `bun run --filter '@obsidian-ai-bridge/plugin' test -- text-apply.test.ts` — 5 failed, 15 passed. Failures showed a false destination conflict, unchecked source-trash refusal in both initial rename paths, missing friendly-name metadata, and base advancement after close during pinned fetch.
- RED: `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` — 1 failed, 9 passed. The schema accepted unsupported remote-mode operations and `effect_confirmed`.
- GREEN: `bun run --filter '@obsidian-ai-bridge/plugin' test -- text-apply.test.ts device-journal.test.ts` — 57 passed across 2 files.
- GREEN: `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` — 10 passed.
- Regression coverage also checks recovery trash refusal, every accepted persisted state, delete and rename recovery after `named` and `copied` restarts, remote collision recovery after both steps, and device-name stability after restart.

### Finding closures

- **MAJOR — Clean destination-only rename:** `applyRename` compares the destination with its confirmed base and replaces only absent or clean text. `applyRemoteText` uses an exact observed-value guard and read-back check. `text-apply.test.ts` asserts that a clean existing destination receives remote text without a conflict copy.
- **MAJOR — Rename source trash confirmation:** `confirmRenameSourceTrash` passes the exact observed text to trash and checks that the source path is absent. Initial remote-equal and destination-write paths and restart recovery all keep the pending apply and record attention when the source remains. Tests cover each refusal path and preserve source bytes and base revisions.
- **MAJOR — Engine close fencing:** `fetchText` checks engine lifetime after the pinned read and digest. `activeJournal` rejects durable transitions after close, and the engine queue rejects queued apply work. The held-fetch test closes the engine, releases the provider, and confirms that the source revision remains pending without a base commit.
- **MINOR — Device name in conflict names:** `TextApplyOptions.deviceName` supplies the required friendly name. New local and remote conflict metadata persists that name and deterministic path. The schema accepts prior named/copied records without the new optional field, and restart tests keep the saved path when engine options change.
- **MINOR — Persisted state validation:** `PendingApplySchema` now accepts only `prepared`, `named`, and `copied`. It requires complete conflict metadata for named/copied steps and restricts remote collision mode to put entries. Tests reject `effect_confirmed`, remote delete/rename, and partial metadata while accepting prior valid records.

### Commands and results

- `bun run --filter '@obsidian-ai-bridge/plugin' test -- text-apply.test.ts` — RED: 5 failed, 15 passed.
- `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` — RED: 1 failed, 9 passed.
- `bunx biome check --write apps/plugin/src/sync/device-journal.ts apps/plugin/src/sync/text-apply.ts apps/plugin/test/text-apply.test.ts packages/protocol/src/schemas/device-state.ts packages/protocol/test/device-state.test.ts` — passed; formatted 5 files.
- `bun run --filter '@obsidian-ai-bridge/plugin' test -- text-apply.test.ts device-journal.test.ts` — passed; 57 tests.
- `bun run --filter '@obsidian-ai-bridge/protocol' test -- device-state.test.ts` — passed; 10 tests.
- `bun run docs:check` — passed.
- `bun run check` — passed with exit code 0. Biome, documentation checks, type checks, all tests, and builds passed.
- Full check totals: tooling 56, protocol 298, plugin 99, and Worker 869. Total: 1,322 passed.
- `git diff --check` — passed before report update. No staged files exist.
- Worker tests printed expected injected network and SQLite failure diagnostics. All Worker test files and tests passed.

### Residual risks

Obsidian still lacks atomic conditional trash and rename APIs. The adapter rechecks exact bytes, but a user edit can occur between that check and a host effect. Fake-vault tests do not replace live Obsidian or two-vault validation. The parent owns that validation. No polling, publishing, reconciliation, status panel, browser, live vault, or deployed service changed.

### Commit and final state

The review correction is committed. The final commit SHA appears in the task result. The Backlog task remains In Progress. The worktree has no staged or unstaged files.
