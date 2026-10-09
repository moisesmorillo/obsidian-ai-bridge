# Remote synthetic lab — local delivery evidence

**Local implementation only. No Cloudflare operation or Desktop installation.**
Baseline: updated `main`/`origin/main` at #114, `eef552a`; M8 local already complete.
The [remote contract](../milestones/m8-remote-synthetic-lab.md) and
[ADR 0022](../decisions/0022-isolated-remote-synthetic-lab.md) authorize two functional
units, not deployment. See the [authorization recipe](../remote-sync-lab.md).

## Functional units and rollback

| Unit | Boundary | Rollback |
|---|---|---|
| Worker | Standalone `remote/index.ts`, new `REMOTE_*` bindings/config; HTTPS/stop/one-hour TTL; auth/permission/identity then single-use R2 ticket; aggregate call/PUT-byte ceilings | Remove only remote root/config/build task and its optional demo transport capability; keep original local store/API and release |
| Plugin | Distinct `ai-bridge-synthetic-remote` artifact, profile/config/owner/ledger/tickets/native selector; original endpoint pinned and ticket persisted before Fetch | Remove remote artifact/profile/build task; retain local profile defaults, local ledger and all release code. Never redirect or clear uncertain remote state |

Worker touches 10 production/config files, plugin touches 8, with `.mise.toml`
shared by both units; both are well below 1,500 net production lines. Tests/docs
travel with functionality. No preparatory/tests-only PR. The Worker unit's
review diff is about 1,200 authored changed lines, mostly security regressions/docs;
the plugin's parameterized native artifact test moves/indents an existing scenario
rather than adding a scale matrix. These coherent units exceed the skill's
400-line review budget: recommend maintainer `size:exception` before opening their
PRs, rather than stripping tests/docs or creating more preparatory PRs.

## Executed local checks

- `mise install && mise run check` passed on the combined local candidate:
  **2,276 fast tests / 53 native storage tests / 16 artifact tests**.
- Coverage without changing thresholds: statements **95.03%**, branches **91.50%**,
  functions **98.58%**, lines **96.87%** at the first complete candidate checkpoint.
- Focused Worker/plugin regression pass: **98 tests / 6 files**. Compiler, Biome
  diagnostics/assists, deprecated-API lint and TSDoc presence clean.
- Artifact scenarios run the actual generated CommonJS plugin bundles with two
  independent simulated official-host realms and new filesystem-backed disposable
  Vault doubles against native local workerd/R2. The *same* five-flow scenario runs
  for loopback and synthetic HTTPS profiles: A→B, B→A, REST→B, cold simulated
  restart and conflict preservation with unchanged local bytes, one excluded remote
  copy, attention and no optimistic checkpoint/ACK. No Internet Fetch occurs.
- Worker integration proves new-ticket replay retains original store tuple, auth
  and mismatched identities reject before storage, concurrent/fresh-instance ticket
  claims permit at most one admission, lost claim replies do not refund slots,
  invalid/exhausted tickets refuse, call 513 and PUT-byte excess are never dispatched.
- Explicit expiry race: RED returned HTTP200 after clock expired during claim;
  corrected post-await gate returns HTTP503 with exactly one consumed claim and no
  store read. Stop does not claim cancellation of previously dispatched effects.

Earlier red checks exposed missing new modules, typed fixture indexes, synchronous
budget exceptions, TSDoc tags, deprecated Zod `.safe()` and import assists. These
were corrected, not hidden by threshold/rule changes. Post-green author review
centralized remote mode/TLS protocol policy; final verification is recorded below.

## Semantic review

Author self-review, **not independent review**, scoped to the two units against
`eef552a`, including complete intentional working-tree changes.

- `remote-budget.ts`: cohesive adapter ownership of irreversible slot claims and
  request-scoped physical reservations. Matrix: valid/invalid/reused/unknown claim
  × binding failure/call/byte exhaustion → admit once or retain uncertainty; no
  refund and no excessive call. R2 port stays in adapters, not core.
- `demo-app.ts`: existing exhaustive operation/permission table remains the owner
  of HTTP admission; the remote capability supplies only URL/lifetime/ticket policy.
  Authentication and binding precede claim; expiry is checked after awaited claim.
- `demo-owner.ts`/`sync-demo-fetch.ts`: unchanged retained-owner lease and settlement
  exclusion; profile chooses independent state/transport capability. Native secret
  lookup, ticket consumption, abort deadline and dispatch leases cannot upgrade an
  unknown effect to ACK. Core still owns CAS/reconciliation/preservation.
- Protocol owns remote ticket header/schema, TLS/mode and limits; TSDoc captures
  effects, units and failure certainty. No new dependency, console logging, unchecked
  production casts, deprecated API, unconditional loop, generic filesystem writer,
  OAuth scope gain or release entrypoint/config change.
- Configuration, quotas and rollout docs distinguish local implementation, admitted
  effects, rejected-claim overhead and provider quota from a hard billing cap.

Author-review verdict: **APPROVE for local functional delivery only**; **not operational qualification
or authorization to deploy**. Real Free-tier CPU/heap, binding conformance, account
headroom/cost, exact session/hostname and teardown remain unverified. All G1–G6
remain OPEN for production/real data. New artifact is not covered by the old #114
Desktop artifact hashes or a new Desktop support claim.

## Finding closure

| Prior finding | Disposition / evidence |
|---|---|
| Synchronous budget exceptions bypassed Promise rejection handling | **fixed**: async capped methods reject before excess dispatch; request and byte exhaustion regressions |
| Expiry during awaited ticket claim started store after the window | **fixed**: post-await `active()` gate; observed RED200 → GREEN503 / one claim / zero store reads |
| Missing useful TSDoc tags, deprecated Zod `.safe()`, fixture typing/import diagnostics | **fixed**: documented contracts, modern `.int()` validation, explicit fixture checks; canonical diagnostics clean |
| Independently editable remote mode/TLS/header/media policy | **fixed**: shared remote protocol constants, native R2 conditional constants, existing media type; source compiler/lint and 32 focused tests passed |
| 10,000 cleanup reserve did not cover possible object count | **fixed**: separate 160,000-attempt reserve and <=513,600 conservative subtotal in recipe; storage metadata included in reservation |

No deferred code finding or inherited structural concern is hidden by green CI.
Operational unknowns remain explicitly outside this local delivery, not passed gates.

## Final verification

Checkpoint `b0b2370ad`: `mise install && mise run check`, exit0, 2,276 fast / 53
native storage / 16 artifact tests; 95.03% statements, 91.51% branches, 98.58%
functions, 96.87% lines. Subsequent changes reused equal native header/media constants
and corrected marker-preparer TSDoc; compiler/lint and 32 focused tests passed.
Final frozen-code checkpoint **`b9ef76f9d` PASS**, `mise install && mise run check`,
exit0: all the counts above unchanged. Post-check manual semantic closure inspected
final admission/capped-binding/config/profile/lease/persistence paths and repository
owners, with no remaining actionable code finding. Documentation evidence was then
updated; no subsequent production/config/test changes.

SHA-256 of final locally built artifacts (not deployment evidence):

- Worker `dist/remote/index.js`: `771c2445737c464f681eeef9fe3835745e7867f1615e2263437929a18ec25d68`
- Plugin `dist/remote-plugin/main.js`: `f354d6578227bc9027789c636e4cea6eb826f141b16d19f7f609f51cbdfda9bd`
- Plugin manifest: `7a215e8d36ed85a389448c253e1c0152ab960d84e35f4a7e290285d507cc855d`

Full final log retained locally at
`.pi/tasks/01a1183c-79c2-74da-84cf-44f424600986-20032/b9ef76f9d.output`.
Checks executed locally; no GitHub CI or independent approval asserted.
No remote credentials, production resources, personal vaults or large profiles used.
