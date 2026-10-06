# M7.4 private SyncStore: local evidence

**Status: isolated implementation merged in PR #97, locally validated and independently approved; unactivated.** This is historical implementation evidence; [ADR 0020](../decisions/0020-private-sync-store-delivery-and-activation-gate.md) closes private delivery only. The [consolidated report/G1–G6 blockers](m7-delivery-and-activation-gate.md) supersedes the old exit coupling. This report does not qualify Workers Free CPU, account sustainability or a production vault.

## Candidate and boundary

- PR #97 merged at **`62696b030a817eb2c4f91af8a6986a688fcd318b`**. Its tree matches final source **`ed88daff4bda73bb5bd1fa4a47dac11802060911`**, including the terminal inventory failure correction. This report records that historical candidate, not the HEAD of a later documentation PR.
- Initial implementation history: branch `feat/m7-complete-sync-store`, base `2a885a5`, overlay `59bd2f5`, validated initial code/test snapshot `dfe274e1562f327350ede5f594fe62afa51b6b79`. The original publication corrections were documentation-only; the later `ed88daf` correction changes source/tests and supersedes the initial coverage below. Forward-only branch commits and the owner's merge preserve prior history. Deployment and activation remain outside this evidence.
- Private nine-method composition implements conditional mutation publication/recovery, committed feed paging, v2 inventory cursor witnesses/chunk replay, complete-handle evidence paging and scoped expired-scratch cleanup.
- Original conditional-write authority, permanent manifest no-reuse tombstones and conservative unresolved effects remain intact. The current writer, HTTP/MCP surface and plugin are unchanged.

## Verified local checks

| Check | Evidence |
| --- | --- |
| Installation | `mise install` completed. |
| Post-R2 canonical gate | `mise run check && git diff --check` passed after R2, task `b45e01da2`, exit 0. Includes Biome diagnostics/assists, semantic lint/TSDoc, typecheck, tests/coverage, build and local native-runtime checks. |
| Post-commit canonical gate | At committed snapshot `dfe274e1562f327350ede5f594fe62afa51b6b79`, `mise run check`, `git diff --check` and `git diff origin/main...HEAD --check` passed in `baa45b705`, exit 0. The tree was clean; its historical initial coverage is recorded below separately from the final corrected source. This is separate evidence from the earlier overlay run. |
| Final terminal-correction gate | `mise run check && git diff --check` passed in `b51422a47`, exit 0, on the source/test tree committed as `ed88daf`. Post-commit diff check passed; PR #97 Quality checks (1m31s) and Conventional PR title (12s) passed in `ba4eb60ca`. |
| Statements (final source) | **12,301/12,948 (95%)**; unchanged configured threshold. |
| Branches (final source) | **10,637/11,630 (91.46%)**. |
| Functions (final source) | **2,414/2,447 (98.65%)**. |
| Lines (final source) | **11,685/12,069 (96.81%)**. |
| Terminal inventory regressions | **134/134** pertinent tests passed; persisted failed phase, repeated same-ID no-LIST, cooldown latch, lost response, peer-generation fencing, malformed SDK shape, unavailable head and foreign-slot preservation. |
| Corrective regressions | R1 policy/recovery group **17/17**; R2 lane/target/admission group **9/9**. Genuine failing behavior preceded each production correction. |
| Independent semantic/design review | Initial implementation: `34cd43e4-65d3-458d-b576-5a3d6a67ff7f` APPROVE. Terminal correction: `02c87a5c-4285-4eed-b7ea-96fda32fbf1e` **APPROVE**, malformed-LIST MAJOR finding fixed, no actionable finding. Both approvals are private implementation only. |

Historical initial coverage at `dfe274e` was 12,272/12,917 statements (95%),
10,613/11,604 branches (91.45%), 2,410/2,443 functions (98.64%) and
11,659/12,042 lines (96.81%). It is not the final corrected-source measurement.

The native composed-store fixture covers an empty synthetic scan and preservation of a legacy object. Native conditional primitives and counted-call/fault/interleaving tests provide separate local evidence; they are not a maximal 10,000-head runtime profile or remote account measurement.

## Review findings closed

- **R1:** an invalid target-write response floor was hidden by a valid later observation. Each supplied response floor is now independently classified before aggregation; negative/fractional evidence remains uncertainty, without retry-journal CAS or new write authority.
- **R2:** equivalent lane reservation/release paths forwarded or masked unsafe floors. They now validate response/observation evidence before response-driven floor updates. Exact confirmed completion remains independently admissible. Tests retain the journal generation prepared before the attempted lane PUT and verify later same-ID recovery; legitimate pre-dispatch floor preparation is not confused with a prohibited post-response CAS.

- **Terminal inventory failure:** a post-reservation failure previously lacked durable
  failed state, and the pre-reservation ETag could not authorize its terminal CAS.
  `ed88daf` records a strict schema-v2 failure latch at the existing create-only
  chunk key, checks the entire reserved manifest before terminal CAS, and recovers
  without another LIST during cooldown. Uncertain effects retain the slot; only the
  owned failed scan slot is released. Historical v1 page evidence is not repaired.
  Review additionally reproduced missing runtime LIST flags/keys; closed boundary
  schemas now classify malformed observed data as invalid rather than transient
  storage failure or an uncaught replay error. Genuine RED/GREEN tests closed it.

Whole-branch review covered mutation/publication/schema ownership and state/effect/predicate/clock conjunctions, inventory/feed/cleanup authority, security and aggregate design budgets. The source/test evidence and detailed English report are retained with the execution ledger under `.superpowers/sdd/2026-09-29-m7-complete-sync-store/`.

## Remaining gates

1. Separately authorize and measure remote Workers Free CPU/account and storage-admission qualification. No real R2, account or vault was accessed.
2. Preserve later local 5,000/10,000 maximum profiles with their limits. Missing sparse/adversarial, expiry and native safety evidence remains open; no stress repetition is authorized by this report.
3. Follow G1–G6 before real-data use or activation. ADR 0020 closes private delivery without declaring those criteria passed or moving another milestone to NEXT.
4. Specify and authorize activation independently; do not provision markers, migrate data or alter the current writer from this report.

Follow the [remaining-gates qualification plan](../plans/m7-sync-store-qualification.md)
for local harness scope, remote approval, measurement and account-admission requirements.
No qualification run is authorized or claimed by this documentation update.

See the [M7 specification](../milestones/m7-versioned-sync-protocol-and-r2-store.md) and [implementation plan](../superpowers/plans/2026-09-29-m7-complete-sync-store.md) for accepted limits and execution boundaries.
