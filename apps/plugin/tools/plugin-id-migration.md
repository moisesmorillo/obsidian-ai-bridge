# Move one device to the Vaultwire plugin ID

Stop Obsidian on every device before cutover. Keep AI Bridge disabled before Obsidian starts again. Do not sync between devices during migration. Reconnect only after the new service is ready.

## Desktop

1. In Obsidian, disable AI Bridge in Community plugins. Confirm it stays disabled, then close Obsidian.
2. Make a complete vault backup.
3. Run `bun apps/plugin/tools/migrate-plugin.ts "$HOME/path/to/vault"` from the repository root. Use the full path to the intended vault.
4. The command refuses if `community-plugins.json` enables AI Bridge or Vaultwire. It copies `data.json` to `.obsidian/plugins/vaultwire` and verifies a backup at `.obsidian/plugins/ai-bridge-vaultwire-backup/data.json`.
5. Start Obsidian with AI Bridge disabled. Use BRAT to install Vaultwire. Keep Vaultwire disabled until the new service is ready.
6. After cutover, enable Vaultwire. It keeps copied settings disconnected until a successful Connect flow. Check the imported service address and local state, then click Connect and complete OAuth against the new service. Check pending edits, attention items, and notes before normal use.

The command keeps the old folder unchanged. If it fails during the first backup copy, it removes the incomplete backup directory and leaves the old data. A failed staged copy leaves a verified backup and no Vaultwire folder. Inspect the backup and old folder before you retry.

## iPhone and iPad

1. In Obsidian, disable AI Bridge in Community plugins. Confirm it stays disabled, then close Obsidian.
2. After cutover, reopen Obsidian with AI Bridge disabled. Use BRAT to install Vaultwire, then enable Vaultwire.
3. When old AI Bridge settings exist and Vaultwire has no `data.json`, startup keeps Vaultwire disconnected. Run **Migrate AI Bridge settings to Vaultwire** from the command palette.
4. The command refuses while AI Bridge remains enabled, while Vaultwire is connected or active, or when Vaultwire already has settings. It copies the old `data.json` and creates a verified backup. It does not change journal state or payloads.
5. The Vaultwire settings page becomes available. Keep AI Bridge disabled. Check the imported service address and local state. Click Connect and complete OAuth only when the new service is ready.

Use BRAT for the plugin files. In BRAT, add the repository `moisesmorillo/vaultwire` as a beta plugin. Do not use Files to open the hidden `.obsidian/plugins` directory. The iOS procedure uses Obsidian adapter access and the explicit command above. Do not remove either plugin folder during this task.

## Device-only state

The journal uses the stable Obsidian local-storage key `obsidian-ai-bridge:device-state:v1`. Credentials and settings-sync consent also use stable local keys when the platform does not provide secret storage. Migration target approval uses a separate device-local key and records only after successful OAuth. Pending payloads stay under `.ai-bridge/pending`. Migration does not copy or reset these values. Keep the same vault and Obsidian application data. Do not clear application data or reset plugin state. A folder copy does not move localStorage.

The desktop command and migration logic have temporary-fixture tests. No real device or real vault test is part of this task. Device verification belongs to OAB-50.6.
