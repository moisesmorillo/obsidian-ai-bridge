# Plugin releases for BRAT

## Release flow

Release Please checks Conventional Commits on `main` and opens or updates a release PR for each changed component. The plugin component uses tag `ai-bridge-v<version>`. Its PR updates `apps/plugin/package.json`, `manifest.json`, and the compatibility map. The workflow syncs `versions.json` on the plugin release PR branch and preserves all earlier entries.

Merging the plugin release PR creates its tag and GitHub Release. The same workflow run checks out that tag, validates the release metadata, runs `bun run check`, and uploads only `main.js` and `manifest.json` to the Release Please release. Existing release assets are not replaced. A duplicate asset name fails the upload and needs owner review.

The owner can still push a matching tag by hand. That workflow checks the exact remote tag commit before it adds assets. Never move or reuse a published tag. The workflow token does not start another workflow from a Release Please tag or release. The same-run job performs the plugin build and asset upload instead.

Release PR synchronization uses the workflow token to push the compatibility map to the PR branch. Repository settings must allow GitHub Actions to write contents and pull requests. The bot-created commit does not trigger a separate pull-request workflow. If branch policy or token permissions block the push, the release PR needs an owner update before merge.

## Install from BRAT

BRAT installs releases from `moisesmorillo/obsidian-ai-bridge`. The plugin needs the Obsidian version in its manifest. In BRAT, add the repository as a beta plugin and select the required release if BRAT does not select it automatically. Enable AI Bridge after installation.

## Mobile trial gate

The mobile trial remains blocked until F4 completes and the owner approves OAB-11. Do not install this plugin on an iPhone or iPad for the trial before that approval. After approval, use only a separate copied vault for the mobile trial. An iCloud-synchronized real-vault plugin directory is not a safe mobile test target during F4.
