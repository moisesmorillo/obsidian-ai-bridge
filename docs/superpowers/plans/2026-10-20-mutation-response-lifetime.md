# Mutation Response Lifetime Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`. Complete this corrective unit and its independent review before branch acceptance.

**Goal:** Keep body capacity through response preparation and production, without a complete escaped failure-JSON allocation.

**Architecture:** Extend the existing slot with an optional response-production promise. Operation completion and response completion must both precede release.
A transport wrapper owns response production. The protocol codec supplies bounded JSON chunks from the existing canonical failure body.

**Tech Stack:** TypeScript, canonical Zod contracts, Web Streams, Hono, Bun, and the pinned native Workers test runtime.

**Spec:** `docs/spec.md` §§6.1–6.5 and OAB-6.5 criterion 4. This corrects the response boundary in the original blob-integrity plan.

## Approval and baseline

- Baseline: `0a053293eed50e1e99de52cebfe62ed317996310`.
- The owner approves a limited response-lifetime correction and potentially longer 429 refusals.
- Human approval of this plan must precede implementation.
- Keep the existing subagent execution method. Use Sol medium for implementation and Luna high for the task review.
- The existing 846 passing tests characterize the baseline. They do not close R1.

## Global constraints

- Complete only the remaining OAB-6.5 correction. Do not restart the stopped stream-capacity architecture.
- Keep four shared body slots, no admission queue, and `429 admission_limited` with `Retry-After: 1`.
- Keep the 1,000,000-byte inline and 25,000,000-byte blob limits.
- Preserve raw-byte integrity, exact CAS, immutable objects, revocation checks, receipts, and original admission deadlines.
- Preserve complete current text in read-authorized failures. Never expose that text to write-only callers.
- Keep public JSON meanings, statuses, ETags, retry headers, and blob range/content-length behavior.
- Do not add authority calls, dependencies, pins, flags, resource bindings, migrations, staging keys, multipart uploads, or GC.
- Do not access the personal vault or deploy anything. Builds remain dry runs.
- Count application-retained Worker buffers, strings, validation copies, response preparation, and authority values during active operations.
- Exclude native workerd buffers, transport-retained RPC results, and fragments retained by native layers under the final owner decision.
- Report opaque transport, SDK, GC, and allocator costs separately. Do not claim zero overhead or spare isolate capacity.
- Do not claim final network delivery or the last native-owner release from application source completion.
- Do not expand body-slot admission to GET or DELETE in this correction.
- Keep canonical wire shapes and failure policy in `packages/protocol`.
- Parent-owned Backlog, original plan, stopped design, and scratch evidence stay outside the worker source commit.

## Review focus

1. Response construction can fail after the application completes. It must not leak or release a slot twice.
2. A final enqueue is not EOF. Keep capacity until owned production and cleanup settle.
3. Cancellation can overlap a pending read. Observe both before response completion.
4. Escaping can expand one text byte to six JSON bytes. Never construct the complete escaped content.
5. An unread remote body does not prove serving-side retention. Test the actual application producer boundary.

## File ownership

- `apps/worker/src/application/body-budget.ts`: the existing counter and joint operation/response release condition.
- `apps/worker/src/application/text-files.ts`: pass the optional production lifetime into PUT slot acquisition.
- `apps/worker/src/application/blobs.ts`: pass the same lifetime into blob PUT slot acquisition.
- `apps/worker/src/application/history.ts`: pass the same lifetime into append, rename, and restore acquisition.
- `apps/worker/src/transport/mutation-response.ts`: response-production promise and bounded response wrapper.
- `apps/worker/src/transport/files.ts`: wrap body-bearing PUT execution and response creation.
- `apps/worker/src/transport/history.ts`: wrap validated command execution and response creation.
- `packages/protocol/src/codecs/files.ts`: incremental encoding of the already canonical flat failure body.
- `packages/protocol/src/index.ts`: export the incremental encoder through the public package API.
- Existing protocol and Worker tests: regression coverage and retention evidence.
- `docs/spec.md` §6.5: describe the owner-approved preparation/production boundary, not native delivery guarantees.

## Corrective unit: slot lifetime and bounded failure encoding

### Interfaces

Extend the existing application function:

```ts
tryAcquireBodySlot(responseProduction?: Promise<void>): (() => void) | undefined
```

The returned function marks operation work complete. The slot returns only after the optional response promise also settles.
Without that promise, existing direct application callers retain their current behavior. Release remains idempotent.
Observe the supplied promise immediately after acquisition. A rejection must not create an unhandled error.

Add a final optional `responseProduction?: Promise<void>` parameter to:

- `executeTextMutation`, after its existing declaration parameter.
- `executeBlobPut`, after its existing signal parameter.
- `executeFileCommand`, after its existing command reader.

Do not move policy, authority, or HTTP types into these functions.

Add this transport helper in `mutation-response.ts`:

```ts
withMutationResponse(
  execute: (responseProduction: Promise<void>) => Promise<Response>,
): Promise<Response>
```

Its internal completion promise never rejects. It resolves after owned production or cancellation cleanup settles.
The wrapper must not await that promise before returning response headers. That would deadlock response construction.

Add this protocol helper:

```ts
encodeFileFailureBodyChunks(
  body: FileHttpFailure["body"],
): Iterable<Uint8Array>
```

Call `encodeFileFailure` first. The new helper serializes its canonical body, not a second failure-policy definition.
Iterate the existing flat fields. Skip undefined values and preserve booleans and exact string meanings.
Use string windows of at most 8,192 UTF-16 code units. Each encoded output chunk must stay at most 65,536 bytes.
Apply JSON escaping to each bounded window. Preserve surrogate pairs or equivalent escaped code units across boundaries.
Do not stringify the complete content field or create a complete escaped JSON string.

### Response ownership rules

- Acquire slots at their existing application boundary, before reservation and body demand.
- Existing application `finally` blocks mark operation completion after storage, authority, and cleanup settle.
- The transport wrapper creates the response-production promise before application execution.
- Wrap body-bearing PUT and validated append/rename/restore calls. Do not acquire a second slot in transport.
- Create content-bearing failure bodies lazily from canonical chunks through a byte stream.
- Preserve the existing JSON Content-Type explicitly when replacing `Response.json`.
- Use response reads bounded to 65,536 bytes. Permit at most one owned read at a time.
- Apply downstream backpressure. Do not collect encoded chunks or retain a per-chunk history.
- On EOF, clear producer references and release owned reader state before resolving production completion.
- On cancellation or error, observe pending reads and started cancellation before resolving completion.
- If response creation throws, complete the lifetime after existing application work settles.
- A stalled producer can keep a slot charged. Do not reuse it because an admission deadline passes.
- Scope this promise to application-owned preparation/production. Do not invent a native HTTP terminal callback.

### Steps

- [ ] Add slot regressions before changing the implementation.

Tests: `body-budget.test.ts`.
Assert four completed operations still occupy four slots while response promises remain pending.
Resolve one response and assert exactly one slot becomes available. Duplicate releases must not free another slot.
Resolve response production before operation cleanup and assert the operation still owns its slot.
Reject a supplied completion promise and assert observed settlement without an unhandled rejection.

- [ ] Add transport regressions before implementation.

Create `test/mutation-response.test.ts`.
Use controlled byte producers, not actor gates or a delay after RPC delivery.
Cover blocked production, final chunk before EOF, concurrent cancellation/read, construction failure, and cleanup failure.
Assert no early slot reuse and exactly one release after owned work settles.

- [ ] Add protocol serialization regressions before implementation.

Extend `packages/protocol/test/files.test.ts`, or the existing failure-codec test file if its actual name differs.
Compare decoded small results with `encodeFileFailure` for every canonical failure kind.
Cover quotes, backslashes, NUL, BOM, multibyte text, emoji, and surrogate boundaries.
For near-limit control-character content, check streaming digest and length without a complete expected JSON allocation.
Assert every output chunk is at most 65,536 bytes. Assert no whole-content stringify call through a bounded test seam.

- [ ] Run the focused tests and preserve actual functional RED.

Run these commands from their stated workspaces:

```sh
cd packages/protocol
bun run test -- test/files.test.ts
cd ../../apps/worker
bunx vitest run --config vitest.config.ts test/body-budget.test.ts test/mutation-response.test.ts
bunx vitest run --config vitest.http.config.ts test/http/files.test.ts
```

Record assertion failures separately from setup or type failures. Wrap expected RED commands and record their exit codes.
Do not delete working implementation to recreate RED. Record any retained-code exception honestly.

- [ ] Implement the joint slot condition and optional application parameters.

Keep existing operation cleanup and effect-certainty paths unchanged. Do not extend durable admission deadlines.

- [ ] Implement bounded canonical JSON chunks and the transport response wrapper.

Use the interfaces above. Keep the public schema and canonical status/header owner unchanged.
Do not retain original request input or complete response JSON through new closures or observer logs.

- [ ] Wire PUT and command routes through the shared wrapper.

Use the existing canonical codec for failure selection. Keep JSON success receipts and full authorized error content.
No new RPC, weighted admission rule, endpoint handshake, or public field belongs in this correction.

- [ ] Add ordinary HTTP regressions for response production.

Extend `test/http/files.test.ts` and command tests where needed.
Hold four actual application producers. Assert the fifth body-bearing request gets 429 without body demand or admission.
Drain or cancel one producer and assert exactly one reusable slot after cleanup.
Retain the existing unread-body characterization. Do not assume unread client bodies always block server production.
Verify exact decoded failure content, status, headers, and write-only data exclusion.

- [ ] Recompute the clarified application-retention inventory.

Count source backing arrays, strings, validation scratch, active authority values, encoder windows, and application-retained pending producer data.
Use attainable simultaneous phases and actual shared backing. Do not sum mutually exclusive maxima.
Report production observations separately from source bounds and native costs.
Close R1 as intentionally deferred under the final owner decision below, not from four slots or passing tests.
Keep native retention in OAB-6.8.2. Do not restart broad platform research.

- [ ] Update §6.5 with the actual owner-approved preparation/production boundary.

Do not promise client receipt, total RSS, or the last native payload release.

- [ ] Repeat the focused commands, then run these commands from the repository root through the worker shell.

```sh
bun run docs:check
bun run check
```

Preserve exact commands, counts, exits, and full logs. Check production identity isolation and unchanged runtime/resource settings.

- [ ] Run code-review self-review with the TypeScript profile, then commit the corrective source unit.

Suggested message: `fix(worker): retain mutation capacity through response production`.
Do not stage parent metadata, stopped proposals, plans, or evidence artifacts.

- [ ] Get one independent corrective review of the complete resulting paths and retention inventory.

The independent corrective review finds no new source defect at `55e3d65`.
The final owner decision below changes the remaining R1 disposition to intentionally deferred.

## Final gates

### Final owner decision on criterion 4

The owner settles the criterion on 2026-10-20. This decision replaces the earlier native-retention acceptance gates.

> The 32 MiB limit covers only data our application creates and retains: Worker buffers, strings, validation copies, and authority application values during active operations.
> Native workerd buffers, transport-retained RPC results, and fragments retained by native layers remain outside this limit.
> Close R1 as "intentionally deferred" and measure native retention during OAB-6.8 runtime-envelope work in a real deployment.

Source: owner decision on criterion 4, 2026-10-20. The quotation above is an English translation.

R1 disposition: **intentionally deferred**, not a proof of native headroom or a measured heap breach.
Deferred task: **OAB-6.8.2**. Its trigger is native-retention measurement in a real deployment during OAB-6.8 runtime-envelope work.
The existing deployment authorization gate remains in force.

Complete whole-branch review and human diff review. No further criterion proposal or criterion review belongs before this PR.
Then follow the original OAB-6.5 finalization, artifact preservation, push, and PR instructions.
Ask the owner only if `bun run check` fails or a specification change becomes necessary.
Do not merge, deploy, or start another task.
