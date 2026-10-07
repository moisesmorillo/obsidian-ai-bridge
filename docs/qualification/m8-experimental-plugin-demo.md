# M8 experimental plugin demonstration

Delivery 3 composes the durable local client into a **separate synthetic-only plugin**. The release artifact and M3 runtime are unchanged. G1–G6 remain open for productive/public/real-data use.

## Reproduce without Desktop or a personal vault

```sh
mise install
mise run demo:plugin:smoke
mise run check
```

The artifact scenario loads the real CommonJS experimental bundle in two independent JS realms. Each owns a newly created temporary filesystem-backed simulated Vault, separate App-local state and native-secret double. It composes the production local Worker entrypoint with native local workerd R2, not an alternate SyncStore. Temporary directories are removed after the test.

**Not exercised:** Obsidian Desktop, its DOM/SecretStorage durability, mobile, real R2, remote tiers, power-loss/fsync or real 24-hour expiry. An Obsidian binary exists on the development machine, but launching an existing user profile might restore a personal vault; it was not launched. The owner-authorized simulated-instance fallback is used, not represented as desktop compatibility evidence.

## Manual path (new disposable vaults only)

1. Start the separately armed loopback Worker using [the local lab procedure](../local-sync-demo.md). Generate three distinct disposable registry credentials outside tracked files; configure the same fresh vault UUID and distinct A/B/REST participant origins.
2. Build `mise run demo:plugin:build`. Copy **only** `apps/obsidian-plugin/dist/demo-plugin/main.js` and its `manifest.json` to `.obsidian/plugins/ai-bridge-synthetic-demo/` in two newly created disposable vaults. Never use the release `dist/main.js` or an existing vault.
3. Enable the experimental plugin. In settings, select/create a native SecretStorage entry. Apply a non-secret JSON configuration containing the corresponding Worker participant origin as `deviceId`, the same vault UUID, explicit paths and exact acknowledgement:

```json
{
  "mode": "synthetic-local-only",
  "endpoint": "http://127.0.0.1:8789",
  "vaultId": "<fresh configured Worker vault UUID>",
  "deviceId": "<this participant origin UUID>",
  "paths": ["demo.md"],
  "secretReference": "demo-native-secret",
  "acknowledgement": "DISPOSABLE SYNTHETIC VAULT"
}
```

4. Wait for `Ready`, then use the settings **Sync now** button or `Synthetic demo: Sync now` command. No automatic network scheduler is installed. `pending` means invoke again later at the retained retry floor; it is not a completed ACK. `attention` requires inspecting the disposable experiment, not clearing its ledger.
5. A: create saved synthetic Markdown; sync A/B until settled and compare exact bytes. B: edit and sync B/A. REST: update the observed exact parent and sync B. Then edit B locally and publish a competing REST version: B must remain unchanged, an exact remote copy must appear under `ai-bridge-conflicts/<revision>/demo.md`, and attention must be visible.
6. Restart/re-enable the plugin and repeat Sync now: original ledger/postconditions remain authoritative; a conflict remains latched without another competing copy. Do not resolve by silently erasing state or refreshing its parent.

## Safety and operation

| Boundary | Contract |
| --- | --- |
| Config/ledger | Official `App.loadLocalStorage/saveLocalStorage`, separate versioned keys, strict bounded strings and read-back verification. No data.json bodies/tokens or frozen-codec migration. |
| Secret | Native SecretStorage retrieval at dispatch; only a reference is configured. Rotate secret contents at the same reference. |
| Arming changes | A retained owner cannot redirect identity/endpoint/reference/path order. Use a fresh disposable experiment/full App restart; do not delete uncertain ledgers. |
| Local effects | Complete metadata target/ancestor alias/folder/config checks; official create-only `Vault.create`, exact comparison inside `Vault.process`, saved-byte verification. No raw filesystem, delete or rename capability. |
| Lifecycle | Listeners precede layout-ready/effects. All saved events, including own effects, remain successor observations. Same-realm owner/late request exclusion survives unload/bundle replacement; stale sessions cannot dispatch later work. |
| Budgets | ≤3 paths, ≤16 KiB UTF-8/note, ≤32 HTTP dispatches/pass, scheduled ≤10-second per-request deadline. Not a preemptive whole-command latency guarantee. Whole-vault metadata scan cost and long-term remote/conflict growth remain unqualified. |
| Visibility | Trusted text-only Ready/Syncing/settled/pending/attention categories. No note bodies or credentials in status/logs. |

## Evidence ledger

Final canonical task **`b4f98a2a2`**, 2026-10-07, ran `mise install && mise run check`
on baseline `main/e71bcf3` plus production/test source commit
`2c183e63d461549cf69ff1efe14e5b8a04884147` (subsequent report-only identity edits
cannot change these built artifacts). It passed **2,244 fast / 53 native /
14 artifact tests** (12 release + 2 experimental) in 61.96 seconds. Coverage:
**95.02% statements / 91.49% branches / 98.61% functions / 96.86% lines**;
thresholds unchanged. Formatting/assists/type-aware lint/strict typing/TSDoc
presence/build/release identity all pass with no configured diagnostic. A prior
94.89% statement failure was corrected with actual settings/native-selector/button,
unverified host-local state and uncertain local-I/O regressions, not exclusions.

| Actual artifact scenario | Observed assertion |
| --- | --- |
| A→B | A's saved synthetic bytes commit and B reads exactly those bytes. |
| B→A | B's next saved edit commits under its independent participant and A receives exact bytes. |
| REST→plugin | Third authenticated participant edits the current exact parent; clean B receives exact REST bytes. |
| Cold restart | A fresh simulated App owner reloads original App-local ledger and exact ACK; the next unchanged command settles without reconstructing parents. |
| Concurrent edit | B's saved competing bytes remain unchanged, deterministic excluded copy exactly matches the REST bytes, visible attention and retained original ACK/checkpoint persist. |
| Bundle replacement | Same App/realm reevaluation retains owner/attention; no duplicate conflict copy. Each explicit pass asserts ≤32 HTTP dispatches. |

Source-focused tests pass **23** and additionally assert atomic-process races,
alias/folder/config refusal, config mismatch, lost read-back, stale-secret dispatch,
saved successor events and busy unload/re-enable. The genuine secret-await RED
`b168e2217` dispatched once after unload; the physical fetch wrapper now rechecks
the current lease immediately after async secret retrieval, and the assertion is
GREEN. Missing-module/VM capability startup failures are not behavioral RED proof.

SHA-256 of final rebuilt `dist/demo-plugin`:

- `main.js`: `b26e6b6e3e139274039d0aed30e1dc33340abe8ef8f6a0e4cabf078527be8be8`
- `manifest.json`: `bacda0a8aa6f0d3e747fe985fe99b7ffb58048d03666c382a806be8b846e9416`

Post-green **author** semantic review covered responsibility direction, exact
saved effects/retained ownership, closed status/TSDoc semantics, host-boundary
weak-input conversion, privacy, finite dispatch and release noninterference.
No blocking finding remains; this is **not independent review**. No personal
vault was opened, Desktop launched, remote Worker/R2 resource contacted or deployment run.
M8 completion becomes canonical on the functional delivery-3 PR merge only.
