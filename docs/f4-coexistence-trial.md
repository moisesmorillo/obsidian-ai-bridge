# F4 coexistence trial procedure

## Authority and limits

The supervisor performs every real-vault action for the owner. Agents do not access the vault, its metadata, directory listings, or backup. Do not verify or inspect the backup.

The supervisor relayed backup confirmation on 2026-11-05: `~/vaults/backups/Vault-2026-11-05T124852Z.zip`, with a sha256 manifest. The supervisor owns any further confirmation. This guide does not claim trial completion.

F4 runs on the Mac for no more than fourteen days. Do not install or run the plugin on mobile for F4. Keep iCloud active as the owner of the live vault. Do not change cloud resources.

OAB-10.1 remains In Progress. Its control names and behavior remain provisional and unverified. This guide does not claim that OAB-10.1 controls merged or passed review.

## Build and install

Use a checkout updated to the current `main` branch. Do not build from this feature branch. Record the source revision in OAB-10 notes:

```sh
git branch --show-current
git rev-parse HEAD
bun run --filter @obsidian-ai-bridge/plugin build
```

The branch command must report `main`. Record the revision from `git rev-parse HEAD` as the build revision. The build writes `apps/plugin/dist/main.js` and `apps/plugin/dist/manifest.json`.

The supervisor creates `.obsidian/plugins/ai-bridge` in the real vault and copies those two files into it. The supervisor performs these steps for the owner. Do not install from this guide alone.

Keep the plugin disabled until the supervisor confirms a safe activation sequence. That sequence must enable coexistence before any plugin sync effect. Do not enable or use the plugin while coexistence is off. If the approved build does not support this sequence, stop before trial use and ask the supervisor to resolve it. Do not infer control names or behavior from this guide.

## Coexistence operation

Keep the plugin on the Mac only. Coexistence mode requires owner confirmation before local delete and rename events can publish. A `*.icloud` placeholder is unavailable, not evidence of a delete. Do not read or publish placeholder bytes.

Review each confirmation item in the plugin panel. The delete or rename action needs an explicit owner choice. The safe server-state action clears that confirmation and lets normal reconciliation restore a missing source. It does not authorize a delete. Preserve edited destination bytes. Never infer a delete from absence alone.

Review every attention reason. Use only the action offered for that reason. Stop and ask the supervisor to assess any unavailable, stale, or unexplained item. Do not resolve it by resetting state or by changing server data.

Text application checks its observed hash during the Obsidian write. Binary application has a best-effort residual window between its final metadata check and the write. The plugin preserves a pre-apply copy, but this does not remove that window. iCloud and the owner can write the same files during F4.

Pause stops publishing and applying but retains queues and confirmation items. Resume continues with those retained items; it does not create new authority or erase work. Exit coexistence only when the confirmation queue is empty and the owner chooses to disable the plugin or turn coexistence off for the separately authorized cutover. Do not treat the trial deadline as permission for automatic cutover. F6 cutover needs separate owner authorization and its own procedure.

## Collect service measurements

The supervisor creates `$HOME/.config/obsidian-ai-bridge/f4/access.cookie` outside the repository and vault. Keep the directory private with mode `700` and the file private with mode `600`.

The file holds one line in this exact form, with an optional final line feed:

```text
CF_Authorization=<Cloudflare Access cookie value>
```

Use the `CF_Authorization` cookie value for the approved service. Do not add `Cookie:`, quotation marks, another cookie, spaces, or a second line. Do not place the value in command history, source code, or trial notes. The collector does not print the cookie or its file path.

Run the bounded collector from the repository root:

```sh
bun run --filter @obsidian-ai-bridge/tooling collect:f4 -- --cookie-file "$HOME/.config/obsidian-ai-bridge/f4/access.cookie"
```

The command sends one `GET` request to the fixed HTTPS origin at `/owner/measurements`. It rejects redirects and response bodies above 256 KiB. It validates the response with the public protocol schema. It prints only a safe summary. A 401 means Access did not authorize the request. A 403 means the configured owner check refused it. Other errors use static text.

The reader checks every observed path component for symlinks, rejects special files, opens the final file without following a symlink, and caps the read at 16 KiB. The Node file API does not open a child relative to each checked directory handle. A process that can replace a parent directory between the component check and file open could race that check. Keep the dedicated directory and its parent directories writable only by the owner. Do not run the collector if an untrusted process can change those directories. The collector does not accept a vault path or inspect vault directories.

Record these fields in OAB-10 notes: trial window, build revision, client ids, units, measurement windows, results, attention explanations, and measurement limits. Record actual dates and results there, not in this guide. Do not record credentials, cookies, owner subjects, paths, or raw responses.

The collector preserves the service's unknown and stale states, original windows, client cadence, and sample cap details. Request counts are observed lower bounds, not billing totals. Feed latency measures service-side response preparation, not end-to-end sync latency. Referenced R2 bytes do not measure bucket allocation or prove integrity. Feed times and interval bounds do not establish event causes or focused state.
