# ADR 0017: Durable R2 publication attempt claims

## Status

Accepted for isolated M7.4 implementation only. This does not activate synchronization, authorize deployment, or qualify Workers Free runtime/CPU; the M7 implementation and separate live qualification gates still apply. The owner authorized the narrowly bounded head-refusal receipt exception after its causal-race review.

## Context

M7 allocates one immutable feed position to a mutation, then persists the immutable revision/event, conditionally advances the current head, commits the operation journal, and commits the lane head. R2 provides per-key conditional writes, not a multi-key transaction or a cancellation fence for requests already in flight. A resumed operation can be invoked concurrently by multiple isolates. The prior retry-floor journal does not uniquely identify which resumer may issue the next external write.

## Decision

Give each allocated external-write step a strict journal attempt substate: `ready`, `attempting(claimId, generation, claimedAtEpochMs)`, or `retry_wait(claimId, generation, observedAtEpochMs)`. Persist a unique claim by exact operation-journal CAS before a target PUT. Only its creator may dispatch that one target write; a new resumer observing `attempting` reads exact target state and records either verified progress or a fixed retry floor, but never replays the old claim. A retry uses a fresh claim/generation and the original target bytes and external CAS condition. Never sleep or run a retry loop in a Worker invocation.

Pending responses retain the **maximum independently known retry floor** when a concurrent journal generation supersedes the caller's snapshot. A lower peer `retry_wait` floor, or a floorless `commit_journal` phase, cannot erase a locally known target/journal response or planned deadline. Unsafe response-floor evidence remains typed uncertainty rather than being hidden behind a valid lower peer floor. This merge changes only deferred scheduling evidence; it grants no claim, journal rewrite, target PUT, or terminal outcome authority.

Keep terminal journal status and all outcome/position/identity fields fixed while the terminal `commit_lane` attempt state and retry floor advance. This is a narrowly scoped status-preserving journal CAS; it does not refresh the lane-head ETag. If O's lane commit response is lost and a later same-lane operation has advanced the head, that later generation can evidence O's commit only after O's exact terminal journal, immutable event, and current evidence validate. The lane must have O's sequence with O's exact committed clock, or a greater sequence with a strictly later committed clock. Missing/divergent evidence stays unknown; the later head never supplies a new ETag or authority to write O's lane target. Treat operation-journal schema v2 as strict: schema-v1 journals are unavailable/unknown and are not implicitly initialized, repaired, or migrated. Lane and event records remain schema v1; protocol major remains 1.

A `write_head` that remains `ready` at generation zero has acquired no head-PUT authority. If a fresh exact linked current-head read proves the original parent is stale while the matching lane reservation remains pending, a dedicated publication-facade transition may persist only the canonical reserved aborted `create_event` step. It revalidates the exact journal generation, lane reservation, and linked head bytes before its CAS; generic `replaceJournal` cannot perform this edge. No head claim or PUT is made, and a later event invocation rechecks stale-parent evidence before publishing. A changed, missing, or unavailable current head leaves the operation blocked. This no-target shortcut does not authorize aborting any claimed write step.

A generation-one claimed `write_head` refusal may persist exactly one Worker-private, create-only, strict ≤8,192-byte operation-bound receipt when the original head preflight rejected before dispatch or the conditional head PUT returned `null`. This is the sole exception permitting a head PUT and a second external target PUT (the receipt) in one invocation; no event or second head PUT is allowed. The receipt fixes its original claim, head key/target digest/precondition, reservation, refusal provenance and exact competing head. Only a current exact generation-one `attempting` journal claim, matching pending lane and still-stale linked competitor may CAS that *same journal generation/ETag* to an abort-only event step. A newer claim, uncertain head response, mismatched receipt/head, unavailable evidence, lost journal CAS without exact read-back, or failed receipt remains `effect_unknown` with the lane blocked. Receipt and journal CAS are not atomic; the receipt alone is never terminal evidence. If the target-digest capability fails during receipt creation or settlement, the facade returns typed `effect_unknown` without dispatching a receipt PUT or journal CAS; hashing failure cannot grant authority or escape as an untyped rejection. A rejected current-head read during receipt creation or recovery likewise returns `effect_unknown` before receipt PUT or journal CAS; a transport exception is not proof of refusal, staleness, or successful publication. Worker-only write access is part of the trust boundary; an R2 administrator able to forge typed private records is not authenticated by a visible claim ID. A receipt remains for the lifetime of its operation journal; no mutation/feed records are reaped in M7. The exceptional path must fit an invocation-scoped 64-call R2 boundary, count all nested reads/writes, and fail closed at account or call-budget exhaustion. Neither code-derived call estimates nor local tests constitute the separate Workers Free 10-ms CPU qualification. The M7 spec's post-journal authority matrix is normative for schema, recovery and tests.

A later exact read of the original target does not prove an older R2 request was canceled. Late requests remain bound to the same bytes and original ETag/create-only condition; one may win and others must reconcile as losers. Retry floors constrain when a new attempt begins, not how many already-issued physical requests exist.

## Consequences

Same-ID concurrent resumptions cannot both obtain a journal claim for a generation, and recovery never treats another isolate's `attempting` marker as permission to write. This adds journal CAS/read-back work and can return `operation_pending` across invocations. A claim is application authority, not an R2 lease or guarantee of one physical request in flight. The M7 spec estimates a worst one-step invocation at roughly 37–41 GETs and no more than three PUTs, depending on exact refusal/recovery evidence; fake-R2 counters must establish the actual path counts. This arithmetic does not qualify live Worker support or the Workers Free 10 ms CPU envelope.

## Alternatives

- Use a process-local mutex: rejected because it does not coordinate independent Worker isolates.
- Allow every resumer to replay a conditional target write: rejected because it multiplies in-flight requests and complicates uncertain-effect ordering even where CAS prevents replacement.
- Add a renewable R2 lease or a second coordination object: rejected for this bounded M7 design; it adds cross-key authority and lease-expiry semantics without canceling an already-issued write.
- Interpret old journals as `ready`: rejected because a v1 journal cannot prove that an external step was never dispatched.

## Evidence / related documents

- [M7 specification — post-journal attempt authority](../milestones/m7-versioned-sync-protocol-and-r2-store.md#post-journal-attempt-authority)
- [M7 implementation plan — Task 3](../superpowers/plans/2026-09-29-m7-complete-sync-store.md)
- [ADR 0016 — Bidirectional vault synchronization](0016-bidirectional-vault-sync.md)
