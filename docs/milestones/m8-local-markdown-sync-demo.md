# M8 — Local Markdown sync demonstration

**COMPLETE on merge of the delivery-3 functional PR; until then M8 remains NEXT.**
Delivery 1 merged in #111, the identity guard in #112 (`cf05833`) and delivery 2
in #113 (`75968a3`). The [delivery-1 plan](../plans/m8-local-sync-api.md),
[delivery-2 plan/evidence](../plans/m8-durable-sync-client.md),
[delivery-3 plan](../plans/m8-experimental-plugin.md) and
[artifact demonstration](../qualification/m8-experimental-plugin-demo.md) track
all three isolated functional boundaries. Original specification baseline:
`main` at `e1297d6973fa93325c3a2e5825a0deddb4967d3e`, including merged #109.
[ADR 0021](../decisions/0021-isolated-local-markdown-sync-demo.md) authorizes only
the synthetic local boundary. This is a functional delivery milestone, not another
M7 qualification-matrix milestone.

## Delivery 1 evidence

The separate local Worker/API implements current/version/create/update/exact replay
and feed over the existing store. Final local `mise install && mise run check`
passed: 2,104 fast tests, 53 native tests and 12 release-plugin artifact tests;
statements 95.01%, branches 91.48%, functions 98.62%, lines 96.83%, unchanged
thresholds. Post-green semantic self-review closed the OpenAPI-failure and
oversized-read findings. The [plan/evidence ledger](../plans/m8-local-sync-api.md)
and [lab guide](../local-sync-demo.md) distinguish native test-clock injection
from real expiry/CPU/platform or desktop qualification. No real R2, deployment,
personal vault or M8 plugin demonstration is claimed. Delivery 1 merged in
[PR #111](https://github.com/moisesmorillo/obsidian-ai-bridge/pull/111) at `f885f0e`
on 2026-10-07. Delivery 2 adds strict content-free durable bases/original requests,
prepared local effects, exact-base reconciliation and a bounded loopback Fetch
adapter, all uncomposed into release runtime. Its integration scenario uses actual
demo HTTP/service/R2-adapter code with deterministic conditional storage, simulated
local hosts and disposable on-disk ledgers: A→B, B→A, REST-origin clean pull,
restart and visible preserved concurrent edits. This is not desktop/plugin-artifact
or native R2 client evidence. Delivery 3 supplies official host/local-state/
SecretStorage, listener/session owner, explicit Sync now/status and separately
built artifact. Its five-flow demonstration uses two isolated simulated plugin
instances/new disposable filesystem-backed Vaults with native local production
Worker/R2. Desktop was not launched; this fallback is explicitly owner-authorized
and is not a host compatibility, real R2 or secret durability claim.

## Outcome and accepted boundary

By Friday 9 October 2026, demonstrate two disposable desktop vaults exchanging
saved Markdown through the existing private SyncStore, a local Worker, and an
experimental plugin artifact. A separately authenticated REST client edits the
same revision domain; the edit reaches the other vault. A concurrent local edit
is never overwritten: retain the local file and a visible excluded remote copy,
with an explicit attention result. REST demonstrates the shared revision domain for this local demo; MCP integration remains out of scope.

The owner accepted a narrow successor to ADR 0020: synthetic loopback-only protocol
composition and explicitly armed disposable-vault local effects may be developed
and exercised without closing remote/production activation gates. G1–G6 remain
OPEN; a demonstrated defect in the exercised path blocks the demo. No gate is waived
for public exposure, real data, deployment, migration, mobile, Workers Free, or
production activation. Only M8 becomes NEXT on merge; M7 qualification remains open.

## Minimum scope

| Area | Contract |
| --- | --- |
| Data | One fresh server-generated vault UUID, two separate disposable desktop vault folders, at most three explicit synthetic ASCII `.md` paths, at most 16 KiB UTF-8 per note. This is a demo admission policy, not a change to M7's 1 MiB/10,000-head bounds. Reject paths outside this set before effects. |
| Local paths | Whole-vault metadata preflight rejects case-insensitive aliases, folders at target paths, exclusions, and ambiguous lookup. ASCII-only demo names avoid claiming general Unicode equivalence support. Existing target content is never silently adopted. |
| Remote authority | The existing marker-gated `createSyncR2Store`, original-parent CAS, immutable versions, operation journal and 64-lane feed. No alternate store, fake production backend or v2 read-through. |
| Authentication | Three separate disposable registry clients using the existing strict bearer verifier and independent read/write permission policy. Bind each configured client to this vault and its own origin UUID server-side. A device/origin UUID is provenance, never authorization. No token, vault selector or origin supplied by note text. No implicit OAuth scope gain. |
| Worker | Separate local-demo entrypoint and local-emulator configuration, loopback listener only; not imported by `apps/worker/src/index.ts` or referenced by the deploy/release configuration. Require explicit synthetic-lab configuration; missing configuration fails closed. Existing v2 and `/mcp` remain unchanged. |
| Plugin | Separate explicitly built experimental artifact/entrypoint, not the release `main.ts`. Reuse official Vault read/create/process/preservation primitives, native SecretStorage and host-local state. Never attach the M3 mirror runtime. Require disposable-vault acknowledgement, loopback endpoint and explicit Sync now. No background/mobile freshness claim. |
| Persistence | Separate strict versioned host-local content-free ledger: vault/device binding, exact ACK revision/hash, original mutation ID/revision/parent/hash, retry floor, prepared local effect, conflict receipt and feed checkpoint. Reject unsupported/corrupt state; never reset it to empty automatically. No changes to frozen M3/M4 state codecs. |
| Local safety | Create-only absent target, or `Vault.process` exact compare-and-replace against the ACK bytes. Preserve and verify the remote competing revision in `ai-bridge-conflicts` before acknowledging conflict handling; never republish that namespace. No local delete, rename or generic filesystem capability. |
| Progress | Explicit Sync now performs bounded progress and reports pending/attention honestly. It may require subsequent invocations at the persisted retry floor; no busy loop, latest-head retry, or sleeps inside Worker requests. |
| Exclusions | Tombstone application, deletions, renames, automatic merge, attachments, enrollment OAuth, migration/v2 fences for imported identities, iCloud cutover, backup service, real R2, scale and mobile qualification. Tombstones encountered by the client stop for attention. |

## Minimal source path

```text
REST lab client / experimental plugin Fetch adapter
    → strict protocol schemas + bearer/vault/origin admission
    → thin Hono demo handlers
    → core sync application service
    → core SyncStore port
    → existing createSyncR2Store → local workerd R2 emulator

experimental plugin Sync now
    → bounded core three-way coordinator + durable demo ledger
    → remote current/version/feed through the same application service
    → official Vault create/process or excluded conflict preservation
    → verified local postcondition → ledger/checkpoint settlement
```

Source owners to reuse, not broaden:

- `packages/core/src/sync/sync-store.port.ts` and `sync-store.types.ts`: nine-method
  storage contract; `sync-mutation-policy.ts`: exact-parent authority.
- `packages/protocol/src/sync.schemas.ts` and `sync.codec.ts`: branded identities,
  vault-bound checkpoints and lane rules. M7 has no HTTP request/response schemas;
  add only the demo transport schemas actually used.
- `apps/worker/src/infrastructure/sync/sync-r2-store.ts`: existing R2 composition.
  Inventory defaults to zero CPU admission. Do not pass an invented CPU allowance
  or label injected allowance as platform evidence.
- `apps/worker/src/auth/credential-registry.ts` and `authenticate-request.ts`:
  reuse verified principals; demo vault/origin binding remains separate policy.
  The client sends paired denial-only identity expectations on each request;
  compare them with that request's authenticated server binding before effects.
  They never select a namespace/origin or imply permission, and a separate
  preflight cannot substitute for the dispatch-time check.
- `apps/obsidian-plugin/src/infrastructure/obsidian-local-reconciliation-writer.ts`
  and `obsidian-local-reconciliation-writer-host.ts`: narrow official effects.
  M8 supplies its own durable authority; M4 review/lease state is not fabricated.
- Current `apps/worker/src/composition.ts` and `mcp/mcp.server.ts` serve v2 only.
  Current `apps/obsidian-plugin/src/main.ts` attaches the one-writer M3 runtime.
  Neither is the new sync composition point.

## Reconciliation and recovery invariants

1. Pull before admitting a new push. For each target compare saved local bytes,
   durable acknowledged base and verified remote immutable revision. Equal text is
   not permission to adopt an unrelated revision or clear uncertain work.
2. A never-seen local create requires a fresh complete absence/alias check, no
   pending intent and complete observation coverage. An initial empty vault never
   grants remote deletion authority. Discovery is restricted to the admitted
   synthetic paths; no claim of complete whole-vault inventory is made.
3. A clean remote update applies only when local still equals its exact ACK base.
   Persist the prepared effect before dispatch, compare inside `Vault.process`,
   and verify saved bytes afterward. A raced local change refuses replacement and
   goes to preservation/attention; mtime is not authority.
4. A local update publishes only at its original exact parent. Persist operation
   identity and hash before dispatch. Stale parent is a conflict, not permission to
   refresh and overwrite. Show API origin from the server's participant binding.
5. `operation_pending`, `effect_unknown` and pre-journal retry floors survive
   restart. Resume an existing journal with the original operation ID. A
   `mutation_not_admitted` retry requires the identical full request; reconstruct
   payload only when saved local bytes still match the persisted request hash.
   Otherwise stop for attention, never invent replacement bytes or a new operation.
   Retain the explicit pre-journal refusal in the ledger. For pending/unknown full
   journal replay only, a verified immutable live version may reconstruct the body
   when vault/path/revision/operation/origin/parent/hash/size all match the original
   tuple; version existence alone is never committed proof.
6. After interruption between a local effect and ledger save, exact prepared
   postcondition may settle that same effect. Divergent or unavailable evidence
   remains blocked. Cold start/listener gaps trigger fresh positive observation;
   they never infer deletion or automatically replay an uncertain local effect.
7. Install listeners before lab effect admission. Retain events occurring during
   sync as successor observations; do not identify own events by path or timing.
   One owner serializes per-path work and retains in-flight settlement through
   unload/re-enable. A stale session cannot dispatch a later local effect.
8. Bootstrap the explicit target set through verified current/version reads;
   initialize the feed cursor at zero for the fresh lab identity. Do not initialize
   at a guessed high-water mark. Advance a page checkpoint only after every event
   is durably classified/applied/preserved. Feed events are discovery hints: reconcile
   the verified current head, never regress a newer ACK by applying a historical
   event's bytes. Expired/invalid cursors stop for review and reset of the disposable
   experiment, not silent checkpoint repair. Automatic
   complete-inventory recovery is deferred, not simulated.

## Reviewable functional deliveries

Each delivery includes focused unit/integration tests, `mise install`,
`mise run check`, semantic/security review and synchronized docs. No test-only
matrix PRs or unrelated cleanup. Dependencies are sequential; no size exception
is requested. Refine file estimates before implementing each delivery and stop
if it would exceed 10 production files or 1,500 net production lines.

| Order | Functional boundary / likely production scope | Independently reviewable invariant |
| --- | --- | --- |
| 1 | Local Worker/API current/version, exact mutation/resume and feed; core service and strict transport contracts; separate lab entry/config/tasks. Target 8–10 production files, 700–1,100 lines. | REST create/update is visible in the real private store/feed. Separate identities/permissions, exact stale-write refusal and v2/release noninterference are testable before plugin work. No public route added. |
| 2 | Durable three-way lab coordinator/ledger contracts and bounded Fetch adapter. Target 7–10 production files, 800–1,300 lines. | Two clients converge against delivery 1, retain original identities/floors and refuse concurrent replacement. Core has no Hono/R2/Obsidian dependencies. This is client behavior, not a replacement SyncStore. |
| 3 | Separate plugin artifact, official host/local-state/secret composition, listeners, Sync now/status and disposable-vault procedure. Refined target ≤10 production files, 800–1,150 lines including the existing Fetch permit accessor and path-policy consolidation. | Real experimental plugin can exercise delivery 2 without M3 mirror activation. Built-artifact checks accompany host safety; finish with the two-vault demo and exact limitations. |

Do not publish stable releases from the local-demo branch. PR titles use
Conventional Commits. No merge or deployment is implied by implementation.

## Acceptance and demonstration

- Start only the new loopback Worker with fresh local emulator state and synthetic
  credentials generated outside tracked files. Confirm the normal release Worker
  exposes no demo routes and the release plugin has no demo activation path.
- Use two newly created disposable desktop vaults if suitable hosts are available;
  never access or install into the owner's existing vault. Otherwise exercise two
  isolated simulated plugin instances. The owner expressly accepts this fallback;
  label it integration evidence, not a two-vault desktop demonstration.
- Create/edit one admitted note in A, run bounded sync in A and B, verify exact bytes
  and shared revision in B; then edit B and verify propagation back to A.
- Make a separately authenticated REST edit at the observed revision and apply it
  cleanly in B. Repeat with B edited locally before pull, including a focused
  preflight-to-`Vault.process` race: B's local bytes stay unchanged, remote bytes
  remain immutable and appear in the excluded conflict copy, attention is visible.
- A stale API write is refused; restart and repeated Sync now neither duplicate
  successful operations nor promote uncertain effects to ACKs. Focused tests cover
  the new persistence/effect boundaries; no exhaustive M7 matrix is claimed.
- Record source/artifact IDs, exact host if exercised, steps, observed results and
  unresolved gates. Logs/status must contain no credentials or note bodies.

## Feasibility, blockers and smallest fallback

This author-run inspection is not independent review or operational qualification.
M7 already limits mutation/resume to 64 actual binding calls per invocation and
feed pages to 100 events; the lab composes one store operation per HTTP request,
without OAuth/KV calls. Preserve those limits; measure the new adapter's calls.
Local-only testing neither requires nor verifies current remote tier limits.
Workers Free CPU, memory and real-binding limits remain unverified and blocking
for any remote claim.

For three paths and two devices, one fresh pull uses at most `2 × 3 × 2 = 12`
current/version requests before retries; one feed page adds two requests. Process
one note body at a time (≤16 KiB each). Page metadata remains bounded by M7's 100
metadata-only events. Per Sync now, enforce a finite request budget (initial target:
32 requests), persist unfinished work and return pending on exhaustion. Storage
history still grows with every committed edit; this is a disposable experiment,
not a retention or sustainable-account claim. Teardown only the isolated lab
state, never arbitrary namespace cleanup.

Implementation waits for this specification PR to merge; the owner has accepted
its bounded successor scope. The engineering schedule depends on the three
functional deliveries fitting their estimates and on safe local host primitives.
Real disposable desktop-host availability determines the evidence level, not
permission to use an existing vault. No promise of Friday completion is supported
by the existing implementation alone. Report any concrete demo-blocking defect or
size/feasibility failure promptly; do not expand qualification matrices by inertia.

If the deadline becomes infeasible, the smallest useful fallback keeps the same
local Worker/R2 and REST revision domain with two experimental plugin instances
in isolated deterministic host doubles, explicit Sync now and conflict preservation.
Report it as local integration evidence, not actual vault/desktop qualification.
Do not substitute the old reviewed-only v2 workflow and call it automatic sync.

## Work checklist

- [x] Inspect latest main/#109, roadmap, governing ADRs and relevant source/tests.
- [x] Identify missing composition, admission and local-effect authority.
- [x] Define minimum scope, alternatives and independently reviewable deliveries.
- [x] Owner accepts written scope and local-only successor gate.
- [x] Record accepted ADR/roadmap transition on the specification branch.
- [x] Owner merges the specification PR; M8 becomes NEXT (#110, `2c96711`).
- [x] Refine implementation work units within the accepted scope; execute locally
  without requesting approval again for routine decisions.
- [x] Implement functional deliveries with focused tests and mandatory checks.
- [x] Perform author semantic review and demonstrate/report only exercised simulated boundaries.

Final [evidence](../qualification/m8-experimental-plugin-demo.md) records 2,244
fast / 53 native / 14 artifact tests, unchanged coverage thresholds and the final
experimental artifact hashes. No subsequent implementation is authorized here.
