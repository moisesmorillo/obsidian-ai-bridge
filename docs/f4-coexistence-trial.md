# F4 coexistence trial procedure

## Authority and limits

The supervisor performs every real-vault action for the owner. Agents do not access the vault, its metadata, directory listings, or backup. Do not verify or inspect the backup.

The supervisor relayed backup confirmation on 2026-11-05: `~/vaults/backups/Vault-2026-11-05T124852Z.zip`, with a sha256 manifest. The supervisor owns any further confirmation. This guide does not claim trial completion.

F4 runs on the Mac for no more than fourteen days. Do not install or run the plugin on mobile for F4. Keep iCloud active as the owner of the live vault. Do not change cloud resources.

The names and controls introduced by OAB-10.1 remain provisional until that task merges. Confirm their final labels and behavior from the merged plugin before use.

## Build and install

From the repository root, build the plugin:

```sh
bun run --filter @obsidian-ai-bridge/plugin build
```

The build writes `apps/plugin/dist/main.js` and `apps/plugin/dist/manifest.json`. Create `.obsidian/plugins/ai-bridge` in the real vault, then copy those two files into it. The supervisor performs these steps for the owner. Do not install from this instruction alone.

In Obsidian on the Mac, enable **AI Bridge** in Community plugins. Open its settings and connect the owner-approved service. Complete the authorization flow and confirm that the plugin reports a connected state. Keep coexistence mode off until connection and the owner-approved trial setup both succeed. Then enable coexistence mode before normal trial use. Stop if the expected mode control or confirmation behavior is absent.

## Coexistence operation

Keep the plugin on the Mac only. Coexistence mode requires owner confirmation before local delete and rename events can publish. A `*.icloud` placeholder is unavailable, not evidence of a delete. Do not read or publish placeholder bytes.

Review each confirmation item in the plugin panel. The delete or rename action needs an explicit owner choice. The safe server-state action clears that confirmation and lets normal reconciliation restore a missing source. It does not authorize a delete. Preserve edited destination bytes. Never infer a delete from absence alone.

Review every attention reason. Use only the action offered for that reason. Stop and ask the supervisor to assess any unavailable, stale, or unexplained item. Do not resolve it by resetting state or by changing server data.

Text application checks its observed hash during the Obsidian write. Binary application has a best-effort residual window between its final metadata check and the write. The plugin preserves a pre-apply copy, but this does not remove that window. iCloud and the owner can write the same files during F4.

Pause stops publishing and applying but retains queues and confirmation items. Resume continues with those retained items; it does not create new authority or erase work. Exit coexistence only when the confirmation queue is empty and the owner chooses to disable the plugin or turn coexistence off for the separately authorized cutover. Do not treat the trial deadline as permission for automatic cutover. F6 cutover needs separate owner authorization and its own procedure.

## Measurement record and collection status

Record these fields in OAB-10 notes: trial window, build revision, client ids, units, measurement windows, results, attention explanations, and measurement limits. Record actual dates and results there, not in this guide. Do not record credentials, cookies, owner subjects, paths, or raw responses.

Collection remains staged until the published measurement adapter exists. The tooling in this change accepts a local adapter and formats only an allowlisted safe projection. It does not connect to a service, define an endpoint response shape, or provide a working live collection command. Do not claim measurements until the published adapter and its validated integration are available.
