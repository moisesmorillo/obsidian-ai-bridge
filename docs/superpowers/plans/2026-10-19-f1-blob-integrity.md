# Declared Blob Integrity Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` after owner approval. Complete each task and its independent review before the next task.

**Goal:** Verify declared blob identity with bounded upload memory before the Vault publishes an authoritative reference.

**Architecture:** The Worker streams authorized uploads into immutable, create-only R2 objects. The Vault checks stored integrity evidence before its existing atomic publication transaction. Four shared body slots bound active upload work across clients in each Worker isolate.

**Tech Stack:** TypeScript, Zod, Hono, native Workers streams, R2, SQLite Durable Objects, Drizzle, and Vitest.

**Spec:** `docs/spec.md`, sections 5.3–5.4, 6.1–6.5, 9.5, 12, AC-16, and AC-28. OAB-6.5 authorizes the declared-input amendment.

## Approval and baseline

- Planning only. No product implementation starts before owner approval in Plannotator.
- PR #12 merged on 2026-10-19 at `2584149f0f4865f707ce6452bdc5bf1167efbad4`.
- Fetched `origin/main` names that merge commit. The branch starts from that exact remote base.
- Worktree: `~/.worktrees/obsidian-ai-bridge/feature/oab-6.5`.
- The original checkout stays on its original revision, without file changes.
- OAB-6.3 and its OAB-6.2/OAB-6.1 dependencies are Done. OAB-6.4 is also Done and merged.
- The baseline `bun install --frozen-lockfile` and `bun run check` run separately before implementation approval.

## Global constraints

- Complete only OAB-6.5. Do not implement manifest, feed, search routes, plugin behavior, or general capacity qualification.
- Preserve exact-revision conditions, visible collisions, immutable history, and client-scoped receipts.
- Never infer a delete from absence. Never overwrite an existing content-addressed R2 object.
- Keep SHA-256 over exact raw bytes. Do not decode blob bytes as text.
- Use 25,000,000 bytes for blobs and 1,000,000 bytes for inline Markdown and Canvas.
- Do not add staging keys, multipart uploads, garbage collection, dependencies, or storage migrations.
- Do not access the personal vault. Do not deploy or change Cloudflare resources.
- Local test bindings and dry-run build configuration may name the existing bucket. They must not create remote resources.
- Keep production identity denial. Test identities remain in the separate test entry.
- Keep canonical wire schemas in `packages/protocol`, with inferred TypeScript types and useful TSDoc.
- Use workspace aliases and public cross-workspace exports as stated in `AGENTS.md`.
- Retain genuine RED output. Do not remove working implementation to reconstruct RED.
- Record any retained-code exception in OAB-6.5 notes without claiming a missing functional failure.

## Owner decisions

The owner selected both decisions in one question set:

1. Four active body-bearing mutations per isolate, without a waiting queue. Excess requests get `429` and `Retry-After`.
2. Mandatory `X-Content-SHA256` and `X-Content-Size` for blob PUT only. Existing inline text requests remain compatible.

The slot covers PUT, append, rename, and restore body work. It remains charged until its related asynchronous work settles.

## Contract and publication sequence

1. Validate identity, scope, path, epoch, preconditions, and canonical declaration syntax without reading request bytes.
2. Acquire an isolate-wide body slot without a queue, then reserve durable admission before reading a body.
3. For a declared blob, bind the declared digest and size into the full operation fingerprint and get the operation ticket.
4. Do not start R2 I/O before full DO authorization. A reservation alone grants no storage authority.
5. Read bounded chunks, count actual bytes, and feed a native `crypto.DigestStream("SHA-256")` sequentially.
6. For a new key, stream into `FixedLengthStream(declaredSize)` and R2 with `sha256` plus `If-None-Match: *`.
7. Verify actual EOF, exact byte count, and actual digest before the final successful stream close.
8. On an existing key or a lost create-only race, still verify this request's entire body. Never accept its declarations alone.
9. Check the stored object's size and R2 SHA-256 checksum. Missing or inconsistent integrity evidence fails closed without replacement.
10. The Vault independently checks the immutable object's R2 integrity metadata before committing a new blob reference.
11. Recheck grant, epoch, ticket, key ownership, expiry, collision, and current revision after asynchronous storage work.
12. Atomically write files, revisions, changes, FTS removal, blob_refs, counters, and the receipt through the existing coordinator.
13. Settle known failures. Keep uncertain admissions until their original deadline. Never extend a deadline for a retry.
14. Return the canonical receipt. A matching committed receipt can replay without another R2 upload.

An upload that starts after revocation sends no bytes to R2. Revocation during upload blocks publication at the final authority check.
An already authorized upload can leave a verified orphan if revocation, cancellation, or a lost response prevents publication.
No failure path deletes an R2 key. No retry overwrites it.

### Declaration and error policy

- `X-Content-SHA256` is exactly 64 lowercase hexadecimal characters.
- `X-Content-Size` is a canonical nonnegative decimal integer, at most 25,000,000.
- Supply both headers or neither. Invalid syntax or a missing blob declaration returns `400 invalid_request`.
- Binary paths always need declarations. Markdown/Canvas declarations select the path by their declared byte size.
- Markdown/Canvas at or below 1,000,000 bytes remains inline. Larger declared inputs use the blob path.
- Undeclared Markdown/Canvas keeps the existing bounded inline reader. Crossing its ceiling returns `413 text_too_large`.
- If an inline request supplies declarations, verify them too. Do not silently ignore a supplied identity.
- Missing transport `Content-Length` is valid with blob declarations. Derive the fixed R2 stream length from the declared size.
- A supplied transport length must match the declaration. Transport length never replaces measured size.
- Declared or actual blob overflow returns `413 blob_too_large`.
- Other actual length or digest mismatches return `422 blob_integrity_mismatch`.
- Storage errors or missing stored integrity evidence return `503 blob_storage_unavailable` with a bounded retry delay.
- Isolate saturation reuses `429 admission_limited` with `Retry-After: 1`, without durable ownership or body consumption.
- Keep domain errors in canonical schemas and codecs. Extend retry-header validation for the new storage error.

### Stream ownership and cancellation

Use bounded BYOB reads from native request streams, with a maximum 65,536-byte application read buffer.
Do not use `tee()`, request cloning, full-blob arrays, or an unbounded fallback reader.
Await digest and storage writes before another read. A slow storage consumer must stop source demand.
A non-BYOB source must fail closed or use a demonstrably bounded adapter. Do not accept arbitrary retained chunks.

A conditional R2 refusal can arrive without consuming the supplied stream.
The adapter must stop that storage sink, unblock any pending write, and finish body verification through a bounded discard sink.
A null result does not prove body consumption or successful integrity verification.
Test this with a sink that returns null immediately and never reads.
If the pinned runtime cannot support this sequence safely, stop for an owner decision. Do not buffer or add staging.

On abort, stop input demand and abort both digest and storage streams. Await all started work without an unhandled rejection.
Keep the body slot until started storage work settles. Do not release it merely because the client disconnects or the ticket expires.
The original admission deadline bounds publication authority, not the lifetime of non-cancellable storage work.
A permanently stalled operation can exhaust slots and cause safe refusals. It cannot justify early slot reuse.

## Platform evidence and aggregate budgets

Primary documentation retrieved on 2026-10-19:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 128 MB per isolate, shared across concurrent requests.
- The same source gives six simultaneous outgoing connections per invocation and a 100 MB minimum account request limit.
- Workers Paid defaults to 30 seconds CPU per HTTP request. Workers Free allows 10 ms. This task does not claim Free support.
- The current Paid subrequest limit is 10,000. The conservative Free comparison is 50.
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): streamed PUT, conditional PUT, SHA-256 integrity checking, and stored checksums.
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/): conditional writes are atomic at commit. Negative HEAD does not settle an earlier uncertain write.
- [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/): excess or missing bytes cause an error.
- [ReadableStream](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestream/): BYOB readers are supported.
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/): DigestStream hashes without retaining written data.
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/): 5 GiB single-part uploads and one write per second to one key.

| Resource | Aggregate bound or formula | Limit and response |
| --- | --- | --- |
| Active body work | `N <= 4` across clients, grants, paths, and vault hosts in one Worker isolate | Fifth request gets 429 without a queue |
| Blob application buffers | Target `4 requests * 4 buffers * 65,536 bytes = 1,048,576 bytes` | Verify buffer ownership and pending writes in tests |
| Inline source bytes | `4 * 1,000,000 = 4,000,000 bytes` | The same slots cover inline and command bodies |
| Inline retained copies | Inventory actual byte arrays, UTF-16 strings, validation copies, RPC payloads, and failure bodies | Target at most 32 MiB of upload-owned retained data across four requests |
| Blob size | `4 * 25,000,000 = 100,000,000 bytes` can reach R2 concurrently | Streamed bytes are not a heap allocation budget |
| New upload I/O | Worker HEAD + optional PUT + post-race HEAD, then Vault HEAD | At most four R2 operations across both invocations, without in-request retries |
| Outgoing connection fan-out | At most one R2 operation and one authority RPC pending in the upload sequence | Below six per invocation. Count native behavior in integration tests |
| Authority RPC calls | Reserve, authorize, commit, finish. Exceptional epoch lookup adds one | No loop or hidden retry. Preserve existing admission limits |
| Per-key writes | At most one PUT per request. HEAD reuse avoids writes for stored objects | Return a retryable error on R2 throttling. No immediate retry loop |
| Upload authority time | Original 60-second admission deadline | Slow uploads can leave authorized orphans but cannot publish after expiry |
| Orphan storage growth | At most 25,000,000 bytes per new authorized hash | Lifetime growth remains unbounded without GC, as already approved |
| Range response | At most 1,000,000 selected bytes | Reject invalid or excessive ranges with 416 |

The 32 MiB target is not a measured runtime result. Task 3 must replace it with an actual retained-buffer inventory and local observations.
Do not call a four-slot counter alone proof of the memory target.
Native stream queues, platform internals, garbage collection, routing, authentication, and unrelated reads also use isolate memory.
The difference between 128 MB and application buffers is not proven headroom for those costs.
This plan bounds upload-owned retention. It does not certify total isolate RSS or the general OAB-6.8 runtime envelope.
If upload-owned retention cannot meet the target, stop before acceptance. Do not defer an OAB-6.5 acceptance failure.
Keep broader memory and CPU qualification explicitly outside this result. Do not change deployment limits or claim deployed measurements.

## Review focus

1. An existing object must survive forged bytes, length mismatch, cancellation, conditional races, and uncertain retries unchanged.
2. An early conditional refusal must not deadlock a blocked producer or bypass incoming-body verification.
3. Many distinct clients must share one body budget, including text and command paths.
4. Revocation, ticket expiry, epoch changes, and stale revisions during R2 awaits must block authority publication.
5. Text/blob transitions must preserve exact history, search exclusion, large markers, and safe ranges.

## File ownership

- `packages/protocol/src/schemas/blobs.ts`, `types/blobs.ts`: declarations, blob metadata, range selection, and result contracts.
- `packages/protocol/src/schemas/files.ts`, `codecs/files.ts`, `src/index.ts`: canonical errors and exports.
- `apps/worker/src/application/blobs.ts`: small platform-independent blob and Vault ports, plus upload orchestration.
- `apps/worker/src/application/body-budget.ts`: synchronous four-slot acquisition and idempotent release, without authority state.
- `apps/worker/src/infrastructure/r2/blobs.ts`: R2 conditions, integrity evidence, native streams, and storage error translation.
- `apps/worker/src/infrastructure/sqlite/blob-files.ts`: metadata snapshots and atomic blob publication through the coordinator.
- `apps/worker/src/infrastructure/sqlite/text-files.ts`: binary admission, binary delete, and safe text/blob transitions.
- `apps/worker/src/infrastructure/durable-object/vault.ts`: composition and narrow RPC methods only.
- `apps/worker/src/transport/blobs.ts`: declaration parsing, blob response headers, and HTTP range mechanics.
- Existing `transport/files.ts` and `transport/history.ts`: dispatch and shared body-budget integration, not duplicate upload policy.
- `src/index.ts`, `src/env.ts`, local test configuration, and the HTTP fixture: capability wiring without remote resource effects.
- `docs/spec.md`: the approved amendment and implemented API errors. Do not create a separate API progress document.

## Task 1: Canonical blob contracts and shared body-budget policy

**Interfaces:**

- Add `BlobDeclarationSchema` with `{ payload_hash: string, size: number }` and inferred `BlobDeclaration`.
- Add `BlobMetadataSchema` with path, ETag, hash, size, blob kind, deletion state, origin, timestamp, and `large`.
- `large` is true only for Markdown/Canvas stored as a blob above 1,000,000 bytes.
- Add canonical single-byte-range selection. Reject multiple, malformed, unsatisfiable, or over-1,000,000-byte selections.
- Export `tryAcquireBodySlot(): (() => void) | undefined` from `application/body-budget.ts`.
- The release function is idempotent. Acquisition has no asynchronous gap and no pending-request collection.

**Tests:** `packages/protocol/test/blobs.test.ts`, failure-codec tests, and `apps/worker/test/body-budget.test.ts`.

- [ ] Write focused tests for invalid digests, paired declarations, canonical sizes, 0/1,000,000/1,000,001/25,000,000/25,000,001 boundaries, and range errors.
- [ ] Write `shares_four_slots_across_distinct_callers` and `does_not_release_a_slot_twice`. Assert four successes, then refusal, then one reusable slot.
- [ ] Run focused tests and preserve real failure output. Distinguish missing-module errors from functional RED.
- [ ] Implement schemas, codecs, slot policy, exports, TSDoc, and the affected specification amendment.
- [ ] Run focused tests, `bun run docs:check`, and `bun run check`. Confirm successful exit codes.
- [ ] Commit as `feat(protocol): define declared blob integrity contracts`.
- [ ] Get one independent task review and close every finding with evidence before Task 2.

## Task 2: Immutable storage evidence and atomic native blob publication

**Interfaces:**

- `BlobStore` in `application/blobs.ts` exposes `head(hash)` and `putVerified(declaration, body, signal)` capabilities.
- `head` returns `{ hash, size }` only from R2 SHA-256 checksum evidence, never custom metadata or an ETag digest assumption.
- `putVerified` resolves only after incoming-body verification and successful stored-object verification.
- Add `commitBlob(context, intent, ticketId, key?) -> Promise<TextMutationResult>` to the Vault gateway.
- Add `readBlobMetadata(context, request)`, using canonical epoch/path/revision selection and immutable reference metadata.
- Implement the R2 metadata adapter now. Task 3 completes the streamed PUT method.

**Tests:** `apps/worker/test/vault-blob-files.test.ts`, existing native text/history suites, and publication-budget fixtures.

- [ ] Write native failing tests for missing objects, wrong size/checksum, missing checksum, invalid tickets, wrong keys, and publication rollback.
- [ ] Add interleavings for revocation, epoch changes, ticket expiry, and stale preconditions across the R2 metadata await.
- [ ] Assert unchanged files, revisions, changes, FTS, receipts, blob_refs, and counters after each rejected publication.
- [ ] Run the tests and preserve their initial failures.
- [ ] Implement metadata attestation and native publication with pre-I/O policy checks and final synchronous coordinator checks.
- [ ] Replay a matching committed receipt before unnecessary R2 access, after current policy checks. Do not trust an uncommitted caller assertion.
- [ ] Extend PUT admission and DELETE to binary paths. Preserve CAS, collisions, receipt binding, and the original admission deadline.
- [ ] Cover inline-to-blob and blob-to-inline transitions. Delete obsolete FTS entries in the publication transaction.
- [ ] Verify blob rename, restore, delete, and retained reads without copying R2 objects or changing their keys.
- [ ] Verify metadata `large` and absence from native FTS for a 1,500,000-byte Markdown blob.
- [ ] Measure blob publication SQL dispatches and complete metadata row sizes with the existing native budget fixture.
- [ ] Run focused suites, `bun run docs:check`, and `bun run check`. Confirm successful exit codes.
- [ ] Commit as `feat(worker): publish verified blob references atomically`.
- [ ] Get one independent task review and close every finding with evidence before Task 3.

## Task 3: Bounded streaming, HTTP integration, and aggregate upload proof

**Interfaces:**

- Complete `BlobStore.putVerified` with the streaming and conditional-race policy above.
- Add `executeBlobPut` in `application/blobs.ts`, using the existing reservation, authorization, finish, and receipt policies.
- Wire one isolate-scoped body budget instance into production and test transport composition.
- Keep the slot across body handling, upload, authority calls, and cleanup. No per-router or per-client counter substitutes for it.
- Preserve existing inline JSON GET responses. Blob GET returns raw bytes with the authoritative file ETag.
- Blob responses expose `Accept-Ranges: bytes`, exact `Content-Length`, and `X-File-Large: true|false`.
- Single range GET returns 206 with exact `Content-Range`. Whole-object GET streams without whole-object buffering.
- The Vault selects the reference before R2 access. Never infer authoritative existence from R2 alone.

**Tests:** `apps/worker/test/blob-streams.test.ts`, `apps/worker/test/http/blobs.test.ts`, and existing HTTP suites.

- [ ] Add native-R2 contract tests for checksum rejection, create-only races, zero bytes, and FixedLengthStream underflow/overflow.
- [ ] Add a stopped-consumer test that verifies source reads stop under backpressure.
- [ ] Add an immediate-null storage sink that never reads. Verify bounded completion without a producer deadlock.
- [ ] Add cancellation during a pending source read, digest write, storage write, and post-upload authority call.
- [ ] Add a non-cancellable storage operation. Verify its slot remains charged after caller cancellation until storage settles.
- [ ] Add distinct-client and distinct-host HTTP requests that hold all four slots. The fifth request must not read its body or create admission rows.
- [ ] Mix inline PUT, blob PUT, append, rename, and restore paths in slot-limit tests. Verify failures release slots exactly once.
- [ ] Add real HTTP boundary tests for exact bytes at 0, 1,000,000, 1,000,001, 1,500,000, 25,000,000, and 25,000,001 bytes.
- [ ] Cover binary bytes, multibyte UTF-8, BOM, invalid UTF-8 blobs, missing declarations, and conflicting or unknown transport length.
- [ ] Assert actual digest and count before publication. Snapshot an existing object before each malicious or cancelled upload and compare it afterward.
- [ ] Cover same-hash races across clients, R2 throttling/failure, R2 success with lost response, and DO success with lost response.
- [ ] Retry with the same immutable intent and key. Verify one revision, one feed row, one receipt, and unchanged object bytes.
- [ ] Verify pre-revoked 20,000,000-byte uploads reach no R2 content effect. Verify mid-upload revocation prevents publication.
- [ ] Test current and retained blob reads, exact range boundaries, excessive ranges, missing stored objects, and revocation before R2 reads.
- [ ] Run the tests and retain genuine initial failure output before implementation.
- [ ] Implement native streaming, transport dispatch, capability wiring, range handling, and shared body-budget integration.
- [ ] Record the buffer-ownership formula, observed maximum pending chunks, source demand, and retained inline copies in task notes.
- [ ] Use the pinned local Workers runtime for aggregate tests. Separate observed allocation bounds from unmeasured platform overhead.
- [ ] Run focused suites, `bun run docs:check`, and `bun run check`. Confirm successful exit codes and dry-run-only builds.
- [ ] Scan production source and build output for test identity hooks. Keep production denial unchanged.
- [ ] Commit as `feat(worker): stream declared blobs with bounded integrity checks`.
- [ ] Get one independent task review. Close each finding with direct evidence before branch review.

## Execution and review gates

- Use one writer per worktree. Run implementation tasks sequentially because their contracts and native authority changes depend on each other.
- Use native asynchronous subagents after approval. Give each worker a 5,400-second timeout.
- Pin implementers to `openai/gpt-6-luna:medium`. Pin scoped corrective reviewers to the same model and thinking level.
- Pin task reviewers to `openai/gpt-6-luna:high` and whole-branch architecture/code review to `openai/gpt-6.1-sol:medium`.
- Workers own failing tests, implementation, formatting, debugging, `bun run docs:check`, `bun run check`, and commits.
- Workers run checks through their own shell. The parent inspects their commands and saved output without repeating their checks.
- Stop and report launch or runtime failure. Do not silently switch tools or models.
- Review implementation, executable configuration, and TSDoc with the code-review skill and TypeScript profile.
- Review the final publication and memory design with design-feasibility-review. Recompute budgets after every correction.
- Review selected stateful owners: body-slot lifetime, upload result classification, storage evidence, and native publication.
- Give each finding exactly one evidence-based closure: fixed, intentionally deferred, rejected, or still open.
- A functional acceptance gap cannot become a bounded follow-up merely because adjacent tests pass.

## Acceptance mapping and completion

- AC1: Task 1 schemas and spec amendment, plus Task 3 implemented HTTP errors and header tests.
- AC2: Task 2 authority checks and rollback tests, plus Task 3 streaming, byte-count, digest, cancellation, and storage tests.
- AC3: Task 2 exact metadata/history and FTS exclusion, plus Task 3 binary/text boundaries and raw range reads.
- AC4: Task 3 cross-client slot and retained-buffer evidence, plus uncertain-storage and receipt replay tests.
- AC-16 coverage is server-side only here. Manifest listing, panel display, and full plugin sync remain in their assigned tasks.
- The canonical `large` metadata and HTTP header provide the server marker without inventing a manifest endpoint.

After all tasks pass, get an independent whole-branch review against the recorded remote merge base.
Preserve reports, RED output, full check logs, finding closures, and the plan outside the removable worktree before cleanup.
Do not commit evidence or review-record documents. Put durable conclusions in Backlog notes and the PR.
Open one human Plannotator branch review against `main`, with `origin/main` as the authoritative comparison revision.
Address every annotation with evidence before publication.
Read Backlog finalization instructions, verify each criterion, and close only OAB-6.5.
Push `feature/oab-6.5` and create an English Conventional Commit style PR with `gh pr create`.
Do not merge locally or delete an unpushed branch. Preserve artifacts before worktree removal.
Stop after the PR and task handoff. Do not start another task.
