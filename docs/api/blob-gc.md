# Blob garbage collection API

The verified owner uses `GET /owner/blob-gc` to see a dry run and current collection state. The route uses Cloudflare Access, the configured service origin, and `Cache-Control: no-store`. The console lists the number of reclaimable blob objects and their combined byte size before it offers a confirmation form.

The owner submits `POST /owner/blob-gc` to confirm or continue collection. The route requires the same-origin `Origin` header, a browser-bound one-use CSRF token, and verified owner Access. Each request starts or advances one bounded batch. Durable Object alarms continue a confirmed run until it reaches the idle phase.

Collection lists only canonical `blobs/<sha256>` keys in the existing R2 bucket. It never lists or deletes `backups/` objects. SQLite marks each candidate only after it checks current files, every retained revision, and active packed-export blob sources in a transaction. `blob_refs` alone does not establish reachability or inventory all R2 objects.

The owner page shows the current phase, marked object count, marked bytes, and a typed storage-failure state. A failed R2 delete keeps its marks. A later confirmed request or alarm retries the idempotent delete. A mark or generation change between blob HEAD evidence and the final publish transaction returns HTTP 503 with `blob_gc_in_progress` and `retry_after_seconds: 1`.

Preview does not change marks. The confirmed run rechecks every candidate in SQLite before marking it. Each inventory call reads one page. Each SQLite and R2 operation handles at most 100 hashes. One preview reads at most 32 R2 pages; a larger inventory returns an unavailable response and does not start deletion. Confirmed runs persist the R2 cursor and continue in later bounded batches.
