# ADR 0023 — Bounded personal-vault beta alongside iCloud

## Status

Owner-requested design; canonical on this documentation transition's merge.
Implementation, deployment and personal-vault activation remain pending.

## Context

ADR 0020 and the full bidirectional rollout plan require G1–G6 acceptance before
any real-data use. M9 subsequently demonstrated automatic one-path sync on real
Desktop hosts with disposable vaults and a temporary private R2 lab. The owner
wants to beta-test the next bounded increment in an existing iCloud-backed vault,
starting with one new Markdown note, without repeating large-scale profiles.
The current experimental lab is gone and cannot safely be reused as a standing
personal-vault service.

## Decision

Supersede **only** ADR 0020's absolute real-data prohibition for the exact
[M10 one-note beta](../milestones/m10-personal-vault-beta.md). G1–G6 stay open and
mandatory for general production exposure, broad real-data support, import,
mobile cutover and iCloud replacement. This is an exception with independent
pre-use requirements, not acceptance of incomplete gate evidence.

Before the first personal-vault write, deliver a separately isolated private
Worker and storage namespace with exact owner/vault/path-bound authorization,
durable bounded admission, stop/revocation and redacted diagnostics. Deliver an
explicit per-vault experimental plugin profile retaining exact-base/uncertainty
fences and excluded conflict copies. Pass focused safety and host checks, verify
an independent restorable snapshot, then explicitly opt in to one newly created
Markdown path. Do not scan or migrate existing notes. An unexpected divergence
stops the beta until its cause and preservation are resolved.

iCloud remains enabled for this owner beta. A local bridge write can propagate
through iCloud to other devices; an iCloud-origin event can reach the Mac later.
No silence, missed event, incomplete inventory or stale base grants deletion or
overwrite authority. Exact-base mismatch preserves both versions and requests
attention. This limited coexistence does not establish a supported dual-provider
cutover architecture. The full rollout still requires one sync owner per vault
when iCloud is eventually replaced.

No delete, rename, wildcard admission, whole-vault traversal, mobile bridge
claim, production release or automatic bucket teardown is included. Cloudflare
provisioning and vault access require their own explicit operational authority;
the documentation decision itself performs neither.

## Consequences

The first useful outcome is a real one-note Mac beta with iCloud still carrying
the rest of the vault. General support remains blocked by G1–G6. Rollback stops
new dispatch and revokes the endpoint, retains snapshot/ledgers/versions/conflict
copies, and verifies the admitted note before any restore. Evidence from this
beta can inform later scope but cannot silently enlarge it.

## Alternatives

- Wait for full G1–G6 and another maximal-scale campaign before any personal
  test: declined by the owner as disproportionate to a one-note beta.
- Deploy the M9 one-hour disposable lab unchanged into the personal vault:
  rejected because its admission, expiry and isolation are lab-only.
- Disable iCloud immediately: unnecessary for a one-path experiment and would
  introduce a broader vault cutover before the bridge is proven.

## Evidence / related documents

- [M9 disposable Desktop report](../qualification/m9-disposable-desktop.md)
- [M10 specification](../milestones/m10-personal-vault-beta.md)
- [General activation gates](../qualification/m7-delivery-and-activation-gate.md)
- [Full rollout target](../plans/bidirectional-vault-sync-rollout.md)
