# M8 durable local sync client implementation plan

> **For agentic workers:** Use executing-plans inline; task checkboxes are the progress ledger.

**Goal:** Persist exact acknowledged bases and original requests, and reconcile synthetic Markdown through merged delivery 1 without silent replacement.

**Architecture:** Core coordinates a single serialized owner over narrow remote, local-effect and ledger ports. Strict protocol decoding and a read-back-verified string-storage adapter persist a separate content-free ledger. A bounded loopback Fetch adapter is uncomposed into release/plugin runtime.

**Tech Stack:** Strict TypeScript, existing Zod, standards Fetch/Web Crypto, Vitest, canonical mise tasks.

**Spec:** [Accepted M8](../milestones/m8-local-markdown-sync-demo.md), [ADR 0021](../decisions/0021-isolated-local-markdown-sync-demo.md). #111 merged at `f885f0e` on 2026-10-07. This client depends on the [identity guard PR #112](https://github.com/moisesmorillo/obsidian-ai-bridge/pull/112), commit `28e7fdd`; owner merge remains pending.

## Global constraints

- Synthetic local-only; maximum three explicit ASCII `.md` paths, 16 KiB UTF-8 each; 32 HTTP requests per Sync now.
- No production composition, personal vault, deployment, deletion, rename, migration, MCP or relaxed G1–G6 gates.
- Content-free versioned host-local state, distinct from frozen M3/M4 codecs; corrupt/unsupported/mismatched state never becomes empty.
- Only a matching committed response acknowledges an original mutation. Version existence alone is not commit evidence.
- One ledger owner per binding. Delivery 3 supplies official Vault/listeners/session fencing, SecretStorage, App-local string storage and UI; this delivery supplies their narrow contracts, not simulated production composition.

## Selected approach and review focus

Use exact-base three-way reconciliation, not last-writer-wins or the existing reviewed v2 workflow. Recovery replays the full original tuple. Explicit pre-journal refusal requires unchanged saved bytes; uncertain journal replay may reconstruct from a fully tuple-matching verified immutable version, never infer commit from its existence. No durable note body or token.

| Condition | Required behavior / owning task |
| --- | --- |
| Cold restart after dispatched mutation and subsequent edit | Same IDs/parent/hash/floor; reconstruct only exact immutable tuple; task 2 |
| Crash after local write, before ACK persistence | Prepared target may settle by exact postcondition; divergent bytes never replay the local effect; task 2 |
| Local edit during compare-and-replace | Atomic refusal, retained local bytes, verified excluded remote preservation and visible attention; task 2 |
| Existing equal-text untracked target or remote tombstone | No implicit adoption or deletion; task 2 |
| Persistence failure, cursor expiry, malformed/oversized response or endpoint redirect | Fail closed, no checkpoint repair, no secret forwarding, finite request/body/deadline budgets; tasks 1–3 |

## File ownership / size forecast

Ten production files maximum, about 1,000–1,350 net production lines (final observed delta 1,315):

- Core: `sync-demo-client.types.ts` (content-free states), `sync-demo-client.port.ts` (capabilities), `sync-demo-client.ts` (serialized reconciliation/feed), `sync-demo-client-effects.ts` (prepared-effect/original-request execution), `index.ts` (public exports).
- Protocol: `sync-demo-client.schemas.ts` (strict ledger codec/config admission), `sync-demo.constants.ts` (shared admission ceilings), `index.ts` (exports).
- Plugin infrastructure, uncomposed: `demo/sync-demo-ledger.ts` (verified string persistence), `demo/sync-demo-fetch.ts` (bounded loopback transport).
- Tests accompany behavior in dedicated core/protocol/plugin/Worker test trees. Integration uses disposable temp ledger files and existing real Hono/service/conditional R2 composition; host doubles are labeled accurately.

Stop/split before crossing repository production caps; no production-scope exception. Review-budget overage is disclosed separately below. Branch `feat/m8-durable-sync-client` in the existing clean checkout; no worktree created or machine configuration changed. Native execution follows the owner's standing authorization to refine and implement routine M8 choices without another approval round.

## Task 1: Durable content-free state boundary

**Interfaces:** `SyncDemoLedger` binds vault/device/paths/zero-origin cursor; each entry retains base and one original push/prepared apply/conflict state. `SyncDemoLedgerStore.load/save` never publishes an unverified write. `SyncDemoStringStorage.read/write` is the sole host-local persistence seam.

- [x] Write tests rejecting corruption, unsupported version, secret/body fields, wrong binding/path set, duplicate identities and invalid vault cursor; persistence lost-write/read-back must refuse publication.
- [x] Run `mise run test -- sync-demo-client sync-demo-ledger`; observe missing boundary, then implement strict schemas/ledger adapter/types/ports and exports.
- [x] Prepare the cohesive functional client with its tests, boundary documentation and final check evidence; focused type/static checks have passed.

## Task 2: Exact-base coordinator and durable effects

**Interfaces:** `SyncDemoClient.syncNow(): Promise<SyncDemoClientOutcome>` serializes passes. `SyncDemoLocal` supplies fresh complete alias-safe reads, atomic expected-bytes apply, create-only excluded preservation/read-back. `SyncDemoRemote` supplies current/version/mutate/feed, `beginPass()` resets its finite budget. Platform-free effects use the same ledger/store as task 1.

- [x] Write tests for initial create, absent import, clean pull, original-parent push, two-way edits, concurrent divergence/race, preexisting target refusal, restart/floor recovery, corrupt/unavailable state, save failure, prepared postcondition, historical feed non-regression and checkpoint withholding.
- [x] Implement minimal coordinator/effect executor; initial missing-module RED is not behavioral evidence. Later pre-journal/digest/linkage assertion regressions executed; no retry loops or guessed ACKs.
- [x] Finish the canonical rerun with behavior documentation; final evidence is recorded below.

## Task 3: Bounded Fetch and functional local API integration

**Interfaces:** `SyncDemoFetchRemote` implements task 2's remote port, reads the bearer only at dispatch, validates operation-specific responses and checkpoint/identity linkage, and bounds request count, response bytes and timeout including body consumption.

- [x] Write transport tests for loopback admission, redirect denial, non-JSON/invalid UTF-8/oversize/timeout, wrong-operation bodies and budget exhaustion; initial import RED followed by real deadline/aggregate-response assertion RED and correction.
- [x] Compose two clients against delivery 1 in an integration test with disposable on-disk ledger state. Demonstrate A→B, B→A, REST-origin clean pull, conflict retention and restart. Label deterministic conditional R2/host doubles, not native R2/desktop evidence.
- [x] Run `mise install && mise run check`, inspect diagnostics/coverage/build outputs, then manual semantic/security review of the current diff and relevant invariants.
- [x] Synchronize lab guide, milestone, roadmap, architecture/current-state evidence; open a Conventional Commit PR for manual owner merge. Delivery 3 and two-vault artifact demonstration remain pending.

## Evidence and rulings

- Verified #111 MERGED on 2026-10-07, merge `f885f0e`; fast-forwarded clean main, created the delivery-2 branch. No worktree or machine configuration created.
- Initial strict schema test failed on the absent public boundary, then schema/verified ledger tests passed. Coordinator/Fetch scenario suites were written before their new modules; initial import failures were followed by executed behavioral checks. Do not describe missing-module errors as behavioral RED evidence.
- The first complete functional focused run passed 55 tests, including actual demo API composition, two simulated local hosts and cold on-disk ledger reload.
- First canonical run found Biome import-assist/non-null diagnostics; these were corrected, without changing validation configuration.
- Canonical rerun `b2173ee52` passed 2,159 fast tests but failed statements coverage at 94.76% (95% threshold unchanged). Added focused critical refusal/interruption/metadata/transport cases for the new client; no coverage exclusion or threshold relaxation.
- Aggregate budget review exposed an overridable deadline and oversized schema-valid persisted whitespace. Tests `bounds persisted input before parsing...` and deadline `10001` failed with actual assertions (RED); added a 16-KiB encoded ledger ceiling and maximum 10-second inclusive deadline. Subsequent focused/type/lint checks passed.
- Intermediate canonical gate `b9e93f7dd` passed 2,196 fast, 53 native and 12 artifact tests; coverage 95/91.45/98.61/96.86%. Review corrections below require fresh final evidence, not reuse of that green result.
- Author review found actual assertion REDs for pre-journal immutable reconstruction and a 100-event maximum-path response (102,538 canonical bytes). Persisted certainty now restricts pre-journal replay to unchanged saved bytes; the response ceiling is derived independently of the request ceiling. The 100-test focused run, typecheck and lint passed these corrections.
- The integration registry initially failed because all participant names were equal; the existing complete-registry uniqueness validator identified the fixture defect. Only fixture names changed; authentication policy/permissions remain intact.
- Test-only Worker Vitest alias permits composing unexported plugin adapters in integration tests; no production cross-package private import or runtime composition added.

### Aggregate local budgets (author review, not platform qualification)

| Resource | Worst-case admitted work / behavior at the bound |
| --- | --- |
| HTTP calls | At most `3 paths × 3 current/target/base-or-mutation calls × 2 phases + 1 page = 19` for a fully settled pass; a stale original replay may need 4 calls for one path but stops for attention before feed settlement. Adapter hard-cap 32; exhaustion retains pending work without ACK/cursor repair. |
| Worker binding calls | Separate HTTP requests retain delivery 1/M7 authority: ≤64 store calls per mutation plus bounded fresh marker preparation (delivery-1 observed ≤69 including bootstrap). `32 × 69 = 2,208` is a conservative across-request total, not one Worker-invocation subrequest claim. No remote tier is qualified. |
| Time | Configured serial transport timer budgets total ≤`32 × 10 s = 320 s`, not a preemptive whole-command SLA; host I/O, cryptographic work and scheduler stalls remain unqualified. No Worker/client sleeps or automatic retry loops. The first timed-out unsettled request retains its permit, preventing subsequent dispatch. Explicit later commands obey the persisted original epoch floor. |
| Bodies/state | Each transient note ≤16 KiB UTF-8. Local, target and exact base may coexist: up to `3 × 16 KiB` decoded body bytes, not a one-body-at-a-time memory claim. Canonical encoded response ≤127,296 bytes: max(102,400 escaped-live allowance, 100 × (720-byte ASCII path + 512-byte metadata allowance) + 4,096-byte cursor/page framing). Oversize or whitespace-expanded encodings are rejectable. Request ceiling remains 102,400 bytes. Ledger UTF-8 ≤16 KiB before parsing, including three maximum-length paths/original requests and one 64-lane checkpoint. JavaScript allocation/desktop memory is not qualified. |
| Storage growth | One ledger per participant is bounded and content-free. Existing immutable remote history and create-only conflict copies grow with edits; no retention/account/backup sustainability claim or cleanup capability. |

Rollback and future composition remain under the accepted synthetic-only boundary. No desktop, plugin-artifact sync, native client R2, Workers Free, deployment or real-data result is claimed.

Rollback: remove this uncomposed client/codec/adapter capability and its exports/tests/docs without reverting merged delivery 1 or touching release state.

### Author semantic review and review-size pass

This is an **author review**, not independent review. The affected owners, their
behavioral tests, actual HTTP composition and current-state documentation were
reviewed after the intermediate canonical gate. Follow-up regressions cover
altered reused ACK metadata, missing preserved-copy versions, invalid digest
provider output, duplicate request identities and foreign-binding saves. Final
canonical evidence must supersede the intermediate run.

- Core classifies closed state; effects persist, dispatch and verify postconditions;
  the codec rehydrates without repair; adapters own HTTP/string storage. Recovery
  uses a closed-key exhaustive typed map, never fresh-work fallthrough. One
  classifier owns transient observation-error policy.
- No weak application records/casts, deprecated API use, new dependencies,
  unbounded control loops or raw application logging were introduced. Important
  fields/constants and private declarations have responsibility-bearing TSDoc.
  Framework/host objects stay outside core; release composition is unchanged.
- No body/token is representable in state. Original identity/parent/hash/floor/
  certainty survive restart. Prepared local effects only settle exact saved
  postconditions; unchanged local/base and verified immutable linkage precede
  replacement. Conflicts retain both versions, latch attention and withhold
  checkpoints. Late network work retains exclusion.
- **Intentional deferral:** the merged Worker's synthetic path predicate and new
  persistence refinement encode the same normalized ASCII/length/extension/
  excluded-root policy. They are currently aligned and behaviorally covered.
  Consolidating their protocol authority would touch an eleventh production file;
  do it with the next affected path-admission/composition change, before altering the
  rule. This scoped prototype debt never permits changing either gate independently.
- One honest slicing pass considered ledger/codec, core recovery and transport/
  integration separately. Each stays over 400 changed lines with its verifying
  tests/docs; primitive-only PRs defer the requested functional evidence. Retain
  the accepted functional chain: #111 API → #112 identity guard → **this durable
  client** → official plugin/demo. Request maintainer `size:exception` acceptance for this cohesive
  delivery; never compress code or split away safety tests/docs. Production scope
  remains ten files/about 1,300 net lines, below the hard 1,500-line cap. The final
  PR reports actual additions + deletions and this review map.

### Final verification

`mise install` and canonical gate `b226ae2ed` passed after the certainty/byte-budget
corrections: 2,205 fast, 53 native and 12 artifact tests; coverage statements/
branches/functions/lines 95.04/91.49/98.61/96.90%. Static/type/TSDoc/build checks
passed with unchanged thresholds. This proves the then-current tree, not the
subsequently added intended-vault/participant binding regressions. Corrected
actual-HTTP fixtures returned `committed` under both mismatches (RED); this exposed
a genuine first-create/ACK association flaw, not server authorization bypass.
Adding its API guard here would cross ten production files, so PR #112 supplies
that independent denial-only prerequisite. Client headers now assert the original
vault/participant in every dispatch, and only strict HTTP 400 `binding_mismatch`
becomes invalid-input attention, never an error-status ACK. An actual-HTTP token
rotation case also verifies a prior request cannot substitute for this guard.
Final correction gate `b42bb417c` passed: **2,221 fast / 53 native / 12 artifact
tests**, coverage statements/branches/functions/lines **95.04/91.50/98.61/96.90%**.
All Biome diagnostics/assists, type-aware lint, TSDoc (271 production files),
typecheck and builds passed, thresholds unchanged. The focused run passed 109
tests. Post-gate author review rechecked original-tuple/immutable linkage,
read-back fencing, prepared-effect settlement, closed recovery dispatch, scoped
refusal decoding and architecture/privacy boundaries; no blocking finding remains.
The explicitly documented path-policy consolidation deferral remains. No actual
host/tier qualification or deployment is claimed.

Published [PR #113](https://github.com/moisesmorillo/obsidian-ai-bridge/pull/113),
code commit `702621c`, against PR #112's branch. Merge #112 first, then retarget
#113 to `main`; no automatic merge. Initial functional delta: 3,414 changed lines,
ten production files/1,315 net production lines; review-size exception acceptance
is requested in the PR. This plan's publication update does not alter runtime.
