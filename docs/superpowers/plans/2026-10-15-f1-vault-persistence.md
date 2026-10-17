# F1 Vault Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method is not selected yet; human approval is required before implementation.

**Goal:** Deliver OAB-6.1: the actual SQLite-backed Vault authority, with persistent identity and real runtime tests, while leaving the public Worker default-deny.

**Architecture:** Keep `src/index.ts` as composition/export wiring. Put the Durable Object lifecycle and SQLite bootstrap under Worker infrastructure; reuse the public protocol epoch schema instead of redefining wire contracts. No application layer, repository abstraction or public operation is needed until an actual operation consumes it.

**Tech Stack:** Existing Bun workspaces, TypeScript, Hono, Cloudflare SQLite Durable Objects, Vitest 5.0.4 / Cloudflare Vitest plugin 1.4.0, Wrangler 4.45.0. No dependency or toolchain update.

**Spec:** `docs/spec.md` §§4–5, 10, 12, 14–17; `AGENTS.md`; Backlog OAB-6 / OAB-6.1. Start from merged `43fc8bd8437f7df0efeed2aa9a96e65b7881e1ea`.

## Global Constraints

- Every mutation is conditional on the exact observed revision; absence never deletes; obsolete revisions never overwrite; collisions preserve both versions. This slice does not implement content mutations.
- The vault epoch is a random 128-bit generation id represented by 32 hexadecimal characters; reuse canonical `EpochSchema`, including its existing requirement for at least one hexadecimal letter.
- Copy the eleven declared §5.2 tables and their indexes, including `tokenize = 'trigram case_sensitive 0 remove_diacritics 1'`. Preserve export-pin/blob-reference seams without implementing backup, GC or another Deferred feature.
- Existing `@worker/*` imports are workspace-local; consume protocol only through `@obsidian-ai-bridge/protocol`. Keep source/tooling platform isolation intact.
- No personal vault, deployment, remote migration, bucket creation, Cloudflare mutation, credential change or dependency addition. Local Miniflare tests and Wrangler **dry-run** are the only runtime actions authorized here.
- No `/v1`, OAuth, MCP, plugin behavior, public debug route, token bypass, alarm or export workflow in this slice. Existing Worker responses remain unchanged.
- Evidence is executable tests against the real product class, not a disposable prototype or a native/Bun SQLite substitute. No F1 product acceptance case is closed by this plan alone.

## Review Focus

1. Eviction immediately after initialization: metadata and fixture rows survive; no fresh epoch is minted.
2. Corrupt or newer schema metadata: fail closed, never erase or silently recreate authoritative state.
3. Entropy that produces an all-numeric hex string: resample against the canonical schema rather than force a letter or use UUIDv4's reduced random bits.
4. A failure halfway through initialization: schema/metadata changes roll back together; the next clean initialization succeeds.
5. The installed runtime differs from generic SQLite: prove the exact FTS tokenizer, diacritic behavior and 1,000,000-byte text row locally; do not swap engines or weaken the contract on failure.

## F1 decomposition, not nine pre-approved implementation plans

Backlog owns scheduling and progress. These new subtasks remain **To Do**, with all criteria unchecked:

| Task | Independently reviewable outcome | Prerequisites |
| --- | --- | --- |
| OAB-6.1 | Persistent real SQLite Vault; this plan | Existing satisfied F0 entry gates via OAB-6 |
| OAB-6.2 | Authoritative authorization, revocation, tickets and recoverable admission | 6.1 |
| OAB-6.3 | Conditional text PUT/delete, exact reads and atomic receipts | 6.2 |
| OAB-6.4 | Rename, append, history and conditional restore | 6.3 |
| OAB-6.5 | Verified declared-integrity blob publication and range reads | 6.3 |
| OAB-6.6 | Bounded vault/manifest/feed read surfaces | 6.4, 6.5 |
| OAB-6.7 | Literal live-Markdown search | 6.4, 6.5 |
| OAB-6.8 | Retention, capacity and aggregate resource/admission limits | 6.6, 6.7 |
| OAB-6.9 | Executable F1 acceptance evidence and honest server/client qualification | 6.8 |

Later subtasks get researched plans when selected; this document does not authorize executing them. Each implementation slice gets its own failing-test cycle, full checks, semantic review, human diff review and focused PR. Security and limits necessary for an earlier slice must not be postponed just because final aggregate verification is 6.8.

**Owner-approved contract direction:** blob PUT will declare SHA-256 and byte size, verified by the server. OAB-6.5 owns the canonical schemas, exact headers/errors, useful API documentation and bounded amendment of spec §§5.3/6.1/6.3. No checksum header or spec change is implemented in OAB-6.1.

**Qualification boundary:** F1 lists scenarios containing plugin effects, including base advancement and stale-feed no-ops. OAB-6.9 must distinguish actual server evidence from client portions and obtain explicit approval for any necessary phase-gate interpretation before OAB-6 closes. This plan does not silently weaken §14 or qualify Obsidian behavior with a simulated client.

## Platform facts and scoped feasibility

Primary documentation retrieved during research on 2026-10-15; the accepted tier is **Workers Paid**, not Free:

- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): FTS5 support; `transactionSync` is synchronous and rolls back on throw. Do not issue raw SQL `BEGIN`/`SAVEPOINT` or return a Promise from its callback.
- [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/): 10 GB physical per-object limit; 2 MB string/BLOB/row; 100 KB SQL statement; 100 bound parameters per query. Product limits remain the stricter §12 envelope.
- [Worker limits](https://developers.cloudflare.com/workers/platform/limits/): 128 MB **per isolate**, shared by concurrent requests; default CPU budget 30 seconds; six simultaneous pending outbound connections per invocation.
- [R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): key is supplied before consuming a `ReadableStream`; a known SHA-256 can be checked by the binding. This motivates the owner's future 6.5 contract choice, not new work here.

| First-slice operation | Bound / verification | Platform headroom or limit behavior |
| --- | --- | --- |
| Fresh bootstrap | One synchronous transaction, eleven declared tables plus SQLite-owned FTS internals, small metadata and two explicit file indexes | SQL text must remain below 8 KiB, leaving over 92 KiB below the 100 KB statement limit; no network calls |
| Metadata queries | Explicit small keys; at most 16 bindings per statement | At least 84 spare parameters; no SQL built from a path or note body |
| Epoch allocation | 16 random bytes per attempt, at most eight attempts | At most 128 random bytes; exhaust/invalid RNG fails closed, never substitutes predictable identity |
| Storage boundary test | One text row containing exactly 1,000,000 UTF-8 bytes plus bounded §5 metadata | Below the 2 MB row limit; prove with the installed real DO, not just this estimate |
| Repeat initialization | Read metadata/schema inventory; no schema reset or content rewrite | Runtime/time must be observed in tests; no claim of measured CPU or peak heap yet |
| HTTP behavior | Existing six entry tests; no new route or outbound request | No upload, response materialization or concurrency budget introduced by this slice |

This is an author feasibility assessment, **not an independent review or whole-F1 approval**. Current primary docs support the chosen APIs; exact installed-runtime behavior is an executable entry gate in the task below. If tokenizer support, schema limits or SDK compatibility fail, stop and record the concrete finding against code/spec in Backlog; do not start another spec-only review round or quietly change the tokenizer/toolchain.

## File responsibilities

Create:
- `apps/worker/src/env.ts`: the actual `VAULTS: DurableObjectNamespace` binding type and the necessary Cloudflare environment augmentation. Platform types stay in Worker code, not protocol.
- `apps/worker/src/infrastructure/sqlite/schema.ts`: frozen DDL, schema version, canonical epoch generation and atomic initialization/validation.
- `apps/worker/src/infrastructure/durable-object/vault.ts`: `Vault` lifecycle class extending the native `DurableObject`; invokes SQLite initialization synchronously in its constructor. No public application operations or debug methods.
- `apps/worker/test/vault-storage.test.ts`: actual binding/bootstrap/eviction/isolation/schema/transaction/FTS tests; synthetic test-owned rows only.

Modify:
- `apps/worker/src/index.ts`: export `Vault` while preserving the existing Hono default export and its empty router.
- `apps/worker/wrangler.jsonc`: local-discoverable `VAULTS` binding, class `Vault`, migration tag `v1` using `new_sqlite_classes: ["Vault"]`. Adding configuration does not authorize deployment.

Preserve the current Vitest plugin, aliases and `fsModuleCache: false`; it already reads Wrangler configuration. Do not duplicate the binding in a second test configuration. No protocol shape or package manifest change is needed.

## Task 1: Persistent Vault authority — OAB-6.1

**Interfaces**
- Consumes native `DurableObject`, `DurableObjectStorage`, `SqlStorage`, and published `EpochSchema`.
- Produces `Vault` as the named Worker export and `VAULTS` as the Wrangler binding.
- `schema.ts` exports `SCHEMA_VERSION = 1`, the §5.2 DDL, `generateEpoch(fillRandom: (bytes: Uint8Array) => Uint8Array): string`, and `initializeVaultStorage(storage: DurableObjectStorage, createEpoch: () => string, now: () => number): void`.
- Constructor supplies `crypto.getRandomValues` through a bound wrapper and `Date.now`. Test dependency injection is confined to those real bootstrap inputs, not runtime fault switches.
- Initial metadata: `schema_version="1"`, canonical `epoch`, `head_seq="0"`, integer-millisecond `created_at`, `live_file_count="0"`. Do not invent zero physical-storage measurements; later capacity work owns actual accounting.
- Healthy version 1 initialization preserves identity, timestamps and all rows. A partial known schema, malformed metadata, missing required table/index or unsupported version fails closed. Never repair by deleting tables, mint a replacement epoch for an existing vault, or use `INSERT OR REPLACE` on authoritative metadata.

- [ ] **Step 1: Write failing real-runtime tests before production changes.**
  Import `env` from `cloudflare:workers` and `runInDurableObject` / `evictDurableObject` from `cloudflare:test`; these helpers exist in the installed plugin. Begin with a runtime assertion that `VAULTS` exists before dereferencing it, so the initial RED is an assertion, not an import/parser error. Do not import a nonexistent source module to manufacture RED.

  Add named tests with these assertions:
  - `initializes the frozen schema and canonical metadata`: all eleven declared tables and both explicit indexes exist; version 1, epoch passes `EpochSchema`, head/count are zero, creation time is a safe integer; DDL is at most 8 KiB.
  - `preserves identity and data after eviction`: seed one fixture revision and tombstone with real SQL, capture epoch/time, evict, inspect again; same identity/time/rows, no reset.
  - `isolates distinct Vault ids`: two new unique ids have different canonical epochs and cannot see each other's fixture rows.
  - `rolls back failed bootstrap`: on a unique synthetic DO only, clear the declared application tables inside the runtime test fixture; call the real initializer with an epoch factory that throws after DDL starts. No partial application schema/metadata survives; a subsequent valid initialization succeeds. Test cleanup uses real SQL and never enters production code.
  - `rejects corrupt or unsupported schema without changing data`: set version to a newer value, or remove a required field/index; initializer throws and existing fixture content/epoch are unchanged.
  - `resamples numeric-only epochs and fails closed on exhausted entropy`: deterministic injected fills first produce numeric-only hex, then valid bytes; canonical result comes from the valid sample. Eight invalid samples throw rather than forcing a letter. This focused helper test runs alongside actual-storage tests, not instead of them.
  - `supports exact trigram diacritics and inline row size`: real FTS table matches `cafe` to `café`, literal quoted `AND` and punctuation; a real `files` row stores and reads exactly 1,000,000 UTF-8 bytes. Assert SQLite rollback leaves no fixture effects after an injected transactional throw.

- [ ] **Step 2: Run the focused tests and confirm valid RED.**
  Run from the repository root through `bg_run`:
  `bun run --cwd apps/worker test -- test/vault-storage.test.ts`
  Expected: explicit missing-`VAULTS` assertions with the existing default-deny tests unaffected. Parser/config/type-loader errors are harness failures, not accepted RED. Record actual output in OAB-6.1 when it is activated.

- [ ] **Step 3: Add the smallest real implementation and wiring.**
  Copy §5.2 DDL into `schema.ts`; initialize/validate it and metadata using `storage.transactionSync` with no asynchronous work inside the callback. All eleven declared tables are actual product schema, not empty architecture layers. Keep existing vault data immutable during repeat initialization and use canonical epoch validation with bounded CSPRNG resampling.

  Add `Vault`, binding types, named export and SQLite migration declaration in the files above. Keep `src/index.ts` wiring-only and leave its default router unchanged. Use actual SDK types; if an API is unavailable, report it instead of declaring a pretend platform implementation or upgrading dependencies silently.

- [ ] **Step 4: Verify focused GREEN and the complete unchanged foundation.**
  Through `bg_run`, run the focused command, then `WRANGLER_SEND_METRICS=false bun run check`, `backlog doctor`, and `git diff --check`.
  Expected: all new tests and all 49 existing cases pass; native configured typechecks and local builds pass; Worker dry-run discovers the local binding without uploading or applying migrations. Inspect actual dry-run output and stop on resource/auth prompts. Existing Worker test files are runtime-transformed, not currently included in the source-only TypeScript project; do not falsely call their compiler coverage complete or suppress editor findings.

- [ ] **Step 5: Review, human gate and focused publication.**
  Run the code-review skill over source, tests, executable config and documentation. Recheck all five Review Focus cases and exact F0 boundary controls. Open the branch diff against remote `main` in Plannotator and address annotations before publication.

  After objective acceptance, finalize **only OAB-6.1** via Backlog CLI, commit with Conventional Commits, verify the final head, publish an English focused PR and inspect actual CI. Keep OAB-6 open; do not mark any full F1 or client acceptance case passed. Commit only explicitly owned files and the reviewed decomposition/plan metadata; preserve all existing Deferred tasks and phase dependencies.

## Approval and next selection

Approval covers this first persistence slice, not automatic execution of 6.2–6.9 or Cloudflare actions. After review, choose **native** execution (this session implements the task, then a fresh whole-branch review) or **subagent-driven** execution (fresh implementer and task reviewers). For this single tightly coupled bootstrap task, native execution is my recommendation to avoid repeating context across several orchestration gates; data-safety review remains mandatory.

Self-review: the file/interface names agree, all five Review Focus conditions have tests, every OAB-6.1 criterion is assigned, and unrelated F1 work stays in intent-only tasks. No passing runtime or baseline result is claimed merely by writing this plan.
