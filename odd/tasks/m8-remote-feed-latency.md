# M8 remote feed latency

## Objective and authorization

Resolve the observed synthetic remote plugin `pending` result by making the private feed's committed lane-head scan bounded in wall time, while preserving checkpoint and fail-closed behavior. The owner authorized continued local correction after the third isolated lab. This task authorizes local source, test, and documentation changes only; no further Cloudflare operation or personal-vault access.

## Problem and evidence

The authorized lab C delivered exact note bytes to both disposable Desktop vaults, but two explicit passes each remained `pending` and kept a zero checkpoint. REST create/read/CAS/stale checks passed. The response log lacks a response for each pass's third request. The plugin deadline is 10 seconds; the feed currently awaits all 64 committed lane heads sequentially. Each lane-head read includes marker and head reads. This supports a timeout hypothesis but does not prove Worker timing without another remote measurement. The lab C Worker and bucket were removed and synthetic credentials retired.

## Scope and constraints

- Preserve marker-gated reads, high-water validation, fair ordering, cursor encoding, and fail-closed errors.
- Use a small fixed concurrency bound for independent lane-head reads only. Keep same-key mutations and operation recovery serial.
- Keep the current 10-second client deadline until a measured remote result justifies changing it.
- Update the remote lab specification's blanket sequential-call sentence to state the narrow read exception.
- Keep G1–G6 open; do not claim remote convergence or production qualification.

## Task checklist

- [x] T1 — Add a deterministic concurrency-cap regression, implement bounded lane-head reading, update relevant remote-lab documentation, run focused and full checks, and complete semantic review. Route: delegated direct; mapping and writer triggers fired because diagnosis spans feed, publication, client transport, tests, and docs, and the implementation touches multiple non-trivial files. Work-unit commit: `95d221d` (`perf(worker): bound remote sync feed head reads`).

## Acceptance and checks

- RED: a controlled lane-head fixture proves the current serial implementation does not initiate multiple independent reads; cap is never exceeded.
- GREEN: feed emits the same events/cursor, and unavailable/corrupt heads still fail closed.
- `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-feed.test.ts`, `mise run check`, `git diff --check`, semantic review.
- No remote deployment. A future approved experiment must measure real feed latency and checkpoint settlement.

## Execution settings and delivery

- TDD mode: enabled for this new behavior by repository `AGENTS.md` preference; runner: `mise run test -- apps/worker/tests/unit/infrastructure/sync-r2-feed.test.ts`.
- Delivery strategy: ask-on-risk. Forecast below 200 authored changed lines, excluding generated files; one work-unit commit expected. Branch point: main at branch creation. First RDD review boundary: branch point, if RDD is effectively enabled.
- Progress: T1 complete locally in `95d221d`. RED observed (the serial implementation started 1 read; 4 expected), GREEN 16/16 focused tests, full `mise run check` passed (2,278 fast, 53 storage, 16 artifact tests; typecheck, lint, builds, and 95.03% statement coverage), `git diff --cached --check` passed. Manual semantic review checked the strict publication boundary, typed ordered results, fixed cap below Cloudflare's six outgoing-connection limit, no mutation parallelism, no extra authority, unchanged event/cursor loop, and no new dependency. RDD mode is on (global); committed assessment initially failed because an untracked ODD document required inventory declaration, so preflight was followed. The native medium-risk reliability review was granted, returned no findings, and was acknowledged for `95d221d`. Remote latency and settled checkpoint remain unverified; G1–G6 open. Engram mirror #125 synchronized through `mem_save` after `mem_update` rejected this chat's cwd.
