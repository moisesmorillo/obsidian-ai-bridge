# M4 corrective host-visible preservation qualification

## Scope and result

**Result: passed for the bounded corrective scope on 2026-09-21.** This evidence
qualifies the replacement preservation namespace and one remote-ahead **Keep local**
operation in an isolated Obsidian desktop host. It does not resume M5, establish a
support claim, qualify a personal vault, deploy a Worker, or replace the complete M5
Slice 5–6 desktop/mobile/iCloud/background qualification sequence.

The generated plugin artifact under test came from the corrective branch based on
`origin/main` `6b0803d`. Its staged `main.js` matched the build output at SHA-256
`799d206d074fb1fc6007dff07556510292f991a34ddbc9b3757d9df34522c16a`. The repository's
unchanged plugin manifest identified version `0.1.0` with minimum Obsidian version
`1.13.0`; this corrective PR does not take ownership of M5 release/version work.

## Environment and isolation

- Obsidian desktop `1.13.7` from `/Applications/Obsidian.app`;
- macOS `26.6.2` build `25G83`, native `arm64` Apple M4 Pro;
- disposable vault, disposable Obsidian user-data directory, disposable native-secret
  value, and loopback-only deterministic HTTP fixture;
- no personal vault, deployed endpoint, R2 data, production credential, raw-filesystem
  plugin capability, or mobile/iCloud setup;
- runtime inspection used Chromium DevTools against the isolated renderer, while all
  production vault operations remained official Obsidian APIs.

A qualification-only bootstrap plugin installed the exact active-writer v4 baseline
through `App.saveLocalStorage` and `SecretStorage`. Obsidian's startup file event marked
the pre-existing fixture note dirty after that injection, so the harness used the
loaded runtime state owner to restore the intended `desired: none`, `blockedReason:
diverged` precondition before opening the real review command. This was test-fixture
setup, not a production bypass; the review, preservation, remote mutation, settlement,
persistence, restart, and inventory checks ran through the packaged plugin.

## Official-API replacement-root probe

A separate isolated Obsidian 1.13.7 plugin probed replacement roots through
`Vault.createFolder`, `Vault.create`, `Vault.getAbstractFileByPath`, and `Vault.read`:

| Root | Physical create | Root/step/file indexed | Exact 32-byte reread |
| --- | --- | --- | --- |
| `.ai-bridge-conflicts` | yes | no (`null`) | unavailable |
| `ai-bridge-conflicts` | yes | yes | yes |
| `AI Bridge Conflicts` | yes | yes | yes |

The selected lowercase hyphenated root produced SHA-256
`5dc99b3cd6f31525efd4c828e549900992fb8b35374850b368a9f1aee6b3b60d` for the probe
body. The observed Obsidian configuration directory was `.obsidian`. The probe therefore
confirmed the original real-host failure mode and selected `ai-bridge-conflicts` as the
simpler deterministic official-index-visible root.

## Minimal remote-ahead Keep-local scenario

The disposable vault contained `qualification/conflict.md` with 25 bytes and SHA-256
`c736515a14dbea80a0ad8da1e1b8accda6bbb3086bb63b6cea6471cd86e9f9b5`. Its acknowledged
baseline revision was `33333333-3333-4333-8333-333333333333`. The loopback fixture then
reported an independently updated remote revision
`44444444-4444-4444-8444-444444444444` with 35 competing bytes and SHA-256
`169f9628b30ed28e541ecd096b3700118c4b1a8a8bc492f12a4ca203ca97a07f`.

The packaged command discovered exactly that remote-ahead candidate. Selecting **Keep
local** admitted operation `c357f7c9-af69-4935-aa06-8cc40e8688e8` and produced:

- indexed root `ai-bridge-conflicts`;
- indexed operation folder
  `ai-bridge-conflicts/c357f7c9-af69-4935-aa06-8cc40e8688e8`;
- indexed file
  `ai-bridge-conflicts/c357f7c9-af69-4935-aa06-8cc40e8688e8/remote.md`;
- official-API reread of the exact 35 remote bytes;
- exact artifact SHA-256
  `169f9628b30ed28e541ecd096b3700118c4b1a8a8bc492f12a4ca203ca97a07f`;
- a verified receipt binding the operation, original path, remote side, source revision,
  hash, and generated path.

The preservation adapter cannot return that verified receipt until the official lookup,
reread, and hash postconditions succeed. The effect executor admitted the remote step
only after the receipt became verified. The loopback fixture then observed exactly one
`PUT` with:

- `Bridge-Operation-Id: c357f7c9-af69-4935-aa06-8cc40e8688e8`;
- `If-Match: "m3-44444444-4444-4444-8444-444444444444"`;
- the exact 25 local bytes and local SHA-256;
- result revision `55555555-5555-4555-8555-555555555555`.

The durable operation settled as `completed`, `localEffect: not-dispatched`, and
`remoteEffect: confirmed`. Runtime status reported zero pending paths, zero active or
attention operations, no global block, and no persistence fence. The local note remained
byte-exact.

Although the artifact is intentionally visible in Obsidian's Vault index, the packaged
local inventory returned only `qualification/conflict.md` and counted the artifact as
one `excluded_location`. Thus it was not admitted as a user note or emitted through a
mirror write.

## Restart and compatibility evidence

The bootstrap plugin was disabled before restarting the same isolated Obsidian host.
After restart:

- the completed operation and verified current-root receipt decoded unchanged;
- the artifact remained retrievable through `Vault.getAbstractFileByPath`;
- runtime status again showed zero pending/attention work and no fence;
- local mirror inventory still excluded the artifact; and
- the fixture's total conditional `PUT` count remained exactly one, proving no restart
  redispatch.

Focused frozen-state tests separately load valid v2/v3/v4-era legacy
`.ai-bridge-conflicts` receipts. Verified legacy receipts retain their exact identity;
unknown/evidence-required legacy effects remain blocked and are neither repaired,
rewritten, moved, nor redispatched under the new root.

## Residual limits

This correction has no broad desktop scale result, mobile result, iCloud event trace,
background-iOS result, deployed Worker/R2 result, host crash-during-write result, or
supportability result. M5 remains **NEXT** and its Slice 5–6 qualification remains
blocked pending merge of this corrective PR and a complete rerun.
