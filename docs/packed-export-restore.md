# Restore a packed baseline into a new local vault

A packed baseline contains the current live file set at one immutable cut. It does not contain deleted paths, retained history, client grants, or service import state. The archive does not replace the service vault or change its epoch.

The Worker creates a packed baseline every hour. Owner requests can start another baseline. Scheduled and owner-started archives use the `oab-backups` R2 bucket and keys under `backups/`. The `cloudflare-infra` lifecycle rule deletes those objects after 15 days and aborts incomplete multipart uploads after seven days. The Worker does not prune archives. Failed exports appear on `/owner/exports` without download links. If a completed archive is missing at download time, the response directs the owner to `/owner/exports` to create a new export.

## Download and verify

1. Open `/owner/exports` while signed in through Cloudflare Access.
2. Wait for a completed export. Confirm its timestamp and byte size under **Completed snapshots**.
3. Download that snapshot. An incomplete export does not have a download link.
4. Extract the ZIP into a new empty staging directory. Use an extractor that rejects absolute paths, `..` path segments, duplicate paths, and paths outside the staging directory.
5. Read `manifest.json`. Check its epoch, head sequence, timestamp, path order, and file count. The `files` array lists each archived path, exact revision, SHA-256 hash, and byte size.
6. For every manifest entry, read `files/<path>`. Check its byte size and SHA-256 hash against the manifest. Stop if any entry is missing or differs.

## Create a local vault

1. Create a new empty Obsidian vault outside iCloud Drive.
2. Copy each verified `files/<path>` payload to the same relative path in that vault. Do not copy `manifest.json` or the archive's `files/` prefix.
3. Keep the original archive and manifest as recovery evidence. Do not merge these files into a populated vault.
4. Before sync, check that the local vault and configured service host are the intended pair. This feature restores local files only. It does not import files into a new service vault or reset the service epoch.
5. If sync finds newer remote data, use the normal conflict policy. Do not replace remote content by editing SQLite, changing revision numbers, or bypassing `If-Match`.

The owner console download remains behind Cloudflare Access. The packed archive contains only current live files and its manifest. It does not contain Obsidian account secrets or OAuth grants.
