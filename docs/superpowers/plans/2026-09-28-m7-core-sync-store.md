# M7.2 Core Sync Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define an uncomposed, platform-independent `SyncStore` contract, conservative core transition policy, and a deterministic fake with state-matrix tests.

**Architecture:** Correct the existing `protocol → core` dependency by making core authoritative for shared sync domain types and letting protocol validate/return those types; core must never import protocol. Core owns the storage-independent port, request/result unions and transition invariants. The fake models conditional revisions and operation replay for contract tests, but is not an R2 implementation or qualification.

**Tech Stack:** Strict TypeScript, Zod 4 at the existing protocol boundary, Vitest, mise tasks.

**Spec:** `docs/milestones/m7-versioned-sync-protocol-and-r2-store.md` (M7.2 only; M7.1 is already implemented). M7 transition is merged in `main` at `745528e`; start from the M7.1 commit `a9d3d33` or its merged equivalent.

## Global Constraints

- Scope only M7.2. Do not compose Worker, R2, HTTP, MCP, OAuth, plugin, migration, v2 fallback, sync activation, or deployment.
- Preserve M7.1's public protocol exports and behavior, protocol major `1`, isolated namespace `sync/v1/vaults/<vault-id>/`, canonical UUIDv4 identities, 720-byte UTF-8 Markdown paths, 1 MiB content, 64 lanes, and 20-digit sequences. No v2 ETag/receipt as a sync revision.
- `packages/protocol` already depends on `packages/core`; never add a reverse runtime, type-only, or package dependency. Move shared semantic *type* authority to core; preserve validation/codecs and stable protocol runtime constants in protocol.
- A stale or uncertain state never refreshes a precondition, grants deletion, reports successful mutation, or proves absence. No storage cursor or ETag in core contracts.
- Keep production changes within 10 files and 1,500 net new production lines for this PR; stop and propose a split if exceeded. Every named production semantic declaration gets useful TSDoc.
- Tests outside `src/`; use `mise install`, `mise run install`, focused `mise run test -- <test-path>`, then `mise run check` and semantic review. Do not deploy or use personal data.

## Review Focus

1. A hostile caller passes a wrong-vault or role-swapped UUID: parsing must reject malformed values and role swapping must fail type checking (Tasks 1–2).
2. An operation ID is reused with a different payload, parent or vault: return `operation_id_reused` without changing a head (Task 3).
3. Two concurrent callers claim the same absent or exact revision: at most one successful transition; loser gets `stale_revision` (Task 3).
4. Tombstoning a never-seen path or after an uncertain/pending effect: no successful tombstone or inferred absence (Tasks 2–3).
5. Partial/expired inventory or invalid/foreign/future feed cursor: no empty-success page, complete handle, or deletion authority (Task 2 contract tests; operational enforcement belongs to M7.4).

---

## File map and scope boundary

- `packages/core/src/sync/sync.types.ts`: shared branded identities, path, fixed-width sequence, checkpoint, origin and content-free version/head/event domain values.
- `packages/core/src/sync/sync-store.types.ts`: closed inputs, outcomes, progress/failure results and complete inventory/evidence handles.
- `packages/core/src/sync/sync-store.port.ts`: nine typed asynchronous methods, no backend handles.
- `packages/core/src/sync/sync-mutation-policy.ts`: pure exact-parent, content-size/digest precondition and operation-replay policy; no persistence or transport.
- `packages/core/src/index.ts`: exports of core sync types, port and policy.
- `packages/protocol/src/sync.schemas.ts` and `packages/protocol/src/sync.types.ts`: adapt existing validators to the authoritative core types while preserving current exports and codec behavior. Keep `sync.constants.ts` and `sync.codec.ts` as the single runtime protocol source.
- `packages/core/tests/unit/sync-store-contract.test.ts`: type/shape, exhaustiveness and no-authority-from-partial-result assertions.
- `packages/core/tests/unit/sync-mutation-policy.test.ts`: state/evidence policy matrix.
- `packages/core/tests/unit/sync-store-fake.test.ts`: deterministic contract fake and concurrency/idempotency tests (fake lives in this test file, not production).
- `packages/protocol/tests/unit/sync.contracts.test.ts`: retained M7.1 tests plus compile-time assignability/brand regression checks.
- Update `docs/milestones/m7-versioned-sync-protocol-and-r2-store.md`, `docs/current-state.md`, `docs/architecture.md` only for actual M7.2 evidence/boundary changes; do not mark M7 complete.

### Task 1: Repair shared sync-type ownership without changing M7.1 behavior

**Files:** Create `packages/core/src/sync/sync.types.ts`; modify `packages/core/src/index.ts`, `packages/protocol/src/sync.schemas.ts`, `packages/protocol/src/sync.types.ts`; test `packages/protocol/tests/unit/sync.contracts.test.ts`.

**Interfaces:** Core exports `SyncVaultId`, `SyncDeviceId`, `SyncRevision`, `SyncOperationId`, `SyncInventoryId` as distinct branded strings; `SyncNotePath` as a branded subtype of `NotePath`; `SyncSequence` as a fixed-width branded string; `SyncCheckpoint` as `{ readonly protocolMajor: 1; readonly vaultId: SyncVaultId; readonly laneSequences: readonly SyncSequence[]; readonly nextLane: number }`. Preserve the names of existing protocol DTOs and public Zod schemas; `syncVaultIdSchema.parse(value)` must produce `SyncVaultId` (and analogously for the other roles). Zod input remains untrusted string; only a successful validator produces a brand. `SyncEventSequence` is a non-zero subtype of `SyncSequence`. Define core brands as readonly nominal string intersections; protocol's Zod adapters validate first, then transform to those types at this single documented trust boundary.

- [ ] **Step 1: Write failing protocol type checks.** Add compile-time assignment of parsed IDs, path, sequence and checkpoint to core types and `@ts-expect-error` for vault/device/revision role swaps and invalid result assignments; retain the 11 existing M7.1 runtime tests, add a test that schema outputs round-trip the existing codec.
- [ ] **Step 2: Run `mise run typecheck` and `mise run test -- packages/protocol/tests/unit/sync.contracts.test.ts`.** Expect the new core exports/types to fail type checking before implementation.
- [ ] **Step 3: Define core branded types; adapt protocol schemas and DTO aliases.** Reuse the existing validators (UUID regex, normalized path + 720 bytes, fixed 20 digits); make their outputs core-branded at the validated adapter boundary, not by unchecked casts in core. If Zod's branding forces a different inferred type, use an isolated post-validation transform in protocol, document its validation invariant, and keep existing schema names/codecs. Do not change package dependencies or introduce a second UUID/path policy.
- [ ] **Step 4: Run the same typecheck and focused tests.** Expect clean type checking and unchanged M7.1 observable behavior.
- [ ] **Step 5: Commit** with `refactor(protocol): share sync domain identities with core` (include only Task 1 files).

### Task 2: Specify the storage-independent port and conservative transition policy

**Files:** Create `packages/core/src/sync/sync-store.types.ts`, `packages/core/src/sync/sync-store.port.ts`, `packages/core/src/sync/sync-mutation-policy.ts`; modify `packages/core/src/sync/sync.types.ts`, `packages/core/src/index.ts`; test `packages/core/tests/unit/sync-store-contract.test.ts` and `packages/core/tests/unit/sync-mutation-policy.test.ts`.

**Interfaces:** Export `SyncStore` with exactly `readCurrent`, `mutate`, `readVersion`, `readRecovery`, `readChanges`, `startInventory`, `continueInventory`, `readInventoryPage`, `resumeOperation`; every input contains `vaultId: SyncVaultId`. `mutate(request: SyncMutationRequest): Promise<SyncMutationResult>` uses a closed create/update/tombstone union with `path: SyncNotePath`, `operationId: SyncOperationId`, new `revision: SyncRevision`, exact parent `{kind:'never_seen'} | {kind:'revision'; revision: SyncRevision}`, expected SHA-256 and typed origin; live requests also carry exact UTF-8 `content` and `mediaType: 'text/markdown'`. A successful result includes exact revision, operation ID and committed `{ lane: number; sequence: SyncEventSequence }`; never confuse a pending reservation with a committed position. `readCurrent` distinguishes never-seen/live/tombstone; `readVersion` and `readRecovery` distinguish present from absent using closed kinds; `readChanges` takes a vault-bound opaque checkpoint cursor and returns at most 100 metadata-only events and a continuation. Inventory start/continue return progress (`inventory_in_progress`, `inventoryId`, optional `retryAfterEpochMs`) or a complete handle (`vaultId`, `inventoryId`, vector, entryCount, chunkCount, root), never partial entries as completion; page input includes handle and opaque evidence cursor and returns bounded summaries with an explicit final marker only after verified count/root. `resumeOperation` takes vault + operation ID. Define input/result aliases `SyncReadCurrentInput`, `SyncReadCurrentResult`, `SyncMutationRequest`, `SyncMutationResult`, `SyncReadVersionInput`, `SyncReadVersionResult`, `SyncReadRecoveryInput`, `SyncReadRecoveryResult`, `SyncReadChangesInput`, `SyncReadChangesResult`, `SyncStartInventoryInput`, `SyncContinueInventoryInput`, `SyncInventoryResult`, `SyncReadInventoryPageInput`, `SyncReadInventoryPageResult`, `SyncResumeOperationInput`, and `SyncResumeOperationResult`. Every port method takes its corresponding input and returns `Promise` of its corresponding result; start/continue both return `SyncInventoryResult`. Closed failure union uses exactly the 16 M7 codes from the spec, with operation ID/inventory ID and retry time only in the states where the spec calls for them. Policy exports `evaluateSyncMutation(request: SyncMutationRequest, observed: SyncCurrentState, priorOperation: SyncOperationRecord | undefined, hashContent: (content: string) => Promise<ContentSha256>): Promise<SyncMutationDecision>` with decisions `proceed | already_committed | reject` and typed failure codes. `SyncOperationRecord` distinguishes pending from committed and binds the entire immutable request; a pending exact replay is pending, never committed. Equal-op replay compares the complete normalized request including content bytes before checking the current head. The injected digest hashes exact UTF-8 content; mismatched digest/size is rejected before any success decision. This pure policy does not claim to atomically commit multi-key data.

- [ ] **Step 1: Write failing port/result shape tests.** Use typed fixture implementations (`satisfies SyncStore`) and exhaustive switches: never-seen vs tombstone, complete handle vs progress, changed vs aborted event, error vs success; `@ts-expect-error` for R2 ETag/cursor leaking into core and for a successful response lacking committed position. Assert closed error codes against the M7.1 set in the protocol test; avoid importing protocol from core production.
- [ ] **Step 2: Run `mise run typecheck` and `mise run test -- packages/core/tests/unit/sync-store-contract.test.ts`.** Expect missing contracts.
- [ ] **Step 3: Implement the typed port and result unions.** Keep schemas/runtime protocol constants in protocol and avoid a duplicate runtime code list in core; a literal union in core is the type-level error authority, with a compile-time conformance check in protocol against its one runtime list. Specify documented validation preconditions at the port boundary; implement no adapter, route, cleanup, or actual feed/inventory traversal.
- [ ] **Step 4: Write failing mutation-policy matrix tests.** Create allowed only on never-seen; update/tombstone only on exact live or tombstone parent as specified by the request; reject stale revision or missing digest, changed payload under same operation ID, impossible tombstone without preserved parent, oversized live payload (>1 MiB), and preserve exact prior committed replay. Assert no mutation of the input objects and no success from pending/unknown evidence.
- [ ] **Step 5: Run `mise run test -- packages/core/tests/unit/sync-mutation-policy.test.ts`.** Expect policy failures.
- [ ] **Step 6: Implement pure policy with exhaustive union handling and no refresh-on-conflict.** Use the signature's injected digest capability over exact UTF-8 content and calculate UTF-8 byte length with `TextEncoder`; reject a mismatch before approving publication. Core need not import protocol or use host crypto directly. Do not mix M3 receipts or R2 metadata into the decision.
- [ ] **Step 7: Run focused tests and `mise run typecheck`.** Expect all contract and policy tests pass; no new production imports from protocol.
- [ ] **Step 8: Commit** with `feat(core): define versioned sync store contract and policy`.

### Task 3: Deterministic fake and state-matrix conformance evidence

**Files:** Test `packages/core/tests/unit/sync-store-fake.test.ts`; modify production only if Task 3 tests reveal a contract/policy defect. Update `docs/milestones/m7-versioned-sync-protocol-and-r2-store.md`, `docs/current-state.md`, `docs/architecture.md` for exact evidence.

**Interfaces:** Test-only `InMemorySyncStore implements SyncStore` consumes the Task 2 types/policy. Its per-vault operation map binds the entire exact request; its per-path head map simulates atomic compare-and-set with a deterministic serialized critical section; injected clock/hash/effect hooks simulate pending/unknown outcomes. Test-only feed/inventory methods return closed typed statuses without pretending to implement the M7.4 durable algorithm; tests must not present this fake as local workerd qualification.

- [ ] **Step 1: Write failing contract scenarios.** Use fixed UUIDv4 fixtures and synthetic Markdown: two simultaneous `mutate` calls on the same never-seen or revision parent yield exactly one success and one `stale_revision`; exact same-op retry yields the same committed position; changed request/op ID yields `operation_id_reused`; a stale tombstone cannot remove updated content; injected pending/unknown write cannot return success, advance feed or claim never-seen absence.
- [ ] **Step 2: Run `mise run test -- packages/core/tests/unit/sync-store-fake.test.ts`.** Expect fake scenarios to fail before its implementation.
- [ ] **Step 3: Implement the minimal test-only fake.** Clearly label its non-atomic multi-key/feed/inventory limitations; drive mutation decisions through Task 2 policy rather than duplicating the rules. Keep the core production port adapter-neutral.
- [ ] **Step 4: Run `mise run test -- packages/core/tests/unit/sync-store-fake.test.ts packages/core/tests/unit/sync-store-contract.test.ts packages/core/tests/unit/sync-mutation-policy.test.ts packages/protocol/tests/unit/sync.contracts.test.ts`.** Expect the full M7.1/M7.2 focused set to pass.
- [ ] **Step 5: Run `mise install`, `mise run install`, `mise run check`.** Expect formatting, lint/TSDoc, types, coverage, workerd regression and bundles pass. If the fake does not meaningfully exercise a port method, document that M7.3/M7.4 own its behavior rather than inserting false-positive assertions.
- [ ] **Step 6: Perform semantic/security review and record exact evidence.** Inspect package direction, branded-type proof at validation boundary, no unsafe casts, failure certainty, exact-byte idempotency, size/hash semantics, public TSDoc, scope/file count and no M1–M6 behavior change. Update docs with actual check results, explicitly marking M7.2 done *only when verified*, M7.3 next unit and M7 milestone still NEXT.
- [ ] **Step 7: Commit** with `test(core): qualify M7 sync store contract and fake` (include evidence docs); no deployment.

## Self-review boundary

This plan intentionally does not implement R2 CAS, operation-journal persistence, real feed pagination, 24-hour inventory progress, read-back, 1,100 ms write pacing, 400-subrequest accounting, 10 ms Workers Free CPU qualification or any public sync surface. M7.3/M7.4 own those semantics and tests. Before execution, check that the Task 2 type aliases and policy signature above fit existing TypeScript conventions; if implementing the promised contract would exceed the repository size gate, stop and split M7.2 rather than silently expanding it.
