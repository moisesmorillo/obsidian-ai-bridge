# Move one device to the Vaultwire plugin ID

Stop Obsidian on every device before migration. Do not sync or copy between devices during these steps. The owner accepts a full reconnect to the new service address after the cutover.

## Desktop

1. Close Obsidian. Make a full backup of the vault.
2. Run `bun apps/plugin/tools/migrate-plugin.ts "$HOME/path/to/vault"` from the repository root. Use the full path to the intended vault. The tool refuses paths without `.obsidian/plugins`, an existing `vaultwire` folder, symbolic-link source data, and an existing backup.
3. Confirm `.obsidian/plugins/ai-bridge-vaultwire-backup/data.json` exists. The tool keeps `.obsidian/plugins/ai-bridge` unchanged and copies only `data.json` to `.obsidian/plugins/vaultwire/data.json`.
4. Install the Vaultwire plugin files into `.obsidian/plugins/vaultwire`. Do not install into or remove `ai-bridge`.
5. Start Obsidian. Disable AI Bridge and enable Vaultwire. Check the shared settings, then reconnect to the Vaultwire service. Check that pending edits, attention items, and local notes remain present before normal use.

If migration stops before step 3, the old folder remains unchanged. Keep the vault backup and the migration backup. Do not remove either plugin folder. A failed stage copy leaves no Vaultwire folder. If the backup path exists, stop and inspect it instead of overwriting it.

## iPhone and iPad

1. Stop Obsidian on all devices. Make a complete vault backup in Files or the approved vault backup location.
2. In Files, open the vault's `.obsidian/plugins` folder. Copy `ai-bridge/data.json` into a new `vaultwire` folder. Keep the original folder and all its files. If `vaultwire` already exists, stop and inspect it. Do not replace files.
3. Install or update Vaultwire so its manifest, `main.js`, and `styles.css` are in the `vaultwire` folder. Do not delete `ai-bridge`.
4. Start Obsidian. Disable AI Bridge, enable Vaultwire, inspect settings, then reconnect to the Vaultwire service. Confirm local edits and plugin state before normal use.

## Device-only state

The journal uses the stable Obsidian local-storage key `obsidian-ai-bridge:device-state:v1`. Credentials and settings-sync consent also use stable local keys when the platform does not provide secret storage. The plugin payload files remain under the vault's `.ai-bridge/pending` path. These items are not in `data.json` and are not copied by the migration command. Keep the same vault and Obsidian application data. Do not clear application data or reset plugin state. Obsidian local storage does not move when a folder is copied. This procedure does not claim to copy it.

A new service address needs a full reconnect. The old plugin folder and the backup stay in place until the owner verifies migration and unsynced edits on each device. Remove neither during this task.
