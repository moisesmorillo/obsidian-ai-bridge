# Authorization and Durable Tickets Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement each task. Track steps with checkboxes.

**Goal:** Enforce authoritative authorization, single-use tickets, and durable client admission without public authentication shortcuts.

**Architecture:** Drizzle owns an explicit admission table. Pure application rules define permissions and fingerprints. Infrastructure owns atomic state transitions, and the Durable Object delegates to it.

**Tech Stack:** Bun, TypeScript, Zod, Drizzle ORM 0.45.4, development-only Drizzle Kit 0.31.11, native SQLite Durable Objects, Cloudflare Vitest.

**Spec:** `docs/spec.md` §§5.1–5.4, 6.1–6.5, 9.3–9.5, 12.
Byte limits use decimal MB.
**Task:** OAB-6.2.
**Parent plan:** `docs/superpowers/plans/2026-10-15-f1-vault-persistence.md`.
**Worktree:** `~/.worktrees/obsidian-ai-bridge/feature/f1-authorization-tickets`.
**Base:** `5a451fb0171da238d362560fb7628bb7e320f129`.

## Global Constraints

- Get human plan approval before implementation.
- Preserve every mutation's exact observed revision. Absence never deletes. Obsolete revisions never overwrite.
- Keep both files or revisions after a collision.
- Use Zod in `packages/protocol` for canonical protocol shapes. Derive contract types from those schemas.
- Keep application code independent of Cloudflare and Drizzle SDKs.
- Use workspace aliases and published cross-workspace exports.
- Keep Drizzle as the only relational schema owner. Generate SQL, snapshots, journals, and runtime DDL.
- Preserve dependency pins. Add no dependencies, SDK shims, ambient type changes, or SQL equivalence parser.
- Keep production HTTP default-deny. Add no routes, fixture identities, development authentication, OAuth implementation, or public ticket API.
- Do not access the owner's vault or change Cloudflare resources. Use only local tests and Wrangler dry-runs.
- Ticket lifetime: 60 seconds. Server admission limit: 16 concurrent requests per client, across grants and Worker instances.
- The plugin's four-request limit is not the server limit.
- Inline text limit: 1,000,000 bytes. Blob limit: 25,000,000 bytes. Request body limit: 26,000,000 bytes.
- Reuse NFC paths, 512-byte and 32-segment limits, and existing ETag codecs.
- Rename needs `vault:write`, not `vault:delete`. Write does not grant delete permission.
- Never log bodies, tokens, authorization headers, or OAuth codes. Add no logging in this slice.
- Record behavioral RED after missing-contract RED. Typed fail-closed entry points may let the new tests execute.
- Never commit temporary placeholders or treat an import error as behavioral evidence.
- Reuse validation evidence when review changes no source. Do not repeat unchanged checks solely for review.
- Preserve semantic TSDoc for exported contracts and non-obvious private helpers.
- Freeze source during review. The parent owns validation and acceptance decisions.
- Run the code-review skill and human branch review before publication. Keep OAB-6.2 open until its criteria pass.

## Owner Decisions

The owner selected explicit Drizzle admission records and a bounded §5.2 amendment.
This plan also proposes a narrow §6.3 clarification for admission bookkeeping, subject to plan approval.
The owner confirmed that no deployed v1 data needs compatibility.
Do not migrate, reset, delete, or replace an unsupported store.

## Plan Decisions for Approval

1. Use canonical application schema version 2 and one generated initial artifact.
   Reject existing version-1 storage without writes.
   Do not build a migration framework or change Cloudflare's Durable Object migration tags.
2. Store reserved, active, and uncertain admissions in `operation_admissions`.
   Pre-body reservations, tickets, and future read requests share the same per-client limit.
   A reservation is not permission for a content effect.
3. Use server time only. Set `expires_at = admitted_at + 60_000`.
   Reject at `now >= expires_at`. Never extend the original deadline.
4. A confirmed completion releases its slot.
   An uncertain cancellation invalidates its ticket but retains its slot until confirmed completion or expiry.
5. Commit consumption remains an infrastructure-only transaction helper.
   It cannot authorize a later independent transaction or produce a reusable content-write capability.
6. Bound internal client and grant identifiers to 2,048 UTF-8 bytes each.
   Bound the canonical preparation envelope to 16 KiB.
   These are internal safety limits, not a new OAuth identifier syntax.
7. Use 128 random bits for ticket identifiers, encoded as 32 lowercase hexadecimal characters.
   Try at most eight candidate identifiers, including the first.
8. Clean expired records lazily with indexed, bounded queries.
   Each admission cleans its client's expired rows and at most 64 global expired rows.

## Review Focus

- Slow bodies and two Worker instances race for a client's last slot. Reserve before body buffering, including across different grants.
- A cancellation races with commit or its response is lost. Accounting never releases a second slot or admits a cancelled ticket.
- The actor restarts with uncertain work. Slots remain charged until settlement or the exact original deadline.
- Delimiters, Unicode normalization, destination changes, or altered sizes confuse fingerprint binding. Distinct operations cannot share authorization.
- Scope changes, revocation, epoch changes, or stale ETags occur after admission. The commit transaction rejects them without content effects.

## Ownership and Interfaces

### Canonical protocol contracts

Create:
- `packages/protocol/src/schemas/admission.ts`
- `packages/protocol/src/types/admission.ts`
- `packages/protocol/test/admission.test.ts`

Change `packages/protocol/src/index.ts` to export the contracts.

Define and derive:
- `VaultScopeSchema` / `VaultScope`: `vault:read | vault:write | vault:delete`.
- `AuthorizationContextSchema` / `AuthorizationContext`: `client_id`, `grant_id`, and normalized unique `scopes`.
- `OperationDescriptorSchema` / `OperationDescriptor`: `op`, `epoch?`, ordered `paths`, and `precondition`.
- `OperationIntentSchema` / `OperationIntent`: the descriptor plus `payload_hash` and `size`.
- `RequestAdmissionLeaseSchema` / `RequestAdmissionLease`: `admission_id` and `expires_at`.
- `RequestAdmissionResultSchema` / `RequestAdmissionResult`: `{ok: true, lease}` or `{ok: false, failure}`.
- `OperationTicketSchema` / `OperationTicket`: `id` and `expires_at`.
- `AdmissionFailureSchema` / `AdmissionFailure`: the internal failure variants below.
- `AdmissionResultSchema` / `AdmissionResult`: `{ok: true, ticket}` or `{ok: false, failure}`.
- `AdmissionCompletionSchema` / `AdmissionCompletion`: `settled | uncertain`.
- `AdmissionFinishResultSchema` / `AdmissionFinishResult`: `{ok: true}` or `{ok: false, failure}`.

A reservation validates descriptor fields before the Worker reads or buffers a body.
Full authorization also validates the payload hash and byte size before any content effect.
The operation set is `read | put | delete | rename | append | restore`.
This describes existing spec operations, not new HTTP routes.
Use lowercase 64-character hexadecimal payload hashes and nonnegative safe-integer byte sizes.

The precondition is `{kind: "none"}`, `{kind: "absent"}`, or `{kind: "match", etag}`.
Reuse `PathSchema`, `EpochSchema`, and `ETagSchema`, rather than new validators.

Cross-field rules:
- Read: zero or one path, no precondition, zero payload size, empty-byte hash. Epoch is optional.
- Put: one path, explicit epoch, and match or absent precondition.
- Delete: one path, match precondition, zero size, empty-byte hash.
- Rename: two ordered paths and the source match precondition.
- Append: one path, explicit epoch, and no revision precondition.
- Restore: one path and the destination match precondition.
- Derive the epoch from match preconditions. Reject disagreement with an explicit epoch.
- The body hash binds rename destinations and restore parameters as well as content.
- Classify put storage by extension and size, as §5.4 states. Do not trust a caller-supplied kind.
- Append input above 1,000,000 bytes fails before full authorization. Its final result-size check belongs to OAB-6.3.
- Put blobs stop at 25,000,000 bytes. Other body metadata stops at the 26,000,000-byte request limit.
- Do not add path ACLs or attachment-extension restrictions absent from the server contract.

Failure variants use `kind`: `invalid_request`, `revoked`, `forbidden_scope`, `epoch_mismatch`,
`text_too_large`, `blob_too_large`, `admission_limited`, `invalid_ticket`, and `precondition_failed`.
Epoch mismatch carries the current epoch.
Admission limit carries a positive integer `retry_after_seconds`.
Precondition failure carries current ETag, hash, and deletion state when a current row exists.
Never include file content in admission failures.
These internal variants do not add public HTTP error contracts.

### Application rules

Create `apps/worker/src/application/admission.ts`.

Produce:
- `requiredScope(op: OperationIntent["op"]): VaultScope`.
- `prepareDescriptor(context: AuthorizationContext, descriptor: OperationDescriptor): Promise<PreparedDescriptor>`.
- `prepareOperation(context: AuthorizationContext, intent: OperationIntent): Promise<PreparedOperation>`.
- `assertAdmissionAllowed(context: AuthorizationContext, operation: PreparedDescriptor | PreparedOperation, currentEpoch: string): void`.
- `AdmissionDenied`, containing one `AdmissionFailure`.

`PreparedDescriptor` has readonly `client_id`, `descriptor: OperationDescriptor`, and `descriptorFingerprint` fields.
`PreparedOperation` extends it with readonly `intent: OperationIntent` and `fingerprint` fields.
Freeze the normalized descriptor and intent, including paths and preconditions.
Parse and copy inputs before the hash await.
Use standard Web Crypto, not a Cloudflare SDK.
Do not accept a caller's fingerprint as authoritative.

Encode a versioned JSON tuple with a fixed field order before SHA-256:
`[version, epoch-or-null, client_id, op, paths, precondition, payload_hash, size]`.
Use a separate versioned tuple without payload hash or size for the descriptor fingerprint.
Do not concatenate unescaped delimiter-separated fields.
The descriptor fingerprint binds a reservation to its original metadata.
The full fingerprint replaces it only during the reserved-to-active transition.

Keep the same canonical fingerprint function available to OAB-6.3 receipts.
Bind grants separately in the stored ticket, as receipts remain client-scoped.

### Durable admission authority

Create `apps/worker/src/infrastructure/sqlite/admission.ts`.

Produce `SqliteAdmissionAuthority` with these methods:
- `reserve(context: AuthorizationContext, descriptor: OperationDescriptor): Promise<RequestAdmissionResult>`.
- `authorize(context: AuthorizationContext, intent: OperationIntent, admissionId?: string): Promise<AdmissionResult>`.
- `finish(context: AuthorizationContext, ticketId: string, completion: AdmissionCompletion): AdmissionFinishResult`.
- `consumeInTransaction(tx: VaultTransaction, context: AuthorizationContext, operation: PreparedOperation, ticketId: string): void`.
- `recordRevocation(grantId: string): void`.

Constructor inputs are native storage and `{now: () => number, newTicketId: () => string}`.
Infer `VaultTransaction` from the official Drizzle transaction callback type.
Keep that SDK type inside infrastructure.
Do not create a parallel transaction interface or pass it into application code.

Use Drizzle queries and the official synchronous Durable SQLite transaction driver.
Convert known admission denials to structured results outside the transaction.
Rethrow storage and programming errors.
Do not await, call R2, or return a Promise inside transaction callbacks.

### Persistent state

Change `apps/worker/src/infrastructure/sqlite/schema-model.ts`.

Add `operationAdmissions` to `vaultSchema`.
Its table `operation_admissions` has eight non-null columns:
- `id`: TEXT primary key.
- `client_id`, `grant_id`, `epoch`, `fingerprint`: TEXT.
- `admitted_at`, `expires_at`: INTEGER Unix milliseconds.
- `state`: TEXT, constrained to `reserved | active | uncertain`.

Name its check constraint `operation_admissions_state_check`.

Add indexes:
- `operation_admissions_client_expiry` on `(client_id, expires_at)`.
- `operation_admissions_expiry` on `expires_at`.

Derive stored types from Drizzle.
Keep the ten existing relational tables, keys, indexes, AUTOINCREMENT, and FTS semantics unchanged.
The generated relational artifact now contains 15 statements.
The largest table remains `files`, with 12 columns.

### Transaction order and recovery

Reserve before body preparation:
1. Validate and copy the descriptor without reading the body.
2. In one synchronous transaction, check revocation, scope, epoch, and paths.
3. Do bounded expiry cleanup and enforce the shared 16-slot limit.
4. Insert a reserved row with its descriptor fingerprint and 60-second deadline.
5. Return a lease, not a content ticket.
6. Before any content effect, authorize the full intent against that same reservation.

Authorize:
1. Validate and prepare the bounded request without content bytes.
2. Start one native synchronous transaction.
3. Check `revoked_grants` before reading vault metadata or file state.
4. Read the current epoch. Recheck scope, epoch, path, and declared size.
5. For an existing lease, check its owned, unexpired reserved row and matching descriptor fingerprint.
6. Upgrade that row to active with the full fingerprint. Do not take a second slot or extend its deadline.
7. Without a lease, clean expired rows and count this client's unexpired reserved, active, and uncertain rows.
8. At 16, deny. Otherwise insert one active ticket with a 60-second deadline.
9. Return success only after the storage write completes.

A second bind, changed descriptor, foreign lease, or expired lease fails without a state change.
The direct authorization path serves requests whose bounded metadata and hash are already available.
Body-bearing consumers reserve first. They never buffer bodies before admission.

The retry delay is `max(1, ceil((earliest_expiry - now) / 1000))`.
Do not materialize all admission rows or use a Worker-local map as authority.
All insertions must preserve at most 16 rows per client after that client's expiry cleanup.
Global cleanup selects at most 64 identifiers and deletes only those identifiers.
This keeps a delete statement below the 100-binding platform limit.

Finish:
1. Check revocation before metadata. Check ticket ownership by client and grant.
2. For settled work, delete only its owned row. Missing rows are idempotent success.
3. For uncertain work, change only its owned row to `uncertain`.
4. Keep its deadline and slot. Such a ticket cannot commit.
5. Repeated or foreign completion cannot release another ticket.
6. Expiry remains recoverable after actor eviction, without a Worker acknowledgement or an alarm.

Use settled completion only before effects start or after the Worker knows the I/O result.
Do not translate a timeout, disconnect, or unknown result into settled completion.

Consume:
1. The content repository starts the official synchronous transaction.
2. Recheck revocation first, then current scopes and epoch.
3. Reject read operations. A read ticket cannot authorize a content mutation.
4. Check ownership, active state, original deadline, and the complete fingerprint.
5. Check match or absent preconditions against current `files` metadata.
6. Delete the exact owned ticket inside that transaction.
7. The caller does its content changes and receipt write in that same transaction.
8. Any failure rolls back both consumption and content changes.

For match, compare the exact current path revision and epoch.
For absent, reject any live `path_key` collision. A tombstone is not a live collision.
Operation-specific append, rename, restore, capacity, and receipt rules remain inside their later mutation transactions.
Do not make `consumeInTransaction` a standalone RPC or call it before a separate content transaction.
An unbound, replayed, expired, uncertain, foreign, or fingerprint-mismatched ticket produces `invalid_ticket`.

Revocation:
- Insert `revoked_grants` idempotently in a synchronous transaction.
- Do not change OAuth KV, issue tokens, or add an owner route.
- Existing admissions cannot commit after that write.
- Their accounting remains bounded until settlement or expiry.

## Task 1: Canonical Admission Contracts and Rules

**Deliverable:** Independently tested request validation, permission rules, and immutable fingerprints.

**Files:** Protocol files and `application/admission.ts` above.
**Test:** `packages/protocol/test/admission.test.ts` and `apps/worker/test/admission-rules.test.ts`.
**Consumes:** Existing path and ETag schemas.
**Produces:** All canonical admission types, `prepareDescriptor`, `prepareOperation`, `requiredScope`, `assertAdmissionAllowed`, and `AdmissionDenied`.

- [x] Write failing schema tests for every operation, invalid cross-field combination, and boundary.
  Assert 512/513 path bytes, 32/33 segments, 2,048/2,049 identifier bytes, and 16 KiB envelope bounds.
- [x] Write failing permission tests.
  Assert read needs read, delete needs delete, and put/rename/append/restore need write.
  Assert write alone cannot delete or read.

```ts
it("maps rename and delete to their exact scopes", () => {
  expect(requiredScope("rename")).toBe("vault:write");
  expect(requiredScope("delete")).toBe("vault:delete");
  expect(requiredScope("read")).toBe("vault:read");
});
```
- [x] Write failing fingerprint tests.
  Assert NFC equivalents match, while changed client, epoch, operation, destination, condition, hash, or size differs.
  Assert delimiter-containing fields cannot cause tuple ambiguity.
  Assert caller mutation during the hash await cannot change the prepared operation.
- [x] Write failing size and epoch tests.
  Assert bootstrap reads need no known epoch.
  Assert stale explicit or ETag epochs fail, oversized blob declarations fail, and oversized append inputs fail.
- [x] Run focused tests and record the observed failure.
  Wrap expected RED commands so the background task exits zero, then assert their observed exit code and failure output.
  An import failure alone does not prove permission behavior.
- [x] Implement the named contracts and application rules.
  Include semantic TSDoc and immutable input snapshots.
- [x] Run:
  `bun run --filter @obsidian-ai-bridge/protocol test`
  and `bun run --filter @obsidian-ai-bridge/worker test -- test/admission-rules.test.ts`.
  Expect every new assertion to pass.
- [x] Run `bun run check` once for this source state.
- [x] Commit as `feat(protocol): define vault admission contracts`.

## Task 2: Native Durable Admission and Expiry

**Deliverable:** Real Durable Objects reserve and release bounded slots across eviction and Worker instances.

**Files:**
- Create `apps/worker/src/infrastructure/sqlite/admission.ts`.
- Create `apps/worker/test/vault-admission.test.ts`.
- Create shared native fixture helpers in `apps/worker/test/fixtures/admission.ts`.
- Change `apps/worker/src/infrastructure/durable-object/vault.ts`.
- Change `apps/worker/src/infrastructure/sqlite/schema-model.ts`, `schema.ts`, and `schema.generated.ts`.
- Replace the generated initial SQL, snapshot, and journal under `apps/worker/drizzle/`.
- Change `apps/worker/test/vault-storage.test.ts` and `docs/spec.md` §§5.2 and 6.3.
- Add immutable test-only v1 DDL fixture `apps/worker/test/fixtures/schema-v1.ts`.

**Consumes:** Task 1 contracts, `prepareDescriptor`, `prepareOperation`, and `assertAdmissionAllowed`.
**Produces:** `reserve`, `authorize`, and `finish`, canonical schema version 2, native RPC delegation.

- [ ] Preserve the base commit's exact v1 DDL as the test-only fixture before regeneration.
  Name its origin commit in the fixture comment.
  Do not add historical schemas to production.
- [ ] Write failing native tests for the missing admission table and schema version 2.
  Seed a genuine canonical-v1 store from the fixture.
  Assert rejection preserves its catalog, epoch, metadata, and content without invoking identity factories.
- [ ] Write failing native authorization tests for revoked grants, missing scopes, stale epochs, invalid paths, and oversized declarations.
  Assert denial creates no ticket and changes no content tables.
- [ ] Write the native 17-way reservation test through two stubs for the same Durable Object.
  Use the same client with different grants.
  Assert exactly 16 successes, one limited result, positive retry delay, and 16 stored rows.
  Assert a second client has its own limit.
  Hold reservations without body preparation. Assert the seventeenth request gets no lease.
  Collect the 17 reserve results in `results`.

```ts
expect(results.filter((result) => result.ok)).toHaveLength(16);
expect(results.filter((result) => !result.ok)).toHaveLength(1);
```
- [ ] Write native binding tests.
  Assert binding preserves the identifier, deadline, and one charged slot.
  Assert second binding, altered descriptors, expired leases, and foreign ownership cannot activate a ticket.
  Assert reserved rows cannot commit and uncertain rows cannot bind.
- [ ] Write native finish and expiry tests.
  Assert settled completion releases exactly one slot and repeated completion releases none.
  Assert uncertain completion retains its slot and original deadline.
  Assert foreign-client and foreign-grant completion leave ownership and counts unchanged.
  Assert uncertainty survives eviction.
  Assert validity at 59,999 ms and rejection or capacity recovery at 60,000 ms.
- [ ] Write native cleanup and failure tests.
  Assert bounded global cleanup deletes at most 64 expired records and leaves live records intact.
  Assert identifier collisions, invalid server timestamps, and failed inserts never issue permission or leak slots.
- [ ] Run the focused native tests and record valid RED evidence.
- [ ] Add the Drizzle model and the bounded §5.2 amendment.
  Clarify §6.3: no content bytes or content metadata change before successful authorization.
  Admission bookkeeping follows the applicable permission checks and precedes the ticket response.
  Do not weaken authorization-before-content or change public routes.
- [ ] Remove the three old versioned initial artifacts after the fixture preserves them.
  Generate only the unpublished canonical version-2 initial artifacts.
  From `apps/worker`, generate with the pinned CLI:
  `./node_modules/.bin/drizzle-kit generate --config tooling/drizzle.config.ts --name initial_v2`.
  Format generated metadata with the repository Biome executable.
  Run `bun tooling/generate-runtime-schema.ts`.
  Keep one `0000_*.sql` artifact, its snapshot, and its journal.
  Do not broaden `readInitialMigration` or edit generated SQL manually.
- [ ] Set application metadata `schema_version` to `2`.
  Preserve strict admission of catalog objects and read-only rejection of older stores.
  Update relevant version literals and the 15-statement assertion.
  Artifact ordinal `0000` is not the application schema version.
  Keep the existing 8,192-byte bootstrap DDL limit.
- [ ] Implement `reserve`, `authorize`, and `finish` with indexed Drizzle queries and synchronous transactions.
  Reject unsafe clock values or deadline overflow before insertion.
  Roll back every state change after insertion or entropy failure.
- [ ] Delegate native `Vault.reserveAdmission`, `Vault.authorize`, and `Vault.finishAdmission` methods to the authority.
  Wire real time and CSPRNG in composition.
  Accept verified Worker claims only through the private binding.
  Add no token provider, fixture switch, or HTTP route.
- [ ] Run `bun run --filter @obsidian-ai-bridge/worker test -- test/vault-admission.test.ts test/vault-storage.test.ts`.
  Expect all native tests to pass.
- [ ] Run `bun run check`, `backlog doctor`, and `git diff --check`.
- [ ] Commit as `feat(worker): persist bounded vault admission tickets`.

## Task 3: Atomic Consumption and Revocation Interleavings

**Deliverable:** The same native transaction checks authorization, consumes the ticket, and lets its caller make SQL changes.

**Files:**
- Change `apps/worker/src/application/admission.ts`.
- Change `apps/worker/src/infrastructure/sqlite/admission.ts`.
- Create `apps/worker/test/vault-admission-commit.test.ts`.
- Reuse fixture helpers from `apps/worker/test/fixtures/admission.ts`.
**Test:** Also preserve `apps/worker/test/entry.test.ts`.
**Consumes:** Task 2 authority, schema, and durable accounting.
**Produces:** `consumeInTransaction` and `recordRevocation`, ready for the OAB-6.3 content repository.

- [ ] Write failing native consume tests.
  Assert one successful consumption, replay denial, foreign identity denial, and changed-intent denial.
  Assert reserved, read-only, uncertain, and expired admissions deny content consumption.
- [ ] Write native interleaving tests.
  Admit first, then revoke, change scopes, change epoch, or replace the observed file revision.
  Assert each commit call fails before its SQL effect.
  Assert create-only collision and tombstone cases use current authoritative metadata.
- [ ] Write the atomic rollback test with a real Drizzle transaction and real fixture rows.
  Consume the ticket, change fixture file, revision, receipt, and feed rows, then throw.
  Assert the ticket, file, revision, receipt, and feed states all remain unchanged.
  Retry in a successful transaction and assert one effect and one consumed ticket.
  Do not add a fake production mutation endpoint.
  Compare the complete native state snapshots, including the admission row.

```ts
expect(afterFailure).toEqual(before);
expect(ticketAfterFailure?.id).toBe(ticket.id);
expect(ticketAfterSuccess).toBeUndefined();
```
- [ ] Write both cancellation/commit orderings.
  If commit wins, later finish is harmless.
  If uncertain cancellation wins, later commit fails and the slot remains charged until settlement or expiry.
- [ ] Write response-loss recovery tests.
  Assert a lost authorization response retains one slot until expiry.
  Assert a lost commit response cannot consume again or decrement another admission.
  Assert a late acknowledgement cannot release a newer ticket.
- [ ] Run the focused native tests and record valid RED evidence.
- [ ] Implement consumption and idempotent revocation persistence.
  Use the caller's official transaction object, not an independent nested transaction.
  Select metadata only, never note content, for precondition failures.
  Keep operation-specific content algorithms and receipt semantics out of this task.
- [ ] Verify production HTTP still rejects authorization-shaped bodies, headers, and guessed ticket routes.
  Assert no route exposes fixture claims or an authentication bypass.
- [ ] Run focused native tests, then `bun run check`.
- [ ] Run `backlog doctor` and `git diff --check`.
- [ ] Commit as `feat(worker): consume admission tickets atomically`.

## Acceptance and Evidence Boundaries

- OAB-6.2 criterion 1: Task 1 and native denial tests prove scope, epoch, path, size, and immediate revocation enforcement.
- Criterion 2: Tasks 2 and 3 prove the 60-second deadline, fingerprint binding, single use, and atomic rechecks.
- Criterion 3: Tasks 2 and 3 prove cross-instance limits, uncertain completion, cancellation, and restart recovery.
- Criterion 4: Native actor tests and default-deny entry tests prove the private trust boundary.
- No R2 operation exists in this slice. Do not claim the full 20 MB AC-28 upload test.
- OAB-6.5 already owns actual R2 staging, cancellation, aggregate streaming memory, and AC-28 integration.
  Its trigger is completion of OAB-6.3, as the existing task dependency states.
- OAB-6.3 owns content mutations, idempotency receipts, pre-body reservation integration, and the first content consumer of the transaction guard.
- OAB-6.4 owns complete rename and restore algorithms.
- OAB-6.6 owns read transports and holds their admission through response completion or cancellation.
- Later consumers must enforce deadlines and report uncertain I/O honestly. Ticket expiry does not recall bytes already in flight.
- This plan proves admission control, not aggregate upload memory, CPU timing, remote deployment, or all-F1 completion.

## Final Gates

- [ ] Keep all OAB-6.2 acceptance boxes unchecked until implementation evidence passes.
- [ ] Run the selected execution workflow and the code-review skill.
- [ ] Get an independent whole-branch review with the mandated model.
- [ ] Open human branch review against `main` with Plannotator. Address every annotation.
- [ ] Close OAB-6.2 through Backlog CLI only after evidence and approval.
- [ ] Commit task metadata separately when it changes no product source.
- [ ] Push the explicit feature branch and open an English Conventional Commit pull request.
- [ ] Preserve unique private evidence and remove only the clean, published worktree.
- [ ] Do not merge or delete unpushed work.

## Plan Self-Review

- Scope covers OAB-6.2 and the approved storage amendment only.
- Contract names and transaction ownership match across all three tasks.
- Each Review Focus condition has an explicit native or rule test step.
- No new authentication provider, public route, blob writer, content mutator, or migration framework appears.
- Baseline evidence: 68 tests, all workspace compilers, Biome, local builds, Backlog doctor, and diff check passed.
- Baseline bundle: 675.04 KiB, 111.67 KiB gzip. Wrangler used dry-run only.
- Implementation method remains the owner's choice.

## Execution Choice After Plan Approval

Recommend subagent-driven execution for these three independently testable security boundaries.
A fresh implementer and reviewer examine each task before the next task starts.
Native execution remains an option, with an independent whole-branch review at the end.
Do not treat the earlier OAB-6.1 execution choice as authorization for this task.
