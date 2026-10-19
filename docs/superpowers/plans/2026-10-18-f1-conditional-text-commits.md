# Conditional Text Commits Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Complete each task with a fresh implementer and reviewer. Steps use checkboxes.

**Goal:** Publish conditional inline text mutations and successful idempotency receipts in one authoritative SQLite transaction.

**Architecture:** The Vault retains authority over authorization, admission ownership, file conditions, and publication. A separate claim table links in-flight keys to existing admissions. Worker transport uses application contracts and a test-only identity entry.

**Tech Stack:** Bun, TypeScript, Zod, Hono, Cloudflare Durable Objects, Drizzle, Biome, and Vitest. Preserve all current dependency pins.

**Spec:** `docs/spec.md` sections 5, 6, 9.5, 10, 12, and AC-01/14/17/27/38. Backlog task: OAB-6.3.

## Global Constraints

- Use the existing isolated branch `feature/f1-conditional-text-commits`, based on `23e1058c4b0c55c539d605597883111a1142a0f6`.
- The owner selected subagent execution for this task. The parent owns validation, Backlog, acceptance, commits, and publication.
- Human plan approval precedes implementation, scaffolding, and dependency installation.
- Every mutation checks the exact observed revision. Absence never deletes. Obsolete revisions never overwrite.
- Preserve both versions through rejection and retained history. Do not implement automatic conflict merging.
- Paths use NFC, JavaScript lowercase keys, 512 UTF-8 bytes, and at most 32 segments.
- Inline text uses `.md` or `.canvas` and at most 1,000,000 bytes. Only live Markdown enters FTS.
- Hash raw bytes with SHA-256. Preserve valid UTF-8 bytes, including a BOM.
- Revisions increase per exact path across delete and recreate. Tombstones remain in `files`.
- Client-facing identities use quoted epoch/revision ETags. Do not expose bare revisions as replacement identities.
- UUIDv7 acceptance is inclusive: `[now - 25 days, now + 5 minutes]`.
- Opaque keys accept 8–128 characters without a timestamp window. Key identity remains exact and client-scoped.
- Existing final receipts precede the age test and old file conditions. Their retention remains 30 days.
- Admissions retain 16/client, 1,024/vault, original 60-second deadlines, eight ID candidates, and 64 global cleanup identifiers.
- SQLite limits are 100 parameters/query, 100 columns/table, and 2 MB/string, BLOB, or row.
- Keep Zod wire schemas in `packages/protocol`. Derive public types from those schemas.
- Drizzle owns relational DDL and generated artifacts. Keep FTS and SQLite PRAGMA operations at their existing infrastructure seams.
- Application code must not import Hono, Cloudflare SDKs, Drizzle, or native transaction types.
- Keep workspace aliases and published package exports. Do not add dependencies, SDK shims, or ambient type widening.
- Add useful semantic TSDoc for each named declaration, including private helpers, schemas, test helpers, and constructors.
- Use English, Simplified Technical English, Conventional Commits, and Biome.
- Do not access the personal vault, deploy, change Cloudflare resources, change git identity, or merge into main.

## Confirmed Owner Decisions

1. There are no clients or stores in use. Breaking storage changes are acceptable.
2. Use a separate in-flight table. Do not add legacy migrations or compatibility mechanisms.
3. Fresh storage uses application schema version 3. Unsupported stores fail without writes, repair, reset, or epoch replacement.
4. Historical `GET ?rev=R` needs `X-Vault-Epoch`. The numeric selector remains unchanged.
5. Keep subagent execution. Do not ask for that choice again.

The last two storage and read changes amend the corresponding task-owned contracts in `docs/spec.md`. They do not start another specification review.

## Review Focus

1. A delayed body survives DO eviction. The same client/key still returns `409 idempotency_in_progress` before body consumption. Task 2/4.
2. An expired owner completes after replacement. It cannot publish or release the replacement admission or claim. Task 2/3.
3. A retry follows a later edit or permission change. It returns the original receipt without stale-condition failure or content disclosure. Task 3/4.
4. UTF-8 BOMs, invalid bytes, NULs, and split surrogate ranges retain exact identity without oversized receipt rows. Task 1/3/4.
5. A matching tombstone has a live canonical alias. Recreation returns `409 path_collision`, not a SQL error or overwrite. Task 2/3.

---

## File and Contract Map

| Owner | Files | Responsibility |
| --- | --- | --- |
| Protocol | `packages/protocol/src/schemas/content.ts`, `idempotency.ts`, `files.ts` | Full-text bounds, key syntax, file DTOs, results, and implemented errors |
| Existing protocol | `schemas/admission.ts`, `types/admission.ts`, `src/index.ts` | Canonical collision evidence and read-authorized precondition content |
| Protocol types | `packages/protocol/src/types/files.ts`, `idempotency.ts` | Schema-derived public aliases |
| Pure application | `apps/worker/src/application/idempotency.ts`, `text-payload.ts` | UUID time policy and exact UTF-8 payload preparation |
| Existing admission | `apps/worker/src/infrastructure/sqlite/admission.ts` | Shared policy, caller-owned reservation, ticket validation, and exact settlement |
| SQLite coordinator | `apps/worker/src/infrastructure/sqlite/mutations.ts` | Key claims, receipt decisions, and one atomic publication boundary |
| Schema | Existing `schema-model.ts`, `schema.ts`, generated SQL/snapshot/module | Fresh v3 structure and rejection of unsupported stores |
| Inline storage | `apps/worker/src/infrastructure/sqlite/text-files.ts` | PUT, DELETE, selected revision reads, FTS, history, feed, and counters |
| Vault composition | `apps/worker/src/infrastructure/durable-object/vault.ts` | Wire the coordinator and text store, then delegate RPC methods |
| Application use case | `apps/worker/src/application/text-files.ts` | Small gateway contract and mutation lifecycle |
| HTTP transport | `apps/worker/src/transport/files.ts`, `transport/worker.ts`, existing `src/index.ts` | Parse HTTP, enforce Worker scopes, call application, and encode responses |
| Test composition | `apps/worker/test/fixtures/http-worker.ts`, `vitest.http.config.ts` | Fixture identity and real HTTP tests only |
| Test configuration | Existing `vitest.config.ts`, `package.json`, new `tooling/vitest-config.ts` | Share official SDK options and run both test entries |
| Specification | `docs/spec.md` | Record only the implemented schema and historical-read header amendments |

All SQLite paths in this document are under `apps/worker/src/infrastructure/sqlite/` unless qualified.

### Public DTO Decisions

Define these canonical Zod schemas and derive their TypeScript aliases:

- `IdempotencyKey`: exact opaque string, 8–128 Unicode code points. Do not trim, lowercase, or replace its bytes.
- A syntactically valid UUIDv7 key receives its 48-bit millisecond timestamp check. Other valid opaque keys receive no age check.
- UUID parsing accepts hexadecimal letter case without changing the key's stored spelling.
- `TextPayload`: `{ content: string, payload_hash: string, size: number }`. Full content must round-trip through UTF-8 without replacement.
- `TextMutationBeginResult`: existing successful admission lease or `{ ok: false, failure: FileFailure }`.
- `MutationSuccess`: `{ path, etag, seq, hash, size, deleted }`. It contains no note content or bare revision.
- `MutationReceipt`: `{ status: 200 | 201, body: MutationSuccess }`.
- `TextMutationResult`: `{ ok: true, response: MutationReceipt }` or `{ ok: false, failure: FileFailure }`.
- `TextReadRequest`: `{ path, epoch?, rev?, offset?, length? }`. A revision selector needs an epoch.
- `TextReadResponse`: `{ path, etag, hash, size, kind: "text", deleted, origin, updated_at, content, offset, length, truncated }`.
- Live reads contain a string. Tombstone reads contain `content: null`, empty hash, and zero size.
- Range content can contain a lone surrogate. Encode it as JSON, not raw UTF-8.
- `TextReadResult`: `{ ok: true, body: TextReadResponse }` or `{ ok: false, failure: FileFailure }`.
- `FileFailure` reuses admission failures and adds implemented file/idempotency errors. Its canonical precondition variant has optional full text.
- Only the authorized conflict projector supplies precondition content. A write-only failure never contains that field.
- HTTP errors use `{ error, message, ...details }`. Canonical protocol mapping owns their status and detail shapes.
- Map `invalid_request`/`invalid_path` to 400, `revoked` to 401, `forbidden_scope` to 403, and `not_found` to 404.
- Map `epoch_mismatch`, `path_collision`, `operation_expired`, `idempotency_in_progress`, and `invalid_ticket` to 409.
- Map `revision_pruned` to 410, `precondition_failed` to 412, size failures to 413, and `idempotency_mismatch` to 422.
- Map `admission_limited` to 429 with `Retry-After`, and `not_implemented` to 501.
- The HTTP schema also owns transport-only `unauthorized`/401 and `internal_error`/500. Do not serialize thrown exception details.

Use safe integers for revisions, sequences, times, byte sizes, and UTF-16 offsets. Use strict schemas for new closed DTOs. Do not define speculative append, rename, restore, or blob request DTOs.

### Claim Structure and Lifecycle

Add `mutation_claims` after `operation_admissions` in the Drizzle model:

| Column | Rule |
| --- | --- |
| `client_id` | Non-null text |
| `key` | Non-null text |
| `admission_id` | Non-null text, references `operation_admissions.id`, `ON DELETE CASCADE` |

Use composite primary key `(client_id, key)` and unique index `mutation_claims_admission` on `admission_id`.

The admission row already owns state, fingerprint, grant, epoch, and deadline. Do not duplicate these fields in the claim.

Enable and verify `PRAGMA foreign_keys = ON` before the bootstrap transaction. Fail before DDL if the native connection does not enforce it.

Native tests must prove cascade and rollback with the pinned runtime. Do not substitute an in-memory guard or silent fallback.

- A missing key uses ordinary admission without a claim or receipt.
- A new keyed request creates its claim and reservation in one transaction.
- A live joined admission yields `409 idempotency_in_progress`.
- Expired claims disappear through the existing bounded admission cleanup.
- Binding changes only the admission fingerprint and state. It preserves the ID and original deadline.
- Successful consumption removes the admission and claim in the publication transaction.
- Settled completion removes both. Uncertain completion retains both until the original deadline.
- Existing final receipts remain final. Retry-body admission must not replace their rows.
- Every public admission deletion path must preserve the same claim lifecycle.

The foreign key and unique owner index give `claims <= retained admissions <= 1,024`. Cleanup does not scan final receipts.

### Atomic Publication Order

1. Check current revocation, operation scope, and epoch through the existing policy owner.
2. Inspect the final client/key receipt before old file conditions or the UUID age test.
3. An equal fingerprint returns the stored compact success. A different fingerprint returns `422 idempotency_mismatch`.
4. Settle only a retry admission that matches its observed client, grant, full fingerprint, epoch, and ID.
5. Without a final receipt, verify the keyed claim's exact admission owner.
6. Consume the active ticket through the shared guard, including file conditions and canonical collision checks.
7. Call the selected infrastructure publisher synchronously with that same SDK transaction.
8. Validate and insert the compact success receipt, when a key exists.
9. Commit once. Any thrown publication failure rolls back content, counters, final receipt, admission consumption, and cascade deletion.

Do not return a final receipt from a descriptor fingerprint alone. The Worker must read and hash the actual bounded retry body.

A replay never consumes an unrelated admission. A late callback never removes a replacement claim.

## Task 1: Canonical File Contracts and Pure Policies

**Files:** Create the protocol and pure application files above. Change protocol exports and admission failure schemas. Add `packages/protocol/test/files.test.ts`, `idempotency.test.ts`, and `apps/worker/test/text-payload.test.ts`.

**Consumes:** Existing `AuthorizationContext`, `OperationDescriptor`, `OperationIntent`, path codecs, and ETag codecs.

**Produces:**
- Canonical DTOs listed above.
- `assertIdempotencyWindow(key: IdempotencyKey, now: number): void`.
- `prepareTextPayload(bytes: Uint8Array): Promise<TextPayload>`.
- `FileOperationDenied extends Error`, with `readonly failure: FileFailure`.
- Canonical HTTP failure encoding from `FileFailure`, including fixed safe messages.
- `TextMutationDescriptor` and `TextMutationIntent`: narrow the existing schemas to PUT/DELETE without changing their refinements.

- [ ] Add the smallest typed fail-closed shells where new exports block test execution. Record these as contract setup, not functional RED.
- [ ] Write policy tests with a fixed clock and UUIDv7 timestamp fixtures.
  - Assert 26-day-old and 10-minute-future keys return `operation_expired`.
  - Assert four-minute-future and both exact window endpoints succeed.
  - Assert opaque keys have no timestamp window and preserve exact spelling.
  - Assert short, long, and invalid DTO combinations fail without normalization.
- [ ] Write payload tests for ASCII, non-ASCII, BOM, NUL, empty bytes, invalid UTF-8, and the exact 1,000,000-byte boundary.
  - Assert hash and size use original bytes.
  - Assert invalid UTF-8 yields `invalid_request` without replacement.
  - Assert oversized inline payloads yield `text_too_large`.
  - Assert read-range schemas retain a split surrogate through JSON serialization.
- [ ] Run focused tests and preserve reached behavioral assertions as functional RED.
  - Run: `cd packages/protocol && bun run test`.
  - Run: `cd apps/worker && bunx vitest run test/text-payload.test.ts`.
- [ ] Implement the pure functions and schema-derived types.
  - Decode with `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`.
  - Verify decode/re-encode identity before accepting full text.
  - Keep full-note validation distinct from range-fragment validation.
- [ ] Run focused tests, documentation checks, and `bun run check`. Record actual test counts.
- [ ] Get fresh task review. Address findings and rerun affected checks.
- [ ] Parent stages and commits: `feat: add canonical text mutation contracts`.

## Task 2: Durable Claims and the Atomic Mutation Coordinator

**Files:** Change schema model, bootstrap, admission authority, and generated artifacts. Create `sqlite/mutations.ts`, `test/vault-mutation-claims.test.ts`, and frozen `test/fixtures/schema-v2.ts`.

**Consumes:** Task 1 contracts and existing admission guards.

**Produces:**
- Export the existing SDK-inferred `VaultTransaction` type from the admission infrastructure owner.
- Rename/export the existing free policy function as `assertPolicyInTransaction(tx, context, operation): string`.
- `SqliteAdmissionAuthority.reserveInTransaction(tx: VaultTransaction, context: AuthorizationContext, prepared: PreparedDescriptor): RequestAdmissionResult`.
- `SqliteAdmissionAuthority.settleMatchingInTransaction(tx: VaultTransaction, context: AuthorizationContext, operation: PreparedOperation, ticketId: string): void`.
- `SqliteMutationCoordinator(storage, admissions, ports: { now: () => number })`.
- `coordinator.beginMutation(context: AuthorizationContext, descriptor: OperationDescriptor, key?: IdempotencyKey): Promise<TextMutationBeginResult>`.
- `coordinator.commit(context: AuthorizationContext, operation: PreparedOperation, ticketId: string, key: IdempotencyKey | undefined, publish: (tx: VaultTransaction) => MutationReceipt): TextMutationResult`.

Reservation still owns its policy checks, clock, limits, entropy bounds, and denial ordering. Public `reserve` delegates after preparation.

Settlement deletes only a fully matching observed row. Missing or unrelated rows remain unchanged during receipt replay.

The coordinator exposes no publisher callback through RPC. Trusted infrastructure selects that callback.

Catch file-condition denials only around the guard, before the publisher runs. Project authorized conflict content in that transaction, then settle exact owned work.

Never convert a publisher exception into a normal return inside its transaction. A typed publisher denial after a write must also roll back.

- [ ] Freeze the exact current v2 schema fixture before generation. Keep the existing v1 fixture unchanged.
- [ ] Add typed fail-closed coordinator shells before behavioral tests. Do not count missing methods or table setup errors as functional RED.
- [ ] Write native bootstrap tests: fresh version 3, repeat initialization, v1/v2 rejection, malformed catalogs, and unchanged unsupported storage.
- [ ] Complete the bootstrap RED/GREEN cycle before the claim lifecycle cycle. Do not count missing-table failures as claim behavior evidence.
- [ ] Write native claim tests that reach actual coordinator results.
  - New key creates one reservation and claim. Unkeyed work creates no claim.
  - Same client/key returns `idempotency_in_progress`. Another client can use that key.
  - Binding retains original deadline. Exact expiry rejects consumption.
  - Expiry cleanup, settled finish, uncertain finish, and successful consumption preserve claim ownership.
  - Eviction retains the claim. Old completion cannot release its replacement.
  - Saturation and three expiry/refill cycles preserve both admission and claim bounds.
  - Invalid foreign-key insertion fails. Cascade removal and thrown-transaction rollback preserve referential state.
- [ ] Write native coordinator tests with a small test-owned SQL publication callback.
  - Prove one callback and receipt for replay, and no callback for mismatched fingerprint.
  - Prove an existing receipt bypasses age and stale file conditions after current authorization.
  - Seed a corrupt final receipt and misbound claim. Assert rejection without repair or deletion.
  - Prove revoked and missing-scope requests cannot inspect or replay a seeded receipt.
  - Prove unrelated retry ticket IDs do not settle another operation.
  - Force callback and receipt-insert failures. Compare metadata, receipts, admissions, and claims.
  - Throw a typed denial after a callback write. Assert rollback, not a committed failure result.
- [ ] Extend the shared file guard for `path_collision` with `existing_path`.
  - Same exact live path with create-only remains `precondition_failed`.
  - A different live canonical path returns `path_collision`.
  - A valid match against a tombstone still checks live canonical aliases before resurrection.
  - Preserve existing metadata-only admission responses.
- [ ] Run focused native tests and preserve actual behavioral RED. Run type and documentation checks separately.
- [ ] Implement the caller-owned reservation seam, coordinator, schema version 3, and foreign-key connection setup.
  - Use one transaction for reservation plus claim.
  - Use existing admission cleanup and cascade removal. Add no independent claim expiry state or cleanup loop.
  - Decode final receipt rows with canonical schemas. Corrupt records fail without repair or deletion.
  - Do not persist failed responses or temporary states in `receipts`.
- [ ] Regenerate one fresh initial Drizzle artifact and runtime module after the frozen v2 fixture exists.
  - From `apps/worker`, remove only `drizzle/0000_*.sql`, `drizzle/meta/0000_snapshot.json`, and `drizzle/meta/_journal.json`.
  - Run `bun run db:generate`. Review the new initial SQL, snapshot, journal, and runtime module.
  - Preserve the one-initial-artifact contract in `tooling/generate-runtime-schema.ts`.
  - Do not append an upgrade chain or add runtime migration branches.
- [ ] Amend only the implemented schema version/table contract in `docs/spec.md`.
- [ ] Run existing admission regressions, focused claim tests, schema drift checks, and `bun run check`.
- [ ] Get fresh task review. Parent verifies invariants and commits: `feat: coordinate durable mutation claims and receipts`.

## Task 3: Conditional Inline Storage and Exact Reads

**Files:** Create `sqlite/text-files.ts`, `test/vault-text-files.test.ts`, and reusable helpers in `test/fixtures/text-files.ts`. Change Vault composition and related canonical DTOs only when tests expose a real contract gap.

**Consumes:** Task 1 payload preparation and Task 2 coordinator/transaction guards.

**Produces:**
- `SqliteTextStore(storage, coordinator, ports: { now: () => number })`.
- `store.commitText(context: AuthorizationContext, intent: TextMutationIntent, ticketId: string, content: string | undefined, key?: IdempotencyKey): Promise<TextMutationResult>`.
- `store.readText(context: AuthorizationContext, request: TextReadRequest): Promise<TextReadResult>`.
- Vault RPC delegates named `beginMutation`, `commitText`, and `readText`, with the same signatures.
- Existing Vault `authorize` and `finishAdmission` remain the shared lifecycle methods.

Reject operations other than PUT/DELETE at the text RPC boundary. PUT supplies full text. DELETE supplies no text and uses the canonical empty payload hash and zero size.

The DO recomputes payload identity before the publication transaction. It must not trust caller-supplied hash, size, or string alone.

- [ ] Add typed fail-closed methods before tests. Record setup failures separately.
- [ ] Write direct native PUT/update/DELETE/recreate tests with real tickets and claims.
  - Assert revisions 1, 2, 3, 4 across create, update, delete, and recreate.
  - Assert one feed entry, history row, and head advance per successful mutation.
  - Assert live count transitions 0→1→1→0→1 and correct origin/timestamps.
  - Assert tombstone bytes are absent and historical bytes remain exact.
  - Assert Markdown FTS insertion, update, and deletion. Canvas remains inline and unindexed.
  - Assert stale ETags, stale epochs, alias collisions, and matching-tombstone collisions preserve all content.
- [ ] Write AC-01/17/27/38 cases against actual publication.
  - Lose a response, make a later edit, then retry original key and bytes.
  - Assert original status/body, one original revision, and no repeated feed effect.
  - Assert changed payload returns `422`. Separate clients get independent receipts.
  - Assert read-authorized `412` contains current inline content and coherent metadata.
  - Assert write-only `412` omits content entirely.
  - Assert successful receipt bodies remain compact with a 1 MB NUL payload.
- [ ] Write current and selected historical read tests.
  - Historical reads need epoch, return exact selected bytes/ETag, and never substitute current content.
  - Missing selected history returns `revision_pruned`.
  - Current tombstones return metadata and `content: null`. Missing paths return `not_found`.
  - Check BOM, non-ASCII, zero-length ranges, ranges beyond the end, and split surrogate pairs.
  - Offsets and lengths use nonnegative safe UTF-16 integers. Clamp length to the selected string.
  - Return an empty slice beyond the end. Set `truncated` when the slice does not contain the whole text.
- [ ] Inject native SQL failures after history, file, feed, FTS, receipt, and counter writes.
  - Compare files, revisions, changes, FTS, counters, and final receipts with their pre-transaction snapshots.
  - Assert rollback restores admission and claim ownership.
  - Keep uncertain work charged. Do not infer settlement from a network exception.
- [ ] Run focused tests and preserve reached behavioral RED.
- [ ] Implement synchronous publication helpers inside the coordinator's transaction.
  - Never delete the persistent `files` tombstone.
  - Derive the next exact-path revision from its current live or tombstone row.
  - Insert the change and use its returned safe sequence for file and head metadata.
  - Reject unsafe counter, revision, or sequence growth before successful publication.
  - Keep FTS SQL parameterized and inside the same transaction.
  - Select precondition metadata and optional authorized content from one coherent snapshot.
- [ ] Keep this task inside the inline subset. Blob paths fail closed without simulated R2 writes.
  - Use `not_implemented` for the private unsupported-blob boundary.
  - Inline payload overflow returns `text_too_large`.
  - OAB-6.5 owns final large-file dispatch and AC-16/28.
- [ ] Run focused native tests and `bun run check`. Record statement counts, largest row sizes, and observed database growth.
- [ ] Get fresh task review. Parent commits: `feat: publish conditional inline text atomically`.

## Task 4: Real HTTP Composition and Lifecycle Tests

**Files:** Create application use case, transport modules, test-only Worker entry, HTTP config, shared test-config helper, and `test/http/files.test.ts`. Change production entry, native test configuration, Worker test script, and `test/entry.test.ts`.

**Consumes:** Earlier DTOs and Vault RPC operations.

**Produces:**
- `TextVaultGateway`: `beginMutation`, `authorize`, `commitText`, `finishAdmission`, and `readText`, with earlier DTO signatures.
- Gateway methods return promises. Only the composition layer consumes the official `DurableObjectStub<Vault>`.
- `executeTextMutation(gateway: TextVaultGateway, context: AuthorizationContext, descriptor: TextMutationDescriptor, key: IdempotencyKey | undefined, readPayload: () => Promise<TextPayload>): Promise<TextMutationResult>`.
- `createWorker(resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>, resolveVault: (env: Env, request: Request) => TextVaultGateway): Hono<{ Bindings: Env }>`.
- `createWorkerTestConfig(main: string, include: string[], exclude: string[]): UserConfig`, in host-only tooling.

DELETE uses the same lifecycle without reading a body. Capture validated context and request metadata before asynchronous work.

- [ ] Add the test entry and fail-closed application/router shells. Do not count missing imports or SDK setup errors as functional RED.
- [ ] Share official `cloudflareTest({ main, wrangler: { configPath } })` configuration.
  - Native tests use `src/index.ts` and exclude `test/http/**`.
  - HTTP tests use `test/fixtures/http-worker.ts` and include only `test/http/**/*.test.ts`.
  - Worker `test` runs both configurations.
  - Preserve aliases, `fsModuleCache: false`, existing pins, and official SDK declarations.
- [ ] Write HTTP positive controls through the real test entry and VAULTS binding.
  - Create, read, update, delete, recreate, and read exact history.
  - Seed read-only cases through the accepted native fixture, not a failing HTTP setup.
  - Assert actual statuses, ETag headers, JSON metadata, payload identity, and native effects.
  - Include valid identity without scope, revoked grant, old epoch, stale ETag, and canonical collision.
- [ ] Write slow-body and replay cases.
  - Hold body delivery and inspect the durable reservation before supplying bytes.
  - Send a duplicate through another request/stub. Assert `409` without reading its body.
  - Evict the actor during that delay. Assert the same durable duplicate behavior.
  - Test body failure, cancellation, expiry, and late completion without replacement release.
  - Intercept a committed response loss, then retry through HTTP with original bytes and key.
- [ ] Write transport rejection and production-denial controls.
  - Reject malformed paths, malformed/repeated selectors, conflicting conditions, and unexpected DELETE bodies.
  - Missing or invalid observed epochs return `epoch_mismatch`, not a guessed epoch.
  - PUT needs exactly one conditional header plus epoch. DELETE derives epoch from its ETag.
  - Historical GET needs `X-Vault-Epoch`. Current GET accepts an optional observed epoch.
  - Reject excessive actual bytes despite missing or false `Content-Length`.
  - Verify production denies forged test headers and raw identity data before body or DO access.
  - Registered production file routes return `401`. Unimplemented and unknown routes retain `404`.
- [ ] Run both entries. Preserve actual HTTP assertion failures as RED, not fixture or connection failures.
- [ ] Implement application lifecycle and transport.
  - Worker checks the operation scope before body processing. DO checks authoritative policy again.
  - Reserve before body consumption. Hash actual bytes, bind through `authorize`, then commit through the real RPC method.
  - Use a byte-counted reader with a 1,000,000-byte ceiling. Do not use an unbounded `request.text()`.
  - Do not add internal retries or a text payload-hash header.
  - Confirmed results let the application settle exact owned work. Unknown RPC outcomes use `uncertain` and retain the original deadline.
  - Production injects a resolver that always denies. It imports no fixture and exposes no test environment bypass.
  - The test entry injects fixed test identities and test vault selection only.
- [ ] Amend only the historical-read header contract in `docs/spec.md`. Keep future API documentation outside handlers.
- [ ] Run focused HTTP/native tests, `bun run check`, source import checks, and production bundle inspection.
  - Verify the production bundle contains no fixture identity header, resolver, or test entry.
- [ ] Get fresh task review. Parent commits: `feat: connect text operations through the Worker HTTP boundary`.

## Parent Execution and Validation Gates

- [ ] Get human approval in Plannotator. Keep all task criteria unchecked until final verification.
- [ ] After approval, run `bun install --frozen-lockfile` and a fresh `bun run check` before contract scaffolding or behavioral RED.
- [ ] Preserve baseline output. Do not present the previous task's 369 tests as this worktree's measured baseline.
- [ ] Use a fresh planned implementer at `openai/gpt-6-luna:medium` and a fresh task reviewer at `openai/gpt-6-luna:high`.
- [ ] Parent verifies complete reports, reached RED assertions, actual GREEN counts, semantic documentation, and unaffected files.
- [ ] Stop after a launch or runtime failure. Do not silently replace the execution route or agent process.
- [ ] Run final `bun run check`, Backlog doctor, schema drift checks, and `git diff --check`.
- [ ] Use active LSP probes for changed files. Report absent or inconclusive coverage honestly.
- [ ] Get whole-branch code and design review at `openai/gpt-6.1-sol:medium`.
- [ ] Open human branch review against main. Address every annotation before publication.
- [ ] Read Backlog finalization guidance, verify all four criteria, and close through the CLI.
- [ ] Push normally and create an English Conventional Commit-style PR. Verify hosted checks, archive private evidence, and remove only the clean published worktree.
- [ ] Do not merge locally or delete unpushed commits.

## Resource Evidence and Phase Boundaries

| Resource | Current implementation obligation | Evidence boundary |
| --- | --- | --- |
| Claims | At most one per admission, indexed by owner and client/key | Native saturation, expiry, finish, cascade, rollback, and eviction tests |
| Claim cleanup | Existing admission cleanup plus cascade | No final-receipt scan or independent expiry loop |
| SQL | At most 100 parameters/query. No await inside transactions | Inspect actual generated statements and count calls |
| Inline rows | At most 1,000,000 content bytes plus bounded metadata | Measure maximum file and revision rows |
| Receipts | Compact successful metadata only | Assert encoded row size below 16,384 bytes |
| Read JSON | Content can expand to about six times its byte size | Measure worst-case serialization. Do not claim a 1 MB wire response |
| Buffers | Bounded raw input plus decoded text, hash input, RPC copies, and JSON | Record copies and measured workloads, not full shared-isolate safety |
| Storage | Product envelope 2 GB. Free 1 GB, Paid 10 GB | Account tier remains unverified. Do not deploy |
| Historical admission growth | Historical growth 9.12890625 MiB, target 32 MiB | Not a content, FTS, receipt, or whole-capacity qualification |

Existing OAB-6.4 owns append, rename, and restore algorithms. Its publishers reuse the coordinator and admission policy.

OAB-6.5 owns real R2, large-file dispatch, streaming memory, and AC-28. OAB-6.6 owns listing/feed/history endpoints and complete read lifetimes.

OAB-6.8 owns retention, aggregate concurrency/memory, full capacity, and cumulative revocation growth before public OAB-7 authentication.

Do not claim those later tasks pass here. If a new concern lacks an existing owner and trigger, create a deferred Backlog task through the CLI.

## Plan Self-Review

- Scope maps to all four OAB-6.3 criteria. No plugin, OAuth, backup, blob, or more mutation algorithm enters this branch.
- The owner approved breaking storage changes and the historical-read header. No legacy migration remains.
- Every task names its input/output contracts and a functional test cycle.
- Setup, missing methods, missing tables, and compiler failures do not count as behavioral RED.
- The five review-focus risks map to native and HTTP tests.
- This document is a plan, not test evidence or implementation approval.
