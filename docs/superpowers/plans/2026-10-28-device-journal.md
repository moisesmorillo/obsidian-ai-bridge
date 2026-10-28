# OAB-8.1 Device Journal Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. One worker owns implementation, tests, checks, and its commit.

**Goal:** Preserve device operations and exact retry bytes across desktop plugin restarts.

**Architecture:** A serialized journal owns validated device-local state and the send barrier. An Obsidian adapter stores one localStorage document and excluded payload files. No network publisher exists in this PR.

**Tech Stack:** TypeScript, Zod, Vitest, Obsidian APIs, Web Crypto, Bun, Biome.

**Spec:** `docs/spec.md` sections 5.1, 6.4, 7.1, and 7.7. `decision-1` keeps device revocation as an F3 exit obligation.

## Scope and decisions

The owner authorizes F3 decomposition and one implementation PR after this plan approval. This plan covers only OAB-8.1.

The plugin currently has an inert lifecycle and browser-compatible artifact tests. The service already supplies conditional mutations and idempotency receipts.

Use a durable journal first. A network-first implementation cannot safely retry after a restart. A complete synchronizer in one PR prevents focused review.

Store payload bytes when enqueueing, before publishing their journal reference. This protects queued bytes across restart as well as sent bytes. A failed journal write can leave an unreferenced payload. Keep that file rather than risk deleting referenced bytes.

Use canonical Zod schemas in `packages/protocol` for persisted state and operation shapes. Derive types from these schemas. Add only fields this task uses. Later tasks extend state with their actual apply and reconciliation contracts.

Use a versioned device state with `device_id` and `pending_ops`. Include the epoch in each operation's exact mutation precondition. Do not invent enrollment identities or server bases before enrollment exists.

A queued follower behind a sent operation cannot become sendable until its predecessor resolves. The future publisher supplies the newly observed precondition before the follower becomes sent. Never change a sent operation's key, operation, path, destination, precondition, or payload.

Credentials, enrollment, event capture, remote apply, status panel, and polling remain outside this PR. Do not claim full AC-30 or F3 device proof from journal tests.

## Global constraints

- Keep exact observed preconditions. Absence never deletes. Obsolete revisions never overwrite. Collisions retain both versions.
- Use no Node or Electron runtime APIs. Keep `isDesktopOnly: false` and `minAppVersion: 1.13.0`.
- Use localStorage for device state, not `data.json`. Store no tokens in this journal.
- Restrict payload paths to `.ai-bridge/pending/<validated UUIDv7>`.
- Use public protocol exports across workspaces and `@plugin/*` aliases inside the plugin.
- Add useful TSDoc for named declarations. Add no new external dependency.
- Only `~/vaults/obsidian-ai-bridge-dev` and `~/vaults/obsidian-ai-bridge-dev-2` are authorized test vaults.
- Test vault 2 came from test vault 1 on 2026-10-28. Both include `.obsidian`. The copy contains 84 files.
- Never access iCloud or the personal vault. Never delete deployed `oab-7.8/` evidence.
- No Cloudflare resource changes or manual deployment belong to this task.
- This PR changes `packages` and can change workspace manifests and `bun.lock`. Their merge to `main` deploys the Worker through GitHub Actions.
- The deployment trigger also includes `apps/worker`, root `package.json`, `mise.toml`, and `deploy.yml`, since PR #28.
- No Worker behavior change is planned. Resources remain under OpenTofu in the separate `cloudflare-infra` repository.

## Feasibility observations

The installed Obsidian 1.14.4 declarations expose synchronous `App.loadLocalStorage` and `App.saveLocalStorage`.

The same declarations expose adapter `readBinary` and `writeBinary`. The payload adapter can use them without Node APIs.

A localStorage call gives no disk-flush guarantee. The contract uses immediate read-back verification, not a stronger durability claim.

Web Crypto supplies SHA-256 and random bytes. Generate UUIDv7 keys with timestamp and random fields without an external package.

The baseline check runs separately before implementation. A baseline failure blocks implementation until resolved.

## Review focus

1. Failed writes must not release operations from unconfirmed state.
2. Restart and returned object mutation must not change immutable retry bytes or metadata.
3. Concurrent enqueue and send calls must not lose updates or release a follower early.
4. Invalid state and forged payload paths must not cause file access or replacement with empty state.
5. Partial payload writes and unload during an asynchronous action must not create an unguarded send path.

## Files and interfaces

- Create `packages/protocol/src/schemas/device-state.ts`: canonical persisted operation and journal schemas.
- Update `packages/protocol/src/index.ts`: public schema and inferred type exports.
- Create `packages/protocol/test/device-state.test.ts`: schema validation tests. Follow existing test placement if it differs.
- Create `apps/plugin/src/sync/device-journal.ts`: serialized operation transitions and validated snapshots.
- Create `apps/plugin/src/infrastructure/device-storage.ts`: Obsidian localStorage and excluded binary payload access.
- Update `apps/plugin/src/main.ts`: open the journal on load without network or note changes. Stop accepting actions on unload.
- Create `apps/plugin/test/device-journal.test.ts` and `apps/plugin/test/device-storage.test.ts`.
- Update `apps/plugin/test/lifecycle.test.ts` and host doubles for the new device-local initialization.
- Update `apps/plugin/package.json` and `bun.lock` only to consume the existing protocol workspace package.

The worker can refine private helper names, not these authority boundaries:

- `DeviceJournal.open(storage): Promise<DeviceJournal>` validates or initializes state.
- `enqueue(input, bytes): Promise<PendingOperation>` creates a UUIDv7 key and verified durable payload before state publication.
- `prepareSend(key, precondition): Promise<{ operation, bytes }>` checks predecessor ordering, verifies bytes, persists `sent`, then returns defensive copies.
- Repeating `prepareSend` for a sent key returns its original metadata and bytes. A different precondition is rejected.
- `resolve(key, outcome): Promise<void>` accepts only explicit receipt or rejection outcomes. It removes or resolves the operation through confirmed persistence.
- `snapshot()` returns a defensive validated snapshot. `close()` blocks new actions without deleting state or payloads.
- Storage failures expose an attention reason and block send release. A later successful verified write can restore journal operation.
- Ports cover only local document read/write and payload read/write. Application code must not import Obsidian.

## Task 1: Implement the durable journal and host integration

- [ ] Write schema tests for valid put/delete/rename operations, UUIDv7 keys, exact epoch-bearing preconditions, and operation-specific fields.
- [ ] Reject invalid versions, duplicate keys, unsafe payload references, invalid paths, invalid hashes, and invalid state transitions.
- [ ] Write `device-journal` tests before implementation. Assert these exact behaviors:
  - Missing storage creates one stable device identity. Restart reuses it.
  - Corrupt storage never becomes empty replacement state and releases no operation.
  - A dropped or throwing document write leaves the last confirmed snapshot and blocks sends.
  - Payload write failure or SHA-256 mismatch releases nothing.
  - Enqueue A, prepare A, enqueue B for the same path, restart, retry A returns A's original key and bytes.
  - B has a different UUIDv7 key. Preparing B fails until A resolves.
  - Replacing a queued edit creates a new key and does not change a sent predecessor.
  - Resolving A never advances a feed cursor or guesses B's next revision.
  - Concurrent enqueues retain both unrelated edits. Concurrent send preparations preserve ordering.
  - Mutation of input arrays or returned objects cannot change stored operations or retries.
  - Close rejects new operations and does not remove stored bytes.
- [ ] Run focused tests and record the expected failing assertions before implementation.
  - Run `bun run --cwd apps/plugin test` and the protocol workspace tests.
  - Wrap expected failures to print their exit codes and exit successfully. Inspect the actual failing assertions.
- [ ] Implement canonical schemas, serialized transitions, defensive snapshots, UUIDv7 generation, and hash verification.
- [ ] Implement the Obsidian adapter with whole-document write/read-back checks and confined payload paths.
- [ ] Add adapter tests for missing directories, partial writes, existing payload mismatch, storage exceptions, and read-back mismatch.
- [ ] Integrate journal initialization into the production lifecycle. Keep network, user notes, and credentials untouched.
- [ ] Test initialization failure as an attention condition. Never erase invalid state or claim settled status.
- [ ] Run focused tests and confirm success. Run `bun run docs:check` during correction.
- [ ] Run `bun run check`. Preserve actual command results and RED/GREEN evidence in task notes.
- [ ] Commit implementation and Backlog decomposition with a Conventional Commit message.

## Review and publication

- [ ] Use one fresh task reviewer with the code-review skill and TypeScript profile. Address each finding with evidence.
- [ ] Complete a session-model whole-branch review against `main`. Record revision, scope, structural candidates, checks, and limits in task notes.
- [ ] Open one Plannotator branch review against `main`. Address every owner annotation before the PR.
- [ ] Read Backlog finalization instructions and verify each OAB-8.1 acceptance criterion before closure.
- [ ] Push the branch, open the focused PR, and inspect remote CI. Never merge locally.
- [ ] Remove the worktree only when its commits are safely pushed and publication checks pass.
- [ ] Report the PR and stop. Do not implement OAB-8.2 in this session.

## F3 coverage and limits

The ordered tasks cover every requested F3 case:

| Task | Scope and acceptance ownership |
| --- | --- |
| OAB-8.1 | Durable journal and AC-30 retry foundation |
| OAB-8.2 | PKCE enrollment and credential storage |
| OAB-8.3 | Text apply, AC-02, AC-10, AC-32, AC-39 |
| OAB-8.4 | Enrollment reconciliation, AC-13, AC-20 |
| OAB-8.5 | Publishing and rename, AC-03 through AC-06, AC-24, AC-30, AC-33 |
| OAB-8.6 | Blob handling, AC-31 |
| OAB-8.7 | Serialized loop, status panel, Sync now, device AC-08 |
| OAB-8.8 | All required cases in two Obsidian vaults, real ChatGPT AC-09, and owner-interactive checks |

Only OAB-8.1 has an implementation plan. The later tasks record outcomes, dependencies, and acceptance criteria, not speculative implementation steps.

Automated journal tests prove storage behavior under their injected failures. They do not prove Obsidian crash recovery, OAuth consent, device revocation, or the full two-vault synchronization gate.
