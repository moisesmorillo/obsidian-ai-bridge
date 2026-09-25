# M5 final qualification — operational and security readiness

**Disposition:** M5 completion and M6 `NEXT` are proposed by this qualification PR and
become canonical only when it merges. The evidence closes A1–A12 for the narrow
software-support envelope below; it does not certify a production service or security
posture.

**Base:** `main` at `ed8b4d6f8064fbac3256d14254edfe80170aa949` (`v1.0.2`).
**Qualification host:** Obsidian Desktop **1.13.7**, macOS **26.6.2**, Apple **M4 Pro**.
**Production TypeScript diff:** **0 files / 0 LOC**. This transition changes
 documentation and qualification evidence only.

## Qualified software-support envelope

The only qualified software release is latest-only **v1.0.2**, for one active
designated writer on the exact desktop/macOS/Apple-silicon profile above and up to
**10,000 eligible synthetic Markdown notes**. The support statement is limited to the
measured scenarios below; it is not a latency or availability SLA, production-service
approval, complete-backup guarantee, security certification, or assurance about a
deployed Worker/R2 service.

`manifest.json` remains at `minAppVersion: 1.13.0` and `isDesktopOnly: false`. Those
metadata values permit loadability; they do not qualify other Obsidian versions or
writer platforms. Mobile, Intel macOS, Windows/Linux, other desktop versions, iCloud
event ordering, background iOS, multiple active writers, and deployed Worker/R2
behavior remain unqualified. No personal or production vault was used, and no
production resource was deployed.

The [GitHub `v1.0.2` release](https://github.com/moisesmorillo/obsidian-ai-bridge/releases/tag/v1.0.2)
has no downloadable binary assets, and its release notes make no broader platform
compatibility claim. The qualified plugin bundle is source-built from the version-aligned
tag using `mise install`, `mise run install`, `mise run plugin:build`, and
`mise run plugin:smoke`; use only the generated `main.js` and `manifest.json`. The `v1.0.2` tag resolves to the qualified source commit
`ed8b4d6f8064fbac3256d14254edfe80170aa949`. `mise run release:identity-check`
reported synchronized `1.0.2` versions across package, lockfile, manifest, Release
Please, and staged-manifest identity fields. Two consecutive source builds produced
identical SHA-256 values:
`main.js` **`c69db170553b68cc0b0d49bc843ab0955a95e081ff7737b56be9e2dfef9a77dc`** and
staged `manifest.json`
**`c593edb3b45ddca0d0861f0b0b8e1b062d34dd4729df1bdd18144dc0518e0210`**. No earlier
release or rollback line is supported, and no backports are promised.

## Measured 10,000-note active-writer behavior

The retained disposable-host results were inspected and reused; they were not rerun
merely because release metadata changed. Each accepted active-writer result reached
its full eligible-note count with zero pending paths, no global block, and no
persistence fence.

| Synthetic Markdown notes | Settled paths | Persisted state bytes | Observation/settlement | Result |
| ---: | ---: | ---: | ---: | --- |
| 1,000 | 1,000 | 271,337 | 2.5 ms observed wait after activation | Passed |
| 5,000 | 5,000 | 1,355,337 | 223,792 ms | Passed |
| 10,000 | 10,000 | 2,710,337 | 585,952 ms | Passed |

The 1,000-note record observes an already-settled state immediately after activation;
its 2.5 ms is not a cold-start or end-to-end SLA. The 5k/10k times are observations on
this host and fixture only.

### v4-to-v5 migration and restart matrix

Retained host measurements passed cold-start migration and settled restart at 1k, 5k,
and 10k. The 10k matrix read 200 remote pages and recorded **2,880,372 state bytes**;
startup observation was **1,143,012 ms** and settled-restart observation was
**336,980 ms**. The largest measured state remained below the 13 MiB configured hard
limit. Three interrupted attempts are retained in the test record; only the completed
matrix stages are counted as passes. These times are measurements, not service-level
objectives.

### Explicitly unqualified pause/resume conflict attempt

A separate 10k pause/resume attempt is **not counted as a settled or passing result**.
Resume began with 9,895 pending paths. After 30 minutes the result still had one
pending path and one active operation. That path had a remote-ahead conflict requiring
explicit review; a subsequent Keep-local submission was admitted but remained in
attention with one pending review/operation after 300 seconds and zero preservation
artifacts. The captured status had no global block or persistence fence, but it did not
establish completion, remote effect, or preservation.

The local qualification Worker process was terminated after its background task
exceeded the 20 MB output cap, then restarted. The retained request log does not cover
the final operation outcome, so the evidence cannot distinguish a conditional
conflict/re-review from an interrupted or unknown effect. This attempt is excluded from
the support measurements above: it neither proves a settled pause/resume conflict path
nor a product defect or data loss. No claim is made that this conflict was settled.
This qualification does not cover pause/resume conflict recovery across a local Worker
interruption; operators must preserve state and follow the review/effect-certainty
runbook rather than assume success or reset state.

## Retained lifecycle and host evidence

- **Credential rotation:** retained successful rotation evidence covers 200 remote
  pages and 2,884,338 state bytes; the Worker mutation delta was zero. Existing
  deterministic tests cover credential validation, overlap, revocation, old-token
  rejection, loss replacement, and total-registry-loss tooling. No token value is
  included in this report.
- **Fresh Keep-local:** retained the bounded disposable-host result in
  [M4 host-visible preservation qualification](m4-host-visible-preservation.md). It
  preserved the remote competitor through the official host API, conditionally kept
  local content, settled the operation, and verified no redispatch after restart. This
  prior M4 result is reused only for that behavior; v1.0.2 release identity was checked
  separately. It is separate from the explicitly unqualified 10k pause/resume attempt
  above and does not qualify a deployed service or the broader failure matrix.
- **Listener-gap authority:** the bounded detached-edit and reviewed-transfer result
  remains in [M4 listener-gap recovery](m4-listener-gap-recovery.md). It confirms
  fail-closed reservation retention for those scenarios only, not iCloud, mobile, or
  general host durability.

## Recovery, diagnostics, and backup boundary

A loopback-only Worker/R2-emulator exercise used synthetic credentials and one
synthetic note. It checked read-only write refusal before mutation, conditional
create/read/delete, one-page content-free recovery metadata, exact-content export to an
owner-only temporary file, exact sealed replay, and refusal of premature purge while
recovery content remained readable. It inspected 12 emitted live events for client
attribution and content/credential/path/identifier leakage. The local emulator state,
export, and logs were removed at teardown. This is not an external backup-provider
round trip.

M5 does not select, configure, or guarantee any independent vault-backup provider.
The vault owner must maintain and verify an independent versioned backup. Vault content,
credential secrets, and host-local mirror state are distinct recovery concerns; R2 is
a conditional mirror with 30-day deleted-content recovery, not a complete backup or
physical-erasure guarantee. See the [operator backup/restore procedure](../operations.md#independent-vault-backup-and-restore).

Application diagnostics remain live-only with zero-day application retention and no
audit-log claim. The loopback exercise and focused integration tests verify the
content-free event contract; there is no production Worker deployment or platform
log-retention qualification.

## A1–A12 acceptance disposition

### A1 — Threat coverage

The threat register distinguishes implemented controls, qualification evidence, named
residual risks, and operational owners. The support envelope does not widen the trust
boundary or infer capabilities from configuration.

### A2 — Credential safety

The strict bounded digest-only registry and typed principal remain unchanged. Focused
registry/authentication tests cover malformed configuration and least-privilege
resolution; no raw credential is recorded here.

### A3 — Credential lifecycle

Overlap rotation, independent revocation, old-token rejection, lost-token/registry
replacement procedures, and offline tooling are covered by the retained rotation
record, focused tests, and operator runbook.

### A4 — Permission completeness

The exhaustive route/action policy and its focused permission matrix remain the single
authority. The loopback exercise confirmed that a read-only principal is refused before
write mutation.

### A5 — Migration

Current v5 migration/restart measurements are recorded above. Frozen historical
codecs, incompatible-state refusal, exact release identity, and forward-only/rollback-
refusal guidance remain covered by tests and runbooks.

### A6 — Bounded operation

Active-writer evidence passed at 1k/5k/10k, and the v4→v5 startup/restart matrix
passed at the same counts. Existing hard-bound tests remain in the canonical suite.
The separate pause/resume conflict attempt is explicitly excluded above; it is not
represented as settled.

### A7 — Diagnostics and privacy

Content-free live diagnostics, canonical-client attribution, zero-day application
retention, and forbidden-data negatives are covered by focused tests and the loopback
event inspection. No audit or durable-retention claim is made.

### A8 — Recovery and rollback

The loopback exercise covered one-page metadata, exact export/replay, and premature-
purge refusal. Local-first restore, rollback, backup responsibility, and evidence
preservation are specified in the runbook; relevant existing tests cover exact-state
recovery/effect paths. No external backup restore or full-vault recovery was exercised,
and no backup-provider or full-backup claim is made. The unqualified conflict attempt
is called out above.

### A9 — Platform and release truth

Latest-only `v1.0.2`, synchronized package/manifest/tag/staged identities, reproducible
source build, the exact exercised host, and unsupported platforms are recorded above.
No binary asset or production deployment is implied.

### A10 — Architecture

No production code, dependency, credential-administration API, Worker binding, or M6
implementation was added. Existing package boundaries and application authorization
remain unchanged.

### A11 — Validation

Final `mise install`, canonical `mise run check`, Markdown link/heading checks,
exact-one-`NEXT`, `git diff --check`, and source-diff checks are recorded below. No
source or editor-settings changes were made.

### A12 — Review and transition

The final semantic/security review is recorded after automated validation. The proposed
M5 COMPLETE / M6 sole NEXT transition becomes canonical only when this PR merges.

## Final validation and review

- `mise install` completed with all 44 declared tools already installed.
  `mise run install` completed with no dependency changes.
  `mise run release:identity-check`
  reported synchronized v1.0.2 identity, and two consecutive `mise run plugin:build`
  outputs were byte-identical (hashes above).
- The canonical `mise run check` passed: Biome checked 327 files with no fixes;
  typecheck and type-aware Oxlint passed; TSDoc reported zero violations across 205
  production files; plugin artifact smoke passed 12 tests; Worker storage qualification
  passed 8 tests; Worker build completed with `--dry-run`; and all **1,375 tests across
  80 source test files** passed. Source coverage passed thresholds: statements
  **95.06%**, branches **90.81%**, functions **98.38%**, and lines **97.03%**.
- The custom local Markdown link/heading check passed for all 14 changed Markdown
  files. The roadmap milestone table has exactly one `NEXT` row: M6. `git diff --check`
  passed, and the production TypeScript diff is 0 files / 0 added or deleted lines.
- Manual semantic/security review found no blocking finding within the stated
  support envelope. The change is documentation/evidence-only; it adds no production
  code, dependency, permission, or deployment surface. Support and release statements
  stay bounded to the measured host/scenarios; credential handling, vault content,
  mirror state, and independent backup responsibility remain distinct; and M6 stays
  planning-only. The pause/resume attempt remains a material unqualified limitation:
  its Keep-local operation remained in attention with one pending review and zero
  preservation artifacts; the background task later exceeded its 20 MB output cap
  and terminated the local Worker before the final effect was captured. The available
  evidence cannot establish completion, final remote effect, preservation, data loss,
  or the absence of a defect. The attempt is not counted as a pass and is excluded
  from the qualified support claim.

## Explicit non-claims

This report does not claim security certification, penetration testing, a production
service or deployment, multi-writer safety, broad Obsidian/macOS/mobile/iCloud support,
background-iOS operation, complete or point-in-time backup, physical erasure,
continuous availability, an SLA, a durable audit trail, or settlement of the
pause/resume conflict attempt above. M6 remains planning-only until its hosting,
transport, authentication/permission mapping, tool/resource surface, confirmation, and
content-limit decisions are resolved and its dedicated specification is implementation-ready.
