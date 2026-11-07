# Plugin releases for BRAT

## Release flow

Release Please checks Conventional Commits on `main` and opens or updates a release PR for each changed component. The plugin component uses tag `ai-bridge-v<version>`. Its PR updates `apps/plugin/package.json` and `manifest.json`.

The release workflow checks out the exact tag. It writes the compatibility entry from that tag's manifest before validation, build, and publication. The validator still requires the tag version to match `manifest.json`. The workflow uploads only `main.js` and `manifest.json`.

The publish job installs the pinned Bun toolchain on its own runner. On a retry, it compares existing release assets byte for byte with the checked assets. It skips matching assets, uploads missing assets, and stops if any existing asset differs. This lets a partial publish retry reach compatibility recording without replacing a published file.

After publication, the workflow fetches fresh `main` and writes the exact tag entry while preserving every other entry. The writer does not replace a conflicting entry for the same version. The workflow retries a rejected `main` push against fresh `main` up to three times. If branch policy still blocks the push, it opens a chore PR. An existing open chore PR for that version makes a rerun succeed without creating a duplicate. A chore commit does not release a new plugin version. The workflow does not read a newer main manifest to derive an older tag's compatibility entry.

The owner can still push a matching tag by hand. That workflow checks the exact remote tag commit before it adds assets. Never move or reuse a published tag. The workflow token does not start another workflow from a Release Please tag or release. The same-run job performs the plugin build and asset upload instead.

The release workflow uses its token to push the chore commit or create the fallback chore PR. Repository settings must allow GitHub Actions to write contents and pull requests. The workflow does not use a release PR branch for compatibility data.

## Install from BRAT

BRAT installs releases from `moisesmorillo/obsidian-ai-bridge`. The plugin needs the Obsidian version in its manifest. In BRAT, add the repository as a beta plugin and select the required release if BRAT does not select it automatically. Enable AI Bridge after installation.

## Mobile trial gate

The mobile trial remains blocked until F4 completes and the owner approves OAB-11. Do not install this plugin on an iPhone or iPad for the trial before that approval. After approval, use only a separate copied vault for the mobile trial. An iCloud-synchronized real-vault plugin directory is not a safe mobile test target during F4.
