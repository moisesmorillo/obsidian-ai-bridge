# Global Admission Budget Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for this correction. Track each step with checkboxes.

**Goal:** Bound durable admission storage across all clients before Task 2 acceptance.

**Architecture:** The existing SQLite authority enforces one aggregate row budget inside each insertion transaction.
Reservations, active tickets, uncertain tickets, and expired rows share this budget.
Binding and completion keep their current behavior.

**Tech Stack:** Existing Bun, TypeScript, Zod, Drizzle ORM 0.45.4, development-only Drizzle Kit 0.31.11, and native SQLite Durable Objects.

**Spec:** `docs/spec.md` §§5.2, 6.3, and 12.
**Task:** OAB-6.2, Task 2 correction.
**Parent plan:** `docs/superpowers/plans/2026-10-17-f1-authorization-tickets.md`.
**Frozen product head:** `e5113dcf032fe52d5c237ef241f31b114bf538f9`.

## Approval Boundary

The owner selected an aggregate admission limit instead of deferred work.
The parent proposes the numerical budget and behavior below.
These details await human approval of this plan.

This correction closes the shared design gap in CR-1 and DF-1.
DF-2 also needs dated primary platform evidence and explicit tier assumptions.
Task 2 remains unaccepted until validation and corrective review close these findings.

## Global Constraints

- Use the existing feature worktree and retained Task 2 writer.
- Preserve all constraints in the parent plan.
- Keep the 16-slot client limit and original 60-second deadlines.
- Keep caller expiry cleanup followed by at most 64 global expired identifiers.
- Keep the canonical protocol shapes and private binding boundary.
- Add no route, dependency, schema migration, alarm, SDK shim, or production fault control.
- Keep Task 3 consumption and revocation work separate.
- Use functional RED before behavior changes.
- Get human approval before implementation.
- Keep all four Backlog acceptance criteria unchecked.

## Proposed Contract

1. Each vault can store at most **1,024 admission rows** after a successful insertion.
   This is a hard row limit, not a client population limit.
   All clients, grants, states, and expired rows count.
   Idle expiry does not remove rows or lower this count.

2. Both `reserve` and direct `authorize` enforce this limit.
   Their transaction order is policy, safe time, expiry cleanup, client budget, vault budget, identifier selection, and insertion.
   Neither budget denial calls the identifier port.
   Concurrent calls through separate stubs share the same SQLite authority.

3. Use the existing `admission_limited` failure.
   Keep its existing positive `retry_after_seconds` field.
   Do not add public HTTP behavior or a new protocol variant.
   The client budget takes precedence when both budgets deny admission.

4. At global capacity, use the earliest retained expiry across the vault.
   Calculate `max(1, ceil((earliest_expiry - now) / 1000))`.
   An expired backlog yields a one-second delay if cleanup still leaves the ledger at capacity.
   Retry does not promise future capacity.

5. Count all stored rows with a capped SQL subquery.
   Read at most 1,024 rows inside that subquery and return one aggregate count.
   Do not transfer ledger rows into a Worker array.
   Query the earliest expiry separately only when the global budget denies admission.
   Use the existing expiry index.

6. Binding at global capacity remains valid for an owned, unexpired, matching reservation.
   Binding changes no identifier, deadline, ownership, or row count.
   It does not run cleanup or charge a second slot.

7. Settled completion releases its owned row.
   Uncertain completion retains its row and original deadline.
   Policy denial occurs before cleanup.
   Thrown storage and entropy errors roll back earlier cleanup.
   Returned canonical denials can commit lawful cleanup.
   Preserve returned `invalid_request` results for malformed identifiers or eight exhausted collisions.

8. Starting with an empty or compliant store, every transaction preserves the global limit.
   An over-budget test store must reject insertion after bounded cleanup unless its count falls below 1,024.
   Do not delete live rows, reset a store, or add a repair path.

The proposed budget lets 64 clients hold all 16 client slots at once.
It also lets more clients when each holds fewer slots.
Expired rows can reduce the available slots until bounded cleanup removes them.

## Platform Evidence and Resource Budget

The parent read primary documentation on **2026-10-17**:

- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/):
  100 bound parameters per SQL query, 100 columns per table, and 2 MB per string, BLOB, or row.
- The same source lists 10 GB per SQLite object on Workers Paid and 1 GB on Workers Free.
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/):
  `sql.databaseSize` returns database bytes.
  `transactionSync` rolls back a callback that throws.
  The callback must stay synchronous.

The current account tier remains unverified.
Admission budgets use the smaller 1 GB storage limit.
The existing 2 GB product envelope needs Workers Paid and includes admission storage.
The total envelope, alert threshold, and product capacity behavior remain separate from platform hard-cap failures.
This correction does not claim full-product Free support or authorize deployment.

| Resource | Bound or calculation | Limit and headroom |
| --- | --- | --- |
| Stored rows | At most 1,024 after insertion | Independent of client population |
| Row values | 32 + 2,048 + 2,048 + 32 + 64 + 16 + 9 = 4,249 bytes | Below 2 MB per row |
| Aggregate row values | 1,024 × 4,249 = 4,350,976 bytes | Excludes SQLite records, pages, and indexes |
| Ledger storage target | At most 32 MiB measured growth over an empty initialized fixture | Below 1 GB Free and 10 GB Paid |
| Insertion SQL calls | At most 2 policy + 3 cleanup + 1 client count + 1 global count + 8 collision reads + 1 insert = 16 | No network calls or subrequests |
| Global denial SQL calls | At most 2 policy + 3 cleanup + 1 client count + 1 global count + 1 earliest expiry = 8 | No entropy call or insertion |
| Client denial SQL calls | At most 2 policy + 3 cleanup + 1 client count + 1 client expiry = 7 | Client-first denial skips the global count |
| Binding SQL calls | Existing maximum of 5 | No new count or cleanup |
| Completion SQL calls | Existing maximum of 4 | No new count or cleanup |
| Largest binding list | 64 identifiers for global deletion | Below 100 parameters |
| Global count | At most 1,024 scanned entries and one result row | No full-ledger application allocation |
| Cleanup selection | At most 64 identifiers | At most 2,048 identifier characters before container overhead |
| Preparation | Existing 16 KiB envelope | No body bytes or full-vault materialization |

The 32 MiB storage target includes index and page overhead.
It remains unmeasured until the native regression test passes.
It is a native test budget, not a new runtime database-size guard.
The row limit and field limits are the runtime growth controls.
SQLite can retain free pages after cleanup.

Record the empty initialized baseline, absolute peak, peak delta, and final retained bytes.
Sample after each storage-changing transaction across all three cycles.
Use fresh maximum-length client and grant values during refills.
Keep every client within 16 slots.
Stop for budget review if the measured target fails.
Do not silently increase the target or decrease identifier limits.

The capped aggregate bounds only the global count query.
Caller cleanup still deletes all caller-expired rows.
Client counting remains an uncapped aggregate.
Those operations depend on the existing compliant-store client invariant.
Synthetic or historical over-budget stores do not gain a universal row-work bound.

CPU duration remains unmeasured.
The plan bounds SQL work and allocations, not latency or concurrent body memory.
OAB-6.5 and OAB-6.8 keep their existing broader resource work.

## Review Focus

- Two stubs race for the final vault slot across different clients.
- Reserved, active, uncertain, and expired rows share one physical budget.
- Global saturation must not stop valid binding or owned settlement.
- Expiry recovery must preserve live rows and the existing cleanup batch.
- Failed insertion or entropy must restore cleanup at the global boundary.

## Task 2 Correction: Aggregate Durable Budget

**Files:**
- Change `apps/worker/src/infrastructure/sqlite/admission.ts`.
- Create `apps/worker/test/vault-admission-global-limit.test.ts`.
- Reuse `apps/worker/test/fixtures/admission.ts`.
- Change fixture helpers only if the new tests need a shared native helper.
- Change `docs/spec.md` §§5.2 and 12 to state the aggregate limit and platform tiers.
- Change §6.3 only if its admission wording needs the aggregate limit.

**Interfaces:**
- Consume the existing `reserve`, `authorize`, `finish`, prepared fingerprints, and canonical failure types.
- Keep their signatures unchanged.
- Add a private `checkVaultLimit(tx: VaultTransaction, now: number): AdmissionFailure | undefined` helper.
- Define one private `MAX_VAULT_ADMISSIONS = 1024` constant for production policy.
- Keep independent literal boundary assertions in tests.

- [ ] Write native saturation tests for reservation and direct authorization.
  Seed 1,023 valid rows across clients, grants, and all three states.
  Race two distinct clients through two stubs.
  Use live production time for RPC fixtures.
  Assert one success, one `admission_limited`, a positive retry delay, and exactly 1,024 rows.
  Assert a new empty client also gets no slot at global capacity.
  Assert no content table changes.

- [ ] Write native retry and compatibility tests.
  Assert global retry uses the earliest vault expiry, not the caller's nonexistent expiry.
  Assert client denial keeps its current precedence and retry calculation.
  Assert a full-ledger denial never calls the identifier port.
  Assert valid binding still succeeds at capacity with the original row and deadline.
  Assert uncertain completion does not free capacity.
  Assert owned settlement frees exactly one slot.

- [ ] Write native expiry and failure tests for both insertion paths.
  Use canonical fingerprints and original ownership.
  Assert exact deadline recovery and preservation of every live row.
  Seed an over-budget expired backlog and assert bounded cleanup with no new row while capacity still fails.
  Assert the backlog retry is one second.

  Test cleanup that reduces an over-budget store to exactly 1,023 retained rows.
  Assert both insertion paths then succeed and leave exactly 1,024 rows.
  Use existing test-only native failure controls for insertion and entropy exceptions.

  Assert complete caller/global snapshots return after thrown-error rollback.
  Preserve current returned-denial behavior for malformed identifiers and exhausted collisions.
  Include successful cleanup controls with the same eligible rows.

- [ ] Run the focused new tests through the parent.
  Wrap expected failure so the shell task exits zero and records the observed test exit code.
  Record reached assertion failures before production edits.
  Label immediately passing cases as baseline coverage.

- [ ] Add the private vault budget check inside both insertion transactions.
  Use one capped Drizzle count query and the existing expiry index.
  Preserve binding, completion, policy ordering, cleanup, and exception behavior.
  Update the specification with this approved contract.

- [ ] Add a native storage-budget regression test.
  Use 1,024 rows with 2,048-byte client and grant identifiers.
  Keep each client within 16 rows.
  Keep fixture inserts at 100 or fewer SQL parameters per statement.
  Record the empty initialized `sql.databaseSize` baseline.
  Measure absolute bytes after each storage-changing transaction.
  Repeat saturation, expiry, cleanup, and refill for three cycles.

  Use fresh maximum-length client and grant values for each refill.
  Assert row counts and peak growth at or below 32 MiB.
  Record absolute peak bytes, peak delta, and final retained bytes.
  Stop for budget review if the target fails.
  Do not change the cap, target, or identifier limits without approval.

  This test measures storage and needs no invented behavioral RED.

- [ ] Complete self-review and return a frozen report with exact changed files and evidence.
  Use bounded read-before-edit patches.
  Preserve the earlier recovered admission test and private evidence.

- [ ] Run focused native admission, storage, and new global-limit tests.
  Run `bun run check`, `backlog doctor`, and `git diff --check`.
  Use Wrangler dry-run only.

- [ ] Commit the validated correction as `fix(worker): bound aggregate admission storage`.
  Freeze the exact base/head package.
  Get independent scoped code and design correction review with Luna medium.
  Give CR-1, DF-1, and DF-2 one evidenced disposition each.
  Retrieve the saved review and let the parent adjudicate it.
  Accept Task 2 only after every blocking finding closes.

## Self-Review

- One policy constant and one relational owner define the aggregate budget.
- New behavior has explicit RED, GREEN, rollback, race, and resource tests.
- No canonical protocol shape or schema version changes.
- Tier evidence separates product policy from platform limits.
- Task 3, final branch review, human diff review, and publication gates remain unchanged.
