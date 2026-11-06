# Plugin releases for BRAT

## Release flow

The owner creates and pushes a tag named `plugin-v<version>` after this change merges. For the current plugin, the tag is `plugin-v0.1.0`. The workflow checks the tag against `apps/plugin/manifest.json` and `apps/plugin/versions.json`, then runs `bun run check`.

The check builds `apps/plugin/dist/main.js` and copies the manifest to `apps/plugin/dist/manifest.json`. The workflow creates a GitHub release with those two files. It does not publish `versions.json` as a release asset. The compatibility map stays in the repository.

When a plugin version or minimum Obsidian version changes, update both `manifest.json` and the matching entry in `versions.json`. Use exact `major.minor.patch` numbers. Keep `isDesktopOnly` false for the mobile release. Merge the metadata change before the owner creates its matching tag.

The workflow rejects invalid metadata, failed checks, a tag that points to another commit, and a tag with an existing release. It does not replace release assets. If validation or a check fails, correct the source and merge a new change. Do not move or reuse a published tag. If a release already exists, make a new plugin version and tag. The owner creates all release tags. This task does not create a tag or release.

## Install from BRAT

BRAT installs releases from `moisesmorillo/obsidian-ai-bridge`. The plugin needs Obsidian `1.13.0` or later for version `0.1.0`. In BRAT, add `moisesmorillo/obsidian-ai-bridge` as a beta plugin and select the required release if BRAT does not select it automatically. Enable AI Bridge after installation.

## Mobile trial gate

The mobile trial remains blocked until F4 completes and the owner approves OAB-11. Do not install this plugin on an iPhone or iPad for the trial before that approval. After approval, use only a separate copied vault for the mobile trial. An iCloud-synchronized real-vault plugin directory is not a safe mobile test target during F4.
