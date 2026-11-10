---
id: OAB-53
title: Profile Worker admission heap and native memory
status: Done
assignee:
  - '@claude'
created_date: '2026-11-09T22:05:00Z'
updated_date: '2026-11-10T20:53:00Z'
labels: []
dependencies: []
references:
  - docs/spec.md
ordinal: 94000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The admission byte reservations bound identified application payloads but do not prove total V8 heap or native memory use. This profiling work must run before another concurrency increase or after an exceeded-memory event, without access to the owner's personal vault.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Measure peak Worker heap and native memory for representative REST and MCP admission workloads
- [x] #2 Compare measured peaks with the 128 MB isolate limit and record the workload, runtime, and limits
- [x] #3 Keep application byte reservations distinct from measured heap and native memory
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved 2026-11-10 (combined with OAB-6.8.2 evidence).
0. Read-only tool check: Cloudflare read-only token can query GraphQL invocation status (exceededResources); owner console shows isolate start; Mac plugin session token works on /mcp or not. No deploy.
1. Local profile in this worktree: tooling load script against wrangler dev (workerd, compat 2025-07-12). REST (vault, changes, files, search), MCP, concurrent uploads, slow responses, cancellations, OAB-58 stalled reads past the 60 s grace. Concurrency 1/4/8/12. Measure V8 heap via inspector and workerd RSS. Separate app reservations, heap, native (RSS minus heap), total.
2. Production confirmation by the supervisor: Mac sync paused, load sent through the plugin session from Obsidian, iPad and ChatGPT idle. Uploads into _vaultwire-loadtest/ then deleted (owner D1). Step up load, check exceededResources, isolate restarts and console after each level, stop at first failure. Resume sync, cursor = head.
3. Record numbers in OAB-53 and OAB-6.8.2 notes. Check only proven criteria. Propose any limit change as a separate task.
Owner decisions: D1 scratch-folder uploads in production; D2 iPad and ChatGPT idle about 30 min; D3 no deploy, small PR only with authorization; D4 one branch under OAB-53.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner-approved plan pn-f28109 defers complete heap and native-memory profiling. Start before another concurrency increase or after an exceeded-memory event. OAB-52 enforces application reservations only.

Step 1 local profile, 2026-11-10 UTC. Local only: loopback workerd, synthetic Access key, synthetic vault under scratch persistence. No deploy, no Cloudflare API, no real vault. Acceptance criteria stay unchecked until the production confirmation (step 2).

## Runtime

- Tool: `apps/worker/tooling/memory-profile/local.ts` (runner, Node) and `workloads.ts` (portable workloads, Web APIs only). Run from `apps/worker`: `node tooling/memory-profile/local.ts --out <scratch dir> [--v8-flags "--expose-gc --max-heap-size=128"]`.
- Bundle: real `src/index.ts` built by `wrangler deploy --dry-run` (no upload) with `wrangler.f2.jsonc`: compatibility date 2025-07-12, flag `unhandled_rejection_after_microtask_checkpoint`, synthetic Access team, OAUTH_KV, R2_BUCKET, BACKUP_BUCKET.
- Engine: Wrangler 4.149.0 and Miniflare 5.20261006.1-alpha (workerd 1.20261006.1), the versions of the Workers test pool. The pinned deploy Wrangler 4.45.0 (workerd 1.20251011.0) rejects the production flag ("No such compatibility flag"). Node v26.13.0. macOS arm64.
- Topology: two Miniflare Workers in one workerd process. `api` runs the Worker entry; `vault` hosts the Vault Durable Object through a cross-script binding. Each has its own V8 isolate, like production. A first attempt with `wrangler dev` put Worker and DO in one isolate and was discarded.
- Auth: real dynamic registration, Access consent, PKCE code flow, and bearer token. An outbound service answers only the synthetic Access JWKS. No product code change and no auth bypass.
- Two runs at the same time on separate ports: run B with V8 flags `--expose-gc --max-heap-size=128` (V8 heap capped at 128 MB, local proxy for the platform limit) and run A with `--expose-gc` only (no cap). Each run is one workerd process.

## Method

- V8 heap: `Runtime.getHeapUsage` every 50 ms on each isolate through the workerd inspector (usedSize, totalSize, backingStorageSize). `gc()` through `Runtime.evaluate` before each level gives the heap floor (workerd does not answer `HeapProfiler.collectGarbage`).
- Process: `ps -o rss=` every 50 ms on the single workerd process.
- Application reservations: `/owner/measurements?format=json` every 500 ms (worker_isolate: rest_read_bytes, shared_bytes, held REST/MCP leases). These are reservations, not memory.
- Derived: RSS−heaps = RSS minus committed heaps of both isolates at the samples nearest the RSS peak. It includes backing stores, workerd runtime and code, SQLite, local R2/KV simulation, and Miniflare internal Workers. It is not a native-retention measure for production.
- Fixtures under `_vaultwire-loadtest/`: 300 small notes (2,048 B), 12 notes of exactly 1,000,000 UTF-8 bytes (accented text, so V8 holds two-byte strings; quotes and newlines for JSON escaping), one 25,000,000-byte blob. Search needle only on line 1 of each note.
- Workloads at concurrency 1/4/8/12, 8 s each, one client: REST `/v1/vault`, `/v1/changes` (limit 1000), 1 MB text GET, `/v1/search` (limit 50); MCP `read_note` (1 MB), `list_notes`, `search_notes` (limit 50); uploads of 1 MB text (4 per loop) and 25 MB blobs (2 per loop); slow consumers (50 ms between reads, cancel after 10 s text/MCP or 6 s blob); cancel right after headers (text, blob, MCP). After each level the runner waits until held leases and reserved bytes are zero (max 135 s). OAB-58 phase: 4 REST blob GETs + 8 MCP 1 MB reads held unread after the first chunk for 125 s, then REST text c4 + MCP read c8 for 8 s, then client release.

## Peaks, run B (V8 heap cap 128 MB). Decimal MB. "used / total+backing" per isolate.

| Workload | C | Statuses | API used / total+backing | Vault used / total+backing | RSS | RSS−heaps | REST read / shared MB | Held R/M | Release ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| idle-cold | | | 21.1 / 28.6 | 20.5 / 27.8 | 170.3 | 114.3 | 0 / 0 | 0/0 | |
| baseline after warm-up + gc | | | 18.3 / 28.9 | 15.4 / 28.4 | 381.9 | 325.1 | 0 / 0 | 0/0 | |
| rest-vault | 1/4/8/12 | 429 at 8 (10) and 12 (121) | ≤ 25.0 / 51.4 | ≤ 35.9 / 41.5 | ≤ 643.6 | ≤ 572.3 | 0 / 0 | 0/0 | ≤ 393 |
| rest-changes-1000 | 1/4/8/12 | 429 at 8 (1), 12 (31) | ≤ 38.8 / 65.7 | ≤ 18.8 / 36.0 | ≤ 645.0 | ≤ 576.4 | 0 / 0 | 0/0 | ≤ 248 |
| rest-text-1mb | 1 | 200×521 | 54.1 / 66.1 | 22.3 / 36.2 | 659.2 | 593.3 | 0 / 0 | 0/0 | 220 |
| rest-text-1mb | 4 | 200×597 | 52.3 / 65.1 | 113.2 / 129.3 | 730.2 | 556.7 | 0 / 0 | 0/0 | 419 |
| rest-text-1mb | 8 | 200×609 429×3 | 52.1 / 63.6 | 117.0 / 131.3 | 746.2 | 586.6 | 0 / 0 | 0/0 | 296 |
| rest-text-1mb | 12 | 200×601 429×106 | 53.7 / 67.0 | 117.3 / 131.0 | 751.8 | 596.8 | 0 / 0 | 0/0 | 26 |
| rest-search-50 | 1/4/8/12 | 429 at 8 (3), 12 (107) | ≤ 25.4 / 61.9 | ≤ 27.3 / 33.4 | ≤ 646.8 | ≤ 584.3 | 0 / 0 | 0/0 | ≤ 389 |
| mcp-read-note-1mb | 1 | 200×498 | 47.4 / 60.8 | 117.6 / 132.1 | 770.8 | 593.4 | 0 / 0 | 0/0 | 364 |
| mcp-read-note-1mb | 4 | 200×573 | 53.5 / 67.7 | 117.2 / 131.3 | 773.3 | 597.0 | 0 / 0 | 0/0 | 323 |
| mcp-read-note-1mb | 8 | 200×592 | 49.2 / 64.9 | 118.0 / 131.0 | 795.1 | 630.9 | 0 / 0 | 0/0 | 189 |
| mcp-read-note-1mb | 12 | 200×613 | 57.7 / 72.3 | 115.0 / 128.2 | 805.0 | 620.8 | 0 / 0 | 0/0 | 346 |
| mcp-list-notes | 1/4/8/12 | all 200 | ≤ 29.8 / 46.4 | ≤ 33.7 / 39.9 | ≤ 757.0 | ≤ 683.7 | 0 / 0 | 0/0 | ≤ 312 |
| mcp-search-notes-50 | 1/4/8/12 | all 200 | ≤ 27.7 / 64.0 | ≤ 25.7 / 37.0 | ≤ 756.1 | ≤ 689.4 | 0 / 0 | 0/0 | ≤ 450 |
| upload-text-1mb | 1/4/8/12 | 201; 429×11 at 12 | ≤ 55.6 / 90.4 | ≤ 55.0 / 70.3 | ≤ 799.8 | ≤ 673.0 | 0 / 0 | 0/0 | ≤ 399 |
| upload-blob-25mb | 1/4/8/12 | 201; 429×3 at 12 | ≤ 22.5 / 79.1 | ≤ 18.8 / 25.2 | ≤ 764.1 | ≤ 711.5 | 0 / 0 | 0/0 | ≤ 435 |
| slow-text-1mb | 1/4/8/12 | 200; 429 at 8 (2), 12 (3) | ≤ 38.9 / 52.3 | ≤ 53.3 / 64.0 | ≤ 737.7 | ≤ 651.2 | 0 / 0 | 0/0 | ≤ 331 |
| slow-blob-25mb | 1 | 200×2 | 19.8 / 38.5 | 18.1 / 23.9 | 696.7 | 643.5 | 9.0 / 0 | 2/0 | 113,891 |
| slow-blob-25mb | 4/8/12 | 200×4; 429×28/132/236 | ≤ 28.5 / 38.4 | ≤ 20.6 / 27.3 | ≤ 702.2 | ≤ 640.9 | 18.0 / 0 | 4/0 | ≈ 111,700 |
| slow-mcp-read-note-1mb | 1/4/8/12 | all 200 | ≤ 35.5 / 47.9 | ≤ 52.1 / 61.7 | ≤ 744.0 | ≤ 646.1 | 0 / 0 | 0/0 | ≤ 374 |
| cancel-text-1mb | 1/4/8/12 | 200; 429 at 8 (103), 12 (198) | ≤ 44.7 / 58.0 | ≤ 117.7 / 131.0 | ≤ 852.1 | ≤ 693.7 | 0 / 0 | 0/0 | ≤ 407 |
| cancel-blob-25mb | 1/4/8/12 | 200×4; 429×31/124/249/372 | ≤ 30.4 / 37.4 | ≤ 23.3 / 28.9 | ≤ 729.6 | ≤ 674.4 | 18.0 / 0 | 4/0 | ≈ 111,500–112,000 |
| cancel-mcp-read-note-1mb | 1/4/8/12 | all 200 | ≤ 46.6 / 61.7 | ≤ 117.7 / 130.7 | ≤ 814.3 | ≤ 635.6 | 0 / 0 | 0/0 | ≤ 369 |
| stall hold 125 s (4 REST + 8 MCP) | | 12×200 | 30.0 / 46.3 | 28.0 / 39.5 | 706.8 | 632.9 | 18.0 / 0 | 4/0 | |
| stall + REST text c4 + MCP read c8 | | 200×203; 200×400 | 46.9 / 62.3 | 117.3 / 128.9 | 817.2 | 652.2 | 0 / 0 | 0/0 | |
| overall | | | 57.7 / 90.4 | 118.0 / 132.1 | 852.1 | 693.7 | 18.0 / 0 | 4/0 | |

Post-collection estimate, run B: the largest heap value right after a drop of at least 4 MB between samples was ≤ 33 MB for API and ≤ 25 MB for Vault in every level. Heap floor after `gc()` before each level: API 15–19 MB, Vault 14–18 MB.

## Peaks, run A (no V8 cap)

V8 grows the heap lazily without a cap, so peaks are an upper bound of garbage, not demand. API used ≤ 81.7 MB (total+backing ≤ 172.8 MB). Vault used ≤ 676.4 MB (total+backing ≤ 707.5 MB), reached by 1 MB text and MCP reads and cancels (for example mcp-read-note-1mb c4: Vault 603.5 / 684.3 MB). RSS ≤ 1,592.7 MB, RSS−heaps ≤ 863 MB. Statuses and release times match run B, except the 7 client-side failures noted below. Run A is not a demand measurement; it shows that without heap pressure the Vault isolate keeps hundreds of MB of collectable garbage.

## Comparison with the 128 MB isolate limit

- API Worker isolate, capped run: peak heap used 57.7 MB, peak committed heap plus backing stores 90.4 MB (upload-text c12). Headroom ≥ 37.6 MB to 128,000,000 B. Post-collection heap ≤ 33 MB.
- Vault DO isolate, capped run: the heap fills to the cap (used ≤ 118.0 MB) during 1 MB text and MCP reads at every concurrency, then V8 collects. Committed heap plus backing stores peaked at 132.1 MB (= 126.0 MiB): above 128,000,000 B, below 128 MiB. Post-collection heap ≤ 25 MB. Run B had no isolate failure, no workerd exit, no 5xx, and no client failure. Run A had no 5xx and no workerd exit, but 7 client-side failures (status 0: rest-changes c12 ×3, upload-blob c12 ×4) with no server error logged; the cause was not isolated.
- Interpretation: under a 128 MB V8 heap cap every workload at concurrency 1–12 completed. The Vault peak is V8 sizing near its cap, not live data. The `--max-heap-size` flag excludes backing stores, and the platform accounting of backing stores is not known here. The Vault isolate has the smallest margin; production must confirm it.

## Application reservations (kept apart from heap and native memory)

- REST read pool peaked at 18,000,000 B (4 × 4,500,000) only while REST leases were held (stalled, slow-blob, cancel-blob). Shared pool peaked at 0 B in the sampled snapshots (MCP reservations last only for the request; 500 ms sampling missed them). Peaks of reservations do not coincide with heap peaks: Vault heap peaks happened with 0 reserved bytes in the API isolate snapshot.
- The 82,000,000 B combined reservation ceiling describes the API isolate. Measured API heap peaks (≤ 57.7 MB used, ≤ 90.4 MB committed+backing) stayed below 128 MB with these workloads. The Vault isolate holds no admission byte reservations; its memory is outside the admission model.

## Findings

1. Cancelled or abandoned blob reads hold REST capacity until the OAB-58 reclaim. A 25 MB blob GET cancelled after headers, or mid-body, kept its REST lease and 4,500,000 reserved bytes for about 111–114 s after the level, which matches the 60 s lease plus 60 s grace. Four cancelled blob reads filled the REST pool and refused later REST reads with 429. Workerd logged `READ_SETTLEMENT_FAILED`. Text and MCP cancels released at once. The S4 local run saw the same 429 pattern. Local R2 simulation may differ from production R2; step 2 should check `held_rest_slots` after one cancelled blob read.
2. OAB-58 reclaim works locally: after 125 s of 4 stalled REST blob reads (18,000,000 B held), new REST text reads at c4 returned 200×203 with no 429. The 8 stalled MCP reads were fully buffered by the socket (1 MB), so they held no MCP lease; the MCP stall case is not exercised by 1 MB notes.
3. Search cost: a needle on every line of 12 × 1 MB notes made one REST or MCP search take about 15.6 s locally, after which the local Vault DO restarted and then failed in its constructor ("Unexpected vault table: __miniflare_do_name", a Miniflare 5 local table that the strict schema check rejects). The restart cause was not isolated. The fixture now puts the needle on line 1 only (≈ 15 ms per search). Production impact unknown.
4. Local harness limits found: Bun does not complete requests through the Wrangler dev proxy (runner uses Node). Miniflare fails to start the api Worker when the working directory is `apps/worker` (runner changes to the output directory). Wrangler's inspector proxy rejects Node WebSockets without Origin.

## Limits

- Local workerd is not the production engine build. Production version, isolate placement, GC heuristics, and memory accounting may differ.
- Two runs shared the machine (separate processes and ports); timing and GC moments can differ from a solo run.
- RSS is one process for both isolates, Miniflare internal Workers, SQLite, and local R2/KV simulation. RSS−heaps is not production native retention. It grew from 114 MB idle to about 690 MB (B) and 863 MB (A) and did not return, which can be allocator retention or local storage caches.
- Categories that cannot be separated here: transport-retained RPC results, native response fragments, native stream buffers, SQLite page cache. backingStorageSize covers only ArrayBuffer backing stores.
- 50 ms heap and RSS sampling can miss shorter spikes. Heap "used" includes uncollected garbage.
- One client; no distributed-isolate fan-in; production spreads requests over many Worker isolates and one DO isolate.
- `--max-heap-size=128` is a local proxy for the 128 MB limit, not the platform enforcement mechanism.

Raw results (not committed): scratch `runA/results.json`, `runB/results.json` with all samples and phases.

## Step 2 reuse

`workloads.ts` exports `seedFixtures`, `createWorkloads`, `runLevel`, `openStalledReads`, and `deleteLoadtestFiles`. Each takes a `ProfileTarget` with `origin`, `token`, and an optional streaming `fetch`. The Worker sends no CORS headers, so a renderer `window.fetch` from `app://obsidian.md` cannot read responses. Obsidian `requestUrl` buffers whole bodies, so it suits only drain workloads, not slow or cancel workloads. A streaming `fetch` adapter over Node `https` in the desktop renderer, or Node on the Mac with the session token, covers all workloads. `bun build apps/worker/tooling/memory-profile/workloads.ts --format esm` gives one JavaScript module. Production seeding should lower `smallNotes`. Uploaded 25 MB blobs stay in R2 after `deleteLoadtestFiles` until blob GC. `/owner/measurements` needs the Access browser session. Check `held_rest_slots` after one cancelled blob read (finding 1).

Production confirmation 2026-11-10 18:50-19:40Z, Worker 1.0.3, Workers Free plan. Mac sync paused, iPad and iPhone closed, ChatGPT idle. Load sent from the Obsidian renderer through the Mac plugin session (Node https streaming fetch, token kept in memory). Fixtures in _vaultwire-loadtest/: 50 x 2 KB notes, 12 x 1 MB notes, one 25 MB blob. Results:
- No memory failure was observed. Every hard failure in Workers Observability was 'Worker exceeded CPU time limit' (error 1102, HTTP 503 when it happens before headers).
- The Free plan 10 ms CPU limit, not the 128 MB memory limit, is the first production limit. MCP read_note of a 1 MB note failed at concurrency 1 (8 of 20 sequential calls returned 1102). A 1 MB text upload failed at concurrency 1 (2 of 2 returned 503).
- When the CPU limit hits after headers, the client gets HTTP 200 with a cut body. Observed on GET /v1/manifest (every attempt cut at 0-24742 bytes while about 70 tombstones existed), /v1/changes (3 of 4 cut, even with limit=5) and /v1/vault once. Observability recorded these GETs as CPU-exceeded errors. This explains the OAB-58 truncated 200 better than edge compression.
- Each cut response leaves an incomplete read whose REST lease stays held until the OAB-58 reclaim (about 120 s). Retries then fill the 4-slot REST byte pool and get 429 admission_limited (Retry-After 2). The console showed REST 4 held, 18.0 MB reserved, oldest lease search 73 s; later 12 incomplete reads and 9 reclaimed leases on one isolate. The reclaim works in production.
- REST reads above concurrency 4 got 429 by design (18 MB / 4.5 MB). MCP was not measured above concurrency 1 because the plan stopped at the first 5xx.
- Cleanup deleted all 63 fixtures by path with If-Match. The Mac plugin 1.0.2 classified the cut feed as a network failure and caught up to cursor 728 = head after the reclaim window: settled, 298 files, no attention. Empty local loadtest folders were removed.
Conclusion for AC1/AC2: memory headroom in production cannot be reached before the CPU limit on Workers Free. Local peaks: Worker isolate 57.7 MB heap / 90.4 MB heap+buffers, Vault DO 118.0 / 132.1 MB. AC3 holds: reservations are recorded apart from heap and native memory.

Production run 2 on Workers Paid, 2026-11-10 20:20-21:05Z, Worker 1.0.4 with limits.cpu_ms 30000 (PR #163). Same setup: Mac paused, iPad, iPhone and ChatGPT idle, fixtures in _vaultwire-loadtest/.
- No memory failure. Workers Observability showed no exceeded-memory or exceeded-CPU outcome in this run.
- REST reads (vault, changes 1000, text 1 MB, search) and MCP reads (read_note 1 MB, list_notes, search_notes) returned only 200 at concurrency 1, 4, 8 and 12. No 429. Run 1 refusals came from CPU-killed responses that held leases.
- Slow consumers and text/MCP cancellations returned 200. slow-mcp-read-note-1mb c12 median 43 s. rest-changes-1000 median 5-15 s, max 32.6 s.
- Cancelled 25 MB blob reads hold REST capacity: cancel-blob c8 and c12 got 429 after the first cancels, and the next text uploads got 429 until the leases cleared. This confirms local finding 1 in production.
- Upload text 1 MB: c1 and c4 201. c12 gave 10 x 201 and 14 x 500. Observability: 'Durable Object is overloaded. Requests queued for too long.' Four stalled-read opens right after also got 500. After 130 s, REST text c4 and MCP read c4 returned 200 again. Upload blob 25 MB c4: 4 x 201.
- The single Vault Durable Object queue is the first production limit on Paid, not isolate memory.
- Cleanup deleted 87 files. Mac resumed to cursor 902 = head, settled, 298 files, no attention. Empty local folders removed.
Conclusion: AC1 is met by local heap and RSS peaks per workload plus production pass evidence up to concurrency 12. AC2: local peaks (Worker 90.4 MB heap+buffers, Vault DO 132.1 MB) compared with the 128 MB limit, and production showed no memory failure. AC3: reservations stay separate from heap and native observations.

Correction (review M1), 2026-11-10: the run 1 sentence "REST reads above concurrency 4 got 429 by design (18 MB / 4.5 MB)" is superseded. The 4-slot, 18,000,000-byte REST pool (4,500,000 bytes per read) refuses only when concurrent reads land on one isolate. Local run B shows this: one isolate, 429 at concurrency 8 and 12. Production spreads requests across Worker isolates; run 2 returned only 200 for REST reads up to concurrency 12. Leases held by CPU-cut responses explain the run 1 refusals.

Production runtime for run 2 (review L4): Worker 1.0.4 = release commit df96129 on origin/main (chore(main): release worker 1.0.4 (#164), after 9624be4 fix(worker): declare a 30 s CPU limit for production (#163)). Compatibility date 2025-07-12, flag unhandled_rejection_after_microtask_checkpoint, limits.cpu_ms 30000 (apps/worker/wrangler.production.jsonc). Run 1 used Worker 1.0.3 on Workers Free without limits.cpu_ms.

Cleanup rule for production drivers (review L11): call deleteLoadtestFiles(target) in a finally block around seeding and workloads, so a failed or interrupted run still removes _vaultwire-loadtest/ files. Blob bytes stay in R2 until blob GC.

Final AC1 conclusion (review M2): AC1 stays checked on this evidence only. Heap: per-isolate V8 heap used and committed, locally, for the Worker isolate and the Vault DO isolate. Native memory: the only per-isolate native figure is the local ArrayBuffer backing store (off-heap) from Runtime.getHeapUsage. Local workerd process RSS counts only as a whole-process upper bound; it is cumulative over the run and shared with SQLite, local R2/KV simulation, and Miniflare internals, so it is not native retention. Production gives pass/fail only: no memory failure up to concurrency 12 on Workers Paid; production heap and native memory stay unmeasured. Transport-retained RPC results and native response fragments stay unmeasured everywhere (OAB-6.8.2, Deferred).

Follow-up for the run findings: OAB-61 fixes the cancelled-blob lease hold, the Durable Object overload HTTP 500, the slow full feed, and the local Miniflare __miniflare_do_name schema failure. PR #163 (limits.cpu_ms 30000 on Workers Paid) removes the CPU-cut HTTP 200.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Measured Worker and Vault DO memory locally (Worker 57.7/90.4 MB, Vault 118.0/132.1 MB heap and heap+buffers against 128 MB) and confirmed in production. On Workers Free the 10 ms CPU limit failed first and caused cut HTTP 200 bodies; Workers Paid plus cpu_ms 30000 (PR #163) removed them. On Paid no memory failure up to concurrency 12; the single Vault DO queue is the first limit. Native categories stay unmeasured in production (OAB-6.8.2 Deferred). Follow-up defects fixed in OAB-61.
<!-- SECTION:FINAL_SUMMARY:END -->
