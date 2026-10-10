# M10 — One-note personal-vault beta

**NEXT, documentation scope only until this transition merges.** The owner wants to
try automatic bidirectional Markdown sync in an existing iCloud-backed vault. M9
proved a separate experimental plugin with disposable Desktop vaults and temporary
R2, but its lab was removed and its configuration rejects personal-vault use.
M10 is an explicitly bounded beta exception to the general G1–G6 activation gate,
not a declaration that those gates have passed or that the existing release plugin
can safely sync a personal vault today. [ADR 0023](../decisions/0023-bounded-personal-vault-beta.md)
records the narrow change to ADR 0020's real-data prohibition and the iCloud
coexistence boundary.

## First usable outcome

With the owner's explicit opt-in, a separate private beta service and plugin profile
synchronize **one exact, newly created Markdown path** between the owner's Mac and
the service. A remote REST edit to that path arrives automatically when the local
base is unchanged. A concurrent edit preserves both byte versions and surfaces
attention; it never selects a winner silently. iCloud remains enabled and continues
to carry the working vault to the owner's other devices. M10 does not claim direct
bridge sync on iPad or iPhone.

The admitted path is configured exactly; no wildcard, folder selection, discovery,
or whole-vault walk is permitted. The first note is small (at most 16 KiB under
the existing experimental contract) and has a distinct test name selected before
activation. The beta must not import existing notes by scanning the vault. Only
after the first flow and rollback have passed may the owner explicitly admit another
new Markdown path through a separate reviewed change.

## Boundaries and prerequisites

- Keep the M5 release plugin, production Worker, production R2 bucket, v2 writer,
  OAuth grants, and M9 disposable lab state separate. A stable private beta Worker,
  bucket/namespace, credentials, and endpoint need a reviewed configuration and
  separately authorized provisioning. No inherited synthetic tickets or secrets.
- A beta grant binds one owner, one vault identity, the exact admitted path, and
  intended REST/client rights. Reject other paths, vaults, origins, redirects and
  unauthenticated operations before content storage. The current one-hour lab
  admission cannot serve as a standing beta unchanged; implement bounded durable
  admission, stop/revocation and observable usage first.
- Preserve the M8/M9 exact-base client, durable operation tuple, revision and
  checkpoint fences, byte verification, and excluded conflict copy. Lost replies,
  stale parents and uncertain effects must stop or retry the original operation
  without claiming a newer ACK. No remote absence or incomplete inventory grants
  deletion authority. Disabling beta must stop timers and new dispatch.
- Before touching the personal vault, create and verify an independent restorable
  local snapshot of it. Do not treat iCloud or R2 as that backup. Check exact
  endpoint, scope, vault identity, private bucket, access control, local secret
  reference and stop path with an empty disposable copy first. Keep the personal
  vault's existing iCloud setting unchanged.
- The beta plugin may write the admitted note locally. iCloud can propagate that
  write to iPad, iPhone or another Mac; it can also deliver an older local event.
  The client must preserve both versions on stale-base conflict and never assume
  iCloud event order or silence proves deletion. The owner sees this effect before
  opting in.

## Functional delivery order

1. **Private beta server.** Reuse the existing SyncStore and separate remote
   composition, with stable owner/vault/path-bound admission, bounded requests and
   storage, explicit stop, redacted diagnostics, and no production routing. Test
   foreign path/vault/participant refusal, revocation, exhausted admission, replay
   and stale CAS. Keep this separately reviewable; no personal vault is used yet.
2. **Beta plugin profile.** Reuse the durable exact-base client and automatic M9
   scheduler. Add an explicit per-vault, one-path opt-in and separate native secret,
   ledger and owner namespace. Test unchanged release plugin, scoped events, host
   reload, failed persistence, conflict copy and disable fencing. No ambient vault
   traversal or automatic enrollment of existing notes.
3. **Owner's one-note beta.** With a verified snapshot and private service, exercise
   create/round trip, REST-to-Mac, Mac-to-REST, targeted reload and one concurrent
   edit on the new note. Compare exact bytes, hashes, revisions, local checkpoint,
   preserved conflict copy and denied out-of-scope path. Record actual request and
   storage usage. Stop on the first unexplained divergence; fix the concrete defect
   before resuming. Do not launch another 5,000/10,000-note campaign for this scope.

Each implementation delivery must fit the repository's production-file/line gate
or propose a semantic split before coding. Tests and documentation ship with their
behavior. `mise run check` and independent semantic/security review precede any
personal-vault beta use. A green test run alone does not grant real-data access.

## Rollback and completion

The owner can disable beta in the plugin and revoke/stop the beta endpoint. Stop
new writes first; retain the vault snapshot, local ledger, remote versions and
conflict copies for diagnosis. Do not delete an uncertain operation or repoint the
client to the old disposable lab or production mirror. Verify the admitted local
note against the snapshot and iCloud-visible state before restoring or editing it.
Removing the beta bucket is a later explicit teardown decision, never automatic
rollback.

M10 completes only when the one-note personal-vault flow and rollback are observed
and documented, with failures and platform limits stated. It does **not** complete
G1–G6, certify a general real-data product, replace iCloud, authorize the entire
vault, or prove mobile bridge behavior. Broader scope needs its own decision and
evidence based on the failures and usage observed here.
