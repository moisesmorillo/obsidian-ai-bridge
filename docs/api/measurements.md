# Service measurements API

`GET /owner/measurements` returns bounded service observations to the verified configured owner. It uses Cloudflare Access and returns `Cache-Control: no-store`. The owner console links to `/owner/measurements?format=html` for an accessible summary. The JSON route is the default.

## Measurement boundaries

The request counts are observed lower bounds. The service counts each provider-verified REST `/v1/*` or MCP `/mcp` HTTP request once at resource-router entry. It includes application errors, retries, cancellations, revocation refusals, and every feed page. It excludes owner pages, OAuth, discovery, anonymous requests, and internal RPC calls. REST and MCP totals remain separate. These counts do not represent billed Worker or Durable Object invocations.

Request observations contain a verified client ID. The service does not infer a device or event source from names, headers, or user-agent values. It retains at most 128 client IDs per UTC day. When this cap fills, it preserves existing IDs, counts totals, marks coverage incomplete, and leaves omitted clients unknown. No zero count is inferred for an unobserved client.

Each daily window starts at UTC midnight and ends at the next UTC midnight. The response gives its bounds, observation start and end, and partial or incomplete coverage. Counts use actual observations, not a daily-rate estimate. The first observation on a new UTC day rotates the aggregate. Earlier data does not appear as a fresh zero. Stale values retain their original windows.

The aggregate stores the first and latest successful request times separately from the overall observation window. The response includes this request observation window. Feed samples cannot refresh request freshness. Ten minutes without a successful request observation marks request data stale. If no request observation succeeded, request counts, request window, and client rows are unknown.

The Worker can persist request and feed observations out of timestamp order. Same-day observations still update totals. The window start and end keep their minimum and maximum timestamps. The request freshness time keeps the maximum request timestamp. Older feed requests do not move a client cadence time backwards. Samples sort by observation time. The 2,048-sample cap retains the latest samples by timestamp.

## Feed latency

`feed_latency.p95` measures successful `/v1/changes` response preparation in milliseconds. Its start is authenticated resource-router entry. Its end is the successful handler response headers. It excludes lazy body production, network transfer, plugin apply time, and publication-to-device delay. This is not end-to-end sync latency. Empty successful pages count. Failed requests and preparation canceled before headers do not add a sample. Metrics do not read, clone, or buffer response bodies.

The service retains the latest 2,048 successful samples per UTC day. The response shows retained and total sample counts and first and last retained sample times. When retained count is lower than total count, earlier samples were removed by the cap. The p95 uses nearest rank `ceil(0.95 * n)` with no interpolation. No samples means `p95: null`, not zero. Ten minutes without a successful sample marks latency stale.

Client rows show last feed request time and minimum and maximum observed intervals in milliseconds. These values describe request cadence only. They do not identify local event origin, focused state, or the cause of a local edit.

## Storage observations

`storage.database_bytes` reports physical SQLite allocation at owner-read time. `storage.referenced_blob_bytes` reports the sum of each distinct hash referenced by a live file or a retained nondeleted revision. A repeated hash counts once. Inconsistent sizes for one hash make the referenced-byte value unknown. An empty reference set returns a known zero.

These bytes do not report bucket allocation, orphaned R2 objects, or a fresh R2 integrity check. A storage read failure returns an explicit unknown status, never zero.

## Response states

Each value uses `status: "observed"` with a value, or `status: "unknown"` with a safe reason where defined. Known zero and unknown have different representations. Empty latency samples have a null p95. `stale` marks old values without erasing them. `coverage: "unknown"` marks incomplete client coverage; it does not mean that recorded totals are zero.

This contract measures service requests, feed preparation, and referenced storage only. Plugin event classification and plugin display remain separate work. Two-test-vault live evidence is a follow-up and must record client IDs, times, and results only. No vault content belongs in the evidence.
