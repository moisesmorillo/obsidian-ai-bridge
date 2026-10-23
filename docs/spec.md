# Obsidian AI Bridge — Specification v1.3

**Status:** design specification, approved for planning once the owner reviews it. It is the single current contract. Earlier documents (PRD, Rewrite Brief, Contraste de análisis §1–§11) are history; where they differ from this document, this document wins.

**Date:** 2026-10-11 (v1.3, frozen for implementation after the fourth cross-review; further findings become Backlog.md tasks against code, not spec rounds). **Authors:** Claude (Fable 5.1) with cross-review by a second agent (Amp). **Owner:** Moisés Morillo.

**How to read:** sections 1–3 say what and why. Sections 4–12 are contracts. Section 13 lists acceptance cases that every phase must pass. Sections 14–16 define delivery, repository process and deferred work. Numbers are design limits to be confirmed by measurement where marked *measure*.

---

## 1. Purpose

One Obsidian vault, usable offline on Mac, iPad and iPhone, synchronized through a private service on Cloudflare that is also reachable by authorized AI clients over MCP. The service replaces iCloud Drive as the vault's sync provider and lets agents read and write the vault from anywhere without the Mac being on.

### 1.1 Goals (v1)

1. Bidirectional sync of the vault across enrolled Obsidian installations with no designated writer.
2. MCP access for authorized agents (ChatGPT first; Claude and Claude Code use the same server) to list, read, search, create, update, append, delete and restore notes, with changes arriving in Obsidian automatically.
3. No silent data loss: exact-revision conditional writes, recoverable history, visible conflicts, independent backup with proven restore.
4. Cost target: Workers Paid base ($5/month); everything else inside included allowances at the measured vault size.

### 1.2 Non-goals (v1)

End-to-end encryption; sync while iOS/iPadOS suspends Obsidian; automatic text merge; multi-user collaboration or per-folder permissions; NAS or any second storage backend; sync of `.obsidian/` settings categories; semantic/embedding search; WebSocket push; Windows/Linux support; automatic blob garbage collection. Each appears in §16 with a reopening trigger.

## 2. Fixed owner decisions

| Decision | Value |
| --- | --- |
| Current sync | iCloud Drive; vault at `iCloud~md~obsidian/Documents/Vault` |
| Scope of v1 | Both agent access and iCloud replacement |
| First MCP client | ChatGPT; OAuth is generic (2.1 + PKCE + discovery + DCR), nothing client-specific |
| Permissions | Per client: `vault:read`, `vault:write`, `vault:delete` over the whole vault. No path ACLs |
| Plan | Workers Paid accepted |
| Legacy | Repo and git history restarted from scratch; worker `obsidian-bridge.mmorillo.dev`, bucket `obsidian-ai-bridge` and KV wiped; nothing migrated |
| Conflict policy | **Option B**: the confirmed remote operation stands; pending local content is preserved as a conflict copy at a new path; nothing is resurrected automatically |
| Backup destination | Private GitHub repository, nightly, via Worker cron |
| Phase F4 | Kept: real vault on the Mac with iCloud still active, plugin only on the Mac, max two weeks, in *coexistence mode* (§7.10) |
| Tracking | Backlog.md for tasks and deferred items (label `deferred`); no milestones, no separate roadmap |
| Agent instructions | One `AGENTS.md` at the repo root; no `CLAUDE.md`, Claude Code reads `AGENTS.md` natively |
| Agent memory convention | Default folder `Agents/`, daily log `Agents/Log/YYYY-MM-DD.md` (owner may change) |

## 3. Measured baseline (2026-10-10)

| Metric | Value |
| --- | --- |
| Markdown notes | 42 |
| Text bytes | ~288 KB (~75k tokens) |
| Attachments | 1 SVG, ~8 KB |
| Largest note | 56 KB |
| `.obsidian/` | 8.3 MB (installed plugins; out of scope) |

Design assumption: small and growing. Limits in §12 allow roughly two orders of magnitude of growth (10,000 files, 2 GB) without redesign; beyond that is a deliberate v2 question, not a v1 promise.

## 4. Architecture

```
Mac / iPad / iPhone                     ChatGPT / claude.ai / Claude Code
  Obsidian + plugin                              MCP client (OAuth)
        │ HTTPS, Bearer token                           │ Streamable HTTP, Bearer token
        └─────────────────────┬─────────────────────────┘
                              ▼
                 Cloudflare Worker (Hono, TypeScript)
     ┌─ /v1/*            sync + REST API (plugin and any authorized app)
     ├─ /mcp             MCP server (same operations, same authorization)
     ├─ /authorize /token /register   OAuth 2.1 (workers-oauth-provider, grants in KV)
     ├─ /owner/*         owner console (behind Cloudflare Access)
     └─ cron             nightly export (§11)
                              ▼
            Durable Object "Vault" (SQLite) — sole authority
            files, revisions, changes, FTS, receipts, clients, revocations
                              ▼
                      R2 (private bucket)
            blobs/<sha256> (binaries, text > 1 MB)
```

### 4.1 Responsibilities

- **Durable Object (DO)**: one instance per vault. Owns path identity, revisions, tombstones, change feed, full-text index, idempotency receipts, client registry and revocation. Every mutation is one SQLite transaction. Every read of authoritative state goes through it.
- **R2**: immutable content-addressed bytes for binaries and oversized text. Never an authority for existence. Nothing in R2 is interpreted without a reference in the DO.
- **Worker**: transport, token validation, request shaping, MCP protocol, OAuth endpoints, cron. Holds no state of its own.
- **KV**: OAuth grants and tokens, managed by `@cloudflare/workers-oauth-provider`. Not used for authorization decisions that must be immediate (§9.5).
- **Plugin**: local change detection, conditional publish, conditional apply, durable per-device state, conflict copies, status UI, enrollment.

### 4.2 Trust boundaries

- Clients never receive R2 credentials; all bytes flow through the Worker.
- The Worker and the Cloudflare account operator can read plaintext. No E2E encryption is claimed.
- Note content is untrusted data: nothing in a note grants permissions, selects tools or changes synchronizer behavior.
- Logs never contain note bodies, tokens, authorization headers or OAuth codes. Paths may be logged at `debug` level only, off by default.

## 5. Data model

### 5.1 Identity

- **Vault epoch** (`epoch`): a **random 128-bit generation id** (32 hex chars) assigned when a vault is created and again by every restore (§11.4). It is never derived from a previous epoch, so two restores of the same backup never share ETags. Every ETag and every feed cursor carries it. A mismatch means "re-hydrate".
- **Path**: Unicode NFC, forward slashes, no leading slash, no `.`/`..` segments, no control characters, ≤ 512 bytes, ≤ 32 segments. `path_key = toLowerCase(NFC(path))` using JavaScript Unicode case mapping. **Uniqueness is on `path_key` among non-deleted rows**, because APFS on macOS/iOS is case-insensitive by default. A rename that changes only case keeps the same `path_key` and is allowed.
- **Revision** (`rev`, integer): per-path, strictly increasing for the lifetime of the vault, **never reset** across delete/recreate. A recreated path continues from its tombstone's rev. A rename assigns the destination `to_rev = max(last rev ever recorded for to, 0) + 1`; it never inherits the source's numbering, so `(path, rev)` stays unique in `revisions`. The source gets a tombstone `from_rev = from.rev + 1`.
- **ETag**: `"<epoch>.<rev>"` (quoted string). `If-Match` and `If-None-Match` use it. **Every client-facing surface (REST, MCP, feed, manifest) exchanges ETags, never bare `rev`**, so an operation formed before a restore is rejected by epoch everywhere.
- **Change sequence** (`seq`): vault-global, strictly increasing, the feed cursor.
- **Content hash**: `sha256` hex of raw bytes.

### 5.2 SQLite schema (DO)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- epoch, head_seq, created_at, capacity counters

CREATE TABLE files (
  path        TEXT PRIMARY KEY,          -- NFC
  path_key    TEXT NOT NULL,             -- lowercase NFC
  rev         INTEGER NOT NULL,
  seq         INTEGER NOT NULL,          -- seq of the change that produced this row
  hash        TEXT NOT NULL,             -- sha256 of content ("" for tombstone)
  size        INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text','blob')),
  content     TEXT,                      -- kind='text' only, ≤ 1 MB
  blob_hash   TEXT,                      -- kind='blob' only → R2 key blobs/<hash>
  renamed_to  TEXT,                      -- immediate rename destination on a source tombstone only
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,          -- unix ms
  origin      TEXT NOT NULL              -- client id
);
CREATE UNIQUE INDEX files_live_key ON files(path_key) WHERE deleted = 0;
CREATE INDEX files_key ON files(path_key);

CREATE TABLE revisions (                 -- retained history (§12 retention)
  path TEXT NOT NULL, rev INTEGER NOT NULL,
  hash TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL,
  content TEXT, blob_hash TEXT, deleted INTEGER NOT NULL,
  origin TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (path, rev)
);

CREATE TABLE changes (                   -- feed
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL CHECK (op IN ('put','delete','rename')),
  path TEXT NOT NULL, rev INTEGER NOT NULL,
  hash TEXT NOT NULL,                     -- content hash after the change ("" for tombstone)
  from_path TEXT, from_rev INTEGER,      -- rename only: tombstone written at from_path
  origin TEXT NOT NULL, at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE files_fts USING fts5(
  path UNINDEXED, content,
  tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);                                        -- maintained manually inside the same transaction (§10)

CREATE TABLE receipts (                   -- idempotency (§6.4)
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,                      -- UUIDv7 (plugin) or opaque 8–128 chars (agents)
  fingerprint TEXT NOT NULL,              -- sha256(epoch|client|op|path|precondition|payload_hash)
  status INTEGER NOT NULL, body TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, key)
);
CREATE TABLE export_pins (export_id TEXT NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (export_id, path, rev));  -- §11.1

CREATE TABLE clients (
  id TEXT PRIMARY KEY,                    -- OAuth client id
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('device','agent','app')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);

CREATE TABLE revoked_grants (grant_id TEXT PRIMARY KEY, at INTEGER NOT NULL);   -- §9.5

CREATE TABLE blob_refs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, first_ref_at INTEGER NOT NULL);
CREATE TABLE exports (id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER, status TEXT, head_seq INTEGER, calls_this_hour INTEGER, hour_started_at INTEGER, commit_sha TEXT, error TEXT);
```

The canonical schema version is 6. Versions 1 through 5 fail closed without writes. The service does not migrate or repair unsupported storage. Version 4 adds `history_revisions_bytes`, `history_receipts_bytes`, `history_changes_bytes`, `history_pressure_bytes`, and `history_reduced` metadata. Version 5 adds `retention_category` and `retention_pruned_feed_seq`. Version 6 adds nullable `files.renamed_to` for the immediate destination of a source rename tombstone. Fresh version-6 vaults initialize all history counters and the feed boundary to zero. Existing stores need an explicit future migration and receive no backfill or repair in this version.

A rename writes the immediate destination path to the source tombstone in the same transaction as the destination row and change entry. The hint survives feed pruning and remains until a later mutation replaces the source row. Recreate, restore, ordinary delete, and rename to another destination clear or replace any prior hint. Live rows and ordinary delete tombstones have no hint. The hint is diagnostic metadata, not a redirect.

Version 2 adds `operation_admissions`:

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `TEXT` | Primary key |
| `client_id` | `TEXT` | `NOT NULL` |
| `grant_id` | `TEXT` | `NOT NULL` |
| `epoch` | `TEXT` | `NOT NULL` |
| `fingerprint` | `TEXT` | `NOT NULL` |
| `admitted_at` | `INTEGER` | Unix milliseconds |
| `expires_at` | `INTEGER` | Unix milliseconds |
| `state` | `TEXT` | `reserved`, `active`, or `uncertain` |

Each column needs a value. The state check uses the name `operation_admissions_state_check`.

Index `operation_admissions_client_expiry` covers `(client_id, expires_at)`. Index `operation_admissions_expiry` covers `expires_at`.

Each client can hold at most 16 unexpired admission rows across grants and states. Each vault can hold at most 1,024 `operation_admissions` rows across all clients, grants, and states. Expired rows count until cleanup removes them.

Each new admission removes all expired rows for its client. It then removes at most 64 expired rows globally by selected identifiers.

At 1,024 or more retained rows, admission returns `admission_limited` with a positive retry delay. Client-limit denial takes precedence.

For global denial, the retry delay uses the earliest retained expiry across the vault. Its value is `max(1, ceil((earliest_expiry - now) / 1000))` seconds.

A record expires when `expires_at <= now`. Reservations and active tickets use a 60-second deadline. Uncertain work keeps its original deadline and charged slot.

Version 3 adds the `mutation_claims` table:

| Column | Contract |
| --- | --- |
| `client_id` | `TEXT NOT NULL` |
| `key` | `TEXT NOT NULL` |
| `admission_id` | `TEXT NOT NULL REFERENCES operation_admissions(id) ON DELETE CASCADE` |

The composite primary key is `(client_id, key)`. The unique `mutation_claims_admission` index covers `admission_id`. Claims link client keys to retained admissions.

Admission deletion cascades claim deletion. The admission owns the fingerprint, grant, epoch, state, and original deadline.

Version 4 adds the mandatory logical history counters to `meta`:

| Key | Initial value | Meaning |
| --- | --- | --- |
| `history_revisions_bytes` | `0` | UTF-8 logical payload bytes for retained revision rows |
| `history_receipts_bytes` | `0` | UTF-8 logical payload bytes for retained receipt rows |
| `history_changes_bytes` | `0` | UTF-8 logical payload bytes for retained change rows |
| `history_pressure_bytes` | `0` | Sum of the three category counters |
| `history_reduced` | `0` | Sticky history-reduced attention state |

Version 5 adds durable retention progress to `meta`:

| Key | Initial value | Meaning |
| --- | --- | --- |
| `retention_category` | `changes` | Next category to examine after interruption |
| `retention_pruned_feed_seq` | `0` | Monotonic lower cursor bound, one past the highest feed sequence removed by retention |

Versions 4 and 5 do not change relational table DDL. Versions 1 through 4 remain unsupported and receive no migration, repair, or counter backfill.

### 5.3 R2 layout

- `blobs/<sha256>`: immutable. Written **before** the DO transaction that references it (§6.3). Unreferenced blobs are harmless; no automatic GC in v1 (§16).
- Blob PUT requests declare both `X-Content-SHA256` and `X-Content-Size`. The digest contains exactly 64 lowercase hexadecimal characters. The size is a canonical nonnegative decimal without leading zeroes, at most 25,000,000.
- Both headers must appear together. Existing inline clients may omit both. A supplied declaration binds the exact raw bytes and is verified before publication, also for inline text.
- Missing blob declarations or malformed headers return `400 invalid_request`. Declared or measured blob overflow returns `413 blob_too_large`. Other measured length or digest mismatches return `422 blob_integrity_mismatch`.
- Blob declarations do not need transport `Content-Length`. A supplied transport length must match the declared size. Conflicting lengths return `400 invalid_request` before body demand.
- Uploads use create-only writes and stored SHA-256 evidence. They never replace or delete an immutable object. Storage failures return `503 blob_storage_unavailable` with `Retry-After`.

### 5.4 Storage rule for text vs blob

The final file extension selects Markdown or Canvas behavior. The ASCII letters in `.md` and `.canvas` match without case distinctions. This rule does not change path identity. Near matches such as `.md.backup` and `.canvas2` are other file types.

- `.md` and `.canvas` files ≤ 1,000,000 bytes are stored inline (`kind='text'`) and `.md` content is indexed (`.canvas` JSON is stored inline but not indexed).
- Every other file, and any `.md`/`.canvas` file > 1,000,000 bytes, is `kind='blob'`: bytes in R2, metadata in SQLite, **not indexed**, readable by range through the Worker. `large` is true only for Markdown or Canvas stored as a blob above 1,000,000 bytes. The plugin panel shows such a file as "synced, not searchable".
- An `update` or `append` whose resulting text would exceed 1,000,000 bytes fails with `413 text_too_large`. The note must be split by the user or agent. This keeps every text commit atomic in SQLite.
- Blob GET streams raw bytes with `Content-Type: application/octet-stream`. Successful responses expose the authoritative file `ETag`, exact `Content-Length`, `Accept-Ranges: bytes`, and `X-File-Large: true|false`.
- Whole-object GET streams without a complete application buffer. Current and retained reads select an authoritative reference before storage access. Inline GET keeps its JSON response.
- Blob range reads accept one satisfiable `bytes=start-end` selection. Multiple, malformed, unsatisfiable, or excessive explicit ranges return `416` with `Content-Range: bytes */size`.
- An open-ended `bytes=start-` selection returns at most the next 1,000,000 bytes. Successful range reads return `206` with exact `Content-Range`. A selected range never exceeds 1,000,000 bytes.

## 6. Sync API

Base `/v1`. JSON unless noted. Authentication: `Authorization: Bearer <access token>`. Authorization per §9.

### 6.1 Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/vault` | read | `{epoch, head_seq, counts, limits, capacity, attention}` |
| `GET` | `/v1/manifest?page=<token>` | read | `{epoch, head_seq, entries, next_page}` with path, epoch-bound `etag`, `seq, hash, size, kind, deleted, large`; pages contain at most 256 rows and include tombstones |
| `GET` | `/v1/changes?epoch=E&since=S&limit=N` | read | `{epoch, head_seq, entries}` with immutable feed rows, `seq > S`, ascending, and at most 1,000 entries. `409 epoch_mismatch` if E ≠ epoch. `410 cursor_expired` if S is older than the oldest retained `seq` |
| `GET` | `/v1/files/*path?rev=R` | read | Content and metadata. Without `rev`: current, `ETag`, and optional `X-Vault-Epoch` observation. With `rev`: send `X-Vault-Epoch` to select that exact revision from `revisions`; without the epoch, receive `410 revision_pruned`. Range reads via `Range: bytes=` (blob) or `?offset=&length=` (text, in UTF-16 code units as Obsidian uses). Response always carries `ETag` |
| `PUT` | `/v1/files/*path` | write | Create or update. Requires `If-Match: "<etag>"` or `If-None-Match: *` **plus `X-Vault-Epoch`** (every mutation carries the epoch the client observed; `409 epoch_mismatch` otherwise). Body raw bytes; kind is decided by §5.4 (extension and size), not by `Content-Type`. Returns `201/200` with new `ETag`, `seq` |
| `DELETE` | `/v1/files/*path` | delete | Requires `If-Match`. Accepts optional `X-Vault-Epoch`; if supplied, it must match the ETag epoch. Header-free DELETE remains compatible because `If-Match` supplies the observed epoch. A stale ETag returns `412` without changing the file. Creates a tombstone |
| `POST` | `/v1/files/*path:rename` | write | Body `{to}`. Requires `If-Match` of source. Destination must be free on `path_key` (or equal, case-only rename). One `rename` change entry carrying `from_path`, `from_rev` (new tombstone of source), `path = to`, `rev = to_rev`, `hash`. Receivers never wait for a later `put`: the entry has everything needed, and bytes are fetched by `GET /v1/files/to?rev=to_rev` when the local copy cannot be reused |
| `POST` | `/v1/files/*path:append` | write | Body raw text. **`Idempotency-Key` and `X-Vault-Epoch` required** (`428 idempotency_key_required` / `409 epoch_mismatch`). Appends at end of **current** text revision inside the transaction. No `If-Match` needed. `409 tombstone` if path is deleted; `404` if never existed; `413` if result exceeds 1 MB; `415` if path is a blob |
| `GET` | `/v1/history/*path?page=<token>` | read | `{epoch, entries, next_page}` with at most 256 retained revision entries. Entries expose epoch-bound `etag`, `hash, size, deleted, origin, at`, never content or bare `rev`. |
| `POST` | `/v1/files/*path:restore` | write | Body `{source_rev}` plus optional `{as_conflict_copy: true}`. **Requires `If-Match` with the current ETag of the destination** (live or tombstone), so a retry after a lost response cannot resurrect a note someone deleted again. Creates a new revision with the bytes of `source_rev`. If path is live and `as_conflict_copy` is false → `409 path_occupied`. `as_conflict_copy: true` restores in place at the same path, with the exact current destination ETag, and retains the displaced revision |
| `GET` | `/v1/search?q=&limit=` | read | §10 |

### 6.2 Status and error codes

Read ETags use the canonical quoted form `"<epoch>.<rev>"`; every read ETag carries its matching vault epoch. Manifest pages sort by SQLite binary path order. History pages sort by ascending ETag revision. Continuation tokens are versioned base64url seek hints, capped at 4,096 encoded bytes, and bind collection, epoch, captured head, and last emitted identity. History tokens also bind the exact path and first-page upper ETag. A token does not grant authorization. Read pages never materialize the full vault. Internal metadata batches contain at most 64 rows plus one lookahead row. The changes endpoint validates `limit` as an integer from 1 through 1,000, default 1,000. Query values reject duplicates, unknown names, malformed values, negative values, unsafe integers, and values above their bounds.

Errors are `{error: <code>, message, ...details}`. `precondition_failed.renamed_to` appears only with complete tombstone details for a renamed source and identifies the immediate destination. It is never a live redirect. `importing` is HTTP 503 with `Retry-After` from 1 through 300 seconds. `vault_retired` is HTTP 410 and carries a bounded `new_vault_id`. `cursor_expired` uses HTTP 410 and a fixed safe message. Codes: `epoch_mismatch`, `cursor_expired`, `revision_pruned`, `precondition_failed` (412, body includes current `etag`, `hash`, `deleted`, `renamed_to` when applicable; current text ≤ 1 MB is included **only when the client holds `vault:read`**, otherwise omitted), `path_collision` (409, includes `existing_path`), `path_occupied`, `tombstone`, `text_too_large`, `blob_too_large`, `blob_integrity_mismatch` (422), `blob_storage_unavailable` (503 with `Retry-After` from 1 through 300 seconds), `invalid_path`, `idempotency_mismatch` (422), `operation_expired` (409), `idempotency_in_progress` (409), `idempotency_key_required` (428), `forbidden_scope` (403), `revoked` (401), `importing` (503 with `Retry-After`), `vault_retired` (410, includes `new_vault_id`), `capacity_exceeded` (507), `query_too_short`, `query_too_long`.

### 6.3 Mutation algorithm (inside the DO)

1. **Authorize before content effects.** The Worker validates the token (signature, expiry, audience). The DO then checks `revoked_grants`, scope, path validity, and declared-size limits.

   For body-bearing work, the DO may reserve admission capacity before the Worker reads or buffers the body. The DO writes admission bookkeeping only after the applicable permission checks and before it returns a lease or ticket.

   A reservation does not authorize a content effect. The Worker reads or buffers the body only after it receives the lease.

   No content bytes or content metadata may change in SQLite or R2 before full authorization returns an operation ticket. The ticket keeps the admission's original 60-second deadline.
2. If `Idempotency-Key` present: look up receipt. Found with equal fingerprint → return stored response. Found with different fingerprint → `422 idempotency_mismatch`. Not found but key timestamp outside the acceptance window → `409 operation_expired`.
3. Normalize path, compute `path_key`.
4. For blobs only: with a valid ticket, the Worker streams the body to `blobs/<hash>` in R2 (idempotent by key), then calls the DO `commit(ticket, hash, size)`. For text, the body goes straight to the DO. A ticket is single-use and bound to the fingerprint.
5. In one SQLite transaction: check precondition against `files` (`rev`, `deleted`, collision on `path_key`); write `revisions`; upsert `files`; insert `changes`; update `files_fts` (delete old row, insert new for text); insert `blob_refs` if blob; insert receipt; update `meta.head_seq`; update capacity counters.
6. Return response. A failed transaction leaves no partial state. A Worker crash between R2 write and DO commit leaves only an unreferenced blob, and only for an already authorized operation.

The Vault checks current authority again after asynchronous storage work. Revocation, expiry, epoch changes, or stale revisions block publication. A matching committed receipt replays under current policy without another upload.

Unknown storage or authority results retain admission until its original deadline. Retries do not extend that admission deadline. Authorized uploads can leave verified orphans, but no failure path deletes an object.

### 6.4 Idempotency contract

- Key: one per **operation instance**, scoped to the client id: receipts are keyed by `(client_id, key)`, so two clients may use the same string without colliding.
  - **Plugin**: UUIDv7, so the server can judge the age of a key it never saw.
  - **MCP/REST agents**: any opaque string 8–128 characters; **required** for `append`, optional for operations already protected by a precondition. The acceptance window does not apply to opaque keys; receipts still live 30 days, so a retry more than 30 days later may duplicate an append. This is documented in the tool description.
- An operation that **may have been sent** keeps its key and its immutable payload until the server answers (receipt or rejection). A later edit of the same path is a **second** operation queued behind it; it is never merged into or replaced by the in-flight one. Only operations still in state `queued` (never sent) may be replaced by a newer edit.
- Fingerprint binds `epoch`, client id, operation type, path(s), precondition (`If-Match`/`If-None-Match`), and `sha256(payload)`. Reusing a key with a different fingerprint is rejected.
- Acceptance window: key timestamp must be within `[now − 25 days, now + 5 minutes]`. Receipts are retained **30 days**. Therefore no key can be accepted as new after its receipt could have expired, and clocks up to 5 minutes fast are tolerated. Beyond that the client is told `operation_expired` and shows the operation as *attention*; it never retries with different bytes under the same key.
- Concurrency: a key seen while its first request is still in flight returns `409 idempotency_in_progress`; the DO's single-threaded transaction makes this a short window.
- MCP: `append_to_note` **requires** `idempotency_key` in its input schema; the other mutating tools accept it optionally and are protected by their `etag`/create-only preconditions. No server heuristic de-duplicates appends.

### 6.5 Request limits

Four body-bearing mutations share synchronous slots across clients, vault hosts, and router instances in one Worker isolate. PUT, append, rename, and restore use this budget. The fifth request receives `429 admission_limited` and `Retry-After: 1`, without body demand or durable reservation.

A slot covers body handling, storage, authority calls, cleanup, and application-owned response preparation and production. Operation cleanup and response production must both settle before slot reuse. Response production ends after producer EOF or cancellation cleanup, not after the final chunk enters a stream.

This boundary does not prove client receipt or release by the last native owner. Cancellation or ticket expiry does not release a slot before started work settles. Permanently blocked work can exhaust slots and cause safe refusals.

Mutation failure responses preserve complete authorized text through bounded JSON chunks. Encoding does not create a complete escaped content string or a complete JSON body. Response reads and encoded chunks stay at or below 65,536 bytes.

Native body reads request at most 65,536 bytes at a time. Inline readers use one fixed 1,000,000-byte allocation and do not retain borrowed chunks. Blob reads and writes use bounded native streams, without a complete blob buffer.

Four authoritative reads share separate isolate-local slots across routes, clients, vault hosts, and router instances. The fifth read returns `429 admission_limited` and `Retry-After: 1` before metadata or R2 demand.

Each successful read keeps one durable admission through response production and cleanup. Metadata responses demand one bounded batch at a time. Response encoding never creates a complete escaped inline string or JSON page. Cancellation joins started RPC, storage reads, and cleanup before slot reuse. Unknown authority results keep the original admission deadline. Producer EOF does not prove client receipt or native release.

Body ≤ 26 MB (25 MB blob + headers). Manifest page ≤ 256 rows. Feed page ≤ 1,000 entries. Search ≤ 50 results. Range reads ≤ 1 MB per response. Concurrency per client: the plugin runs at most 4 in-flight requests; the Worker returns `429` with `Retry-After` above 16 concurrent requests per client.

## 7. Plugin

Single codebase for Desktop and mobile (`isDesktopOnly: false`, `minAppVersion: 1.13.0`). No Node or Electron APIs. Network via `requestUrl`.

### 7.1 Per-device state

Two stores, never `data.json` (iCloud syncs `data.json` between devices):

- **Credentials**: OAuth tokens in `app.secretStorage` when available on the device (Obsidian ≥ 1.11.4); otherwise `app.saveLocalStorage` with a visible "tokens stored unencrypted on this device" status. Verified per platform in F3 and F5. `data.json` holds only non-secret settings (server URL, scope lists, coexistence flag).
- **Sync state** in `app.saveLocalStorage`, one JSON document, written atomically as a whole and read back after each write; a failed write puts the plugin in *attention* and stops publishing until it succeeds:
  - `device_id`, `client_id`, `epoch`, `cursor` (last applied `seq`)
  - `base[path] = {rev, hash}` — the exact server state this device last acknowledged per path
  - `pending_ops[]` — queue of outgoing operations: `{key (UUIDv7), op, path, to?, precondition, payload_hash, payload_ref, created_at, attempts, state ∈ {queued, sent, resolved}}`. **Before** an op leaves `queued`, its bytes are copied to `.ai-bridge/pending/<key>` (excluded from sync) and verified by hash; `payload_ref` points there. A `sent` op is immutable: it is removed only on a receipt or an explicit rejection, and a newer edit of the same path becomes a new `queued` op behind it. Only `queued` ops can be replaced.
  - `pending_apply[]` — in-progress incoming applications (§7.5) for crash recovery: `{path, R, step, conflict_path?, conflict_hash?}`
  - `expected_writes[path] = hash` — echo suppression for writes the plugin itself is about to make (§7.5); never used as confirmed state
  - `attention[]` — items needing the owner

### 7.2 Enrollment

1. Owner opens Settings → Connect. Plugin opens the browser to `/authorize` (PKCE). Owner authenticates through Cloudflare Access, names the device, approves `read write delete`.
2. Callback via `obsidian://ai-bridge/callback?code=…` (works on mobile). Plugin exchanges the code, stores tokens, registers in `clients`.
3. Plugin fetches `/v1/vault`. Three cases:
   - **Server empty, local has content** → first device: upload all in-scope files with `If-None-Match: *`; record bases; show progress per file.
   - **Server has content, local empty** → hydrate (§7.3).
   - **Both have content** → per path: equal hash → record base; local only → upload; remote only → download; both and different → Option B: write remote at path, save local as conflict copy (§7.6). No file is overwritten or deleted without its conflict copy.
4. Enrollment is resumable: every step writes state; restart continues.

### 7.3 Hydration and full reconciliation

Used on first enrollment, after `epoch_mismatch`, after `cursor_expired`, and on demand ("Rebuild local index"). **On an epoch change every `base` entry is stale**: the comparison below uses hashes only, never `rev`, and each `base[path]` is rewritten with the new epoch's `rev`; `expected_writes`, `pending_apply` and the feed cursor are discarded; `pending_ops` from the old epoch are moved to *attention* (their preconditions no longer exist). Locally changed files become conflict copies, never losses.

1. `GET /v1/manifest` page by page. Record `epoch` and `head_seq` from page 1. Rows carry their own `seq`.
2. For each row: compare `(local hash, base hash, row hash/deleted)` with the apply rules (§7.5). Content is fetched **pinned by `rev`** (`/v1/files/path?rev=R`); on `410 revision_pruned`, fetch current and treat its `rev` as the row's.
3. Rows with `seq > head_seq` are applied anyway; the feed will revisit them idempotently (same `rev` → no-op).
4. Set `cursor = head_seq`. Resume the feed.
5. Tombstones are kept forever in `files`, so a path present in `base` is always present in the manifest, live or tombstoned. A tombstoned row is a confirmed remote delete; absence is never used as evidence.

### 7.4 Triggers and polling budget

Pull and push run from one serialized loop:

| Condition | Interval |
| --- | --- |
| Window focused and a local edit in the last 5 minutes | 15 s |
| Window focused, idle | 60 s |
| Window hidden / app unfocused | 300 s |
| App suspended (mobile) | none; runs on resume |
| Local vault event (`create/modify/delete/rename`) | push after 2 s debounce |
| Plugin load, `visibilitychange` to visible, "Sync now" command | immediately |

Budget (*measure* in F4): three devices focused-active 8 h/day for 30 days → 3 × (8 × 3600 / 15) × 30 = 172,800 DO requests/month, 17% of the 1 M included. Realistic usage is far lower. Each poll is one `GET /v1/changes`.

### 7.5 Applying a remote change (conditional apply, R1/R3)

Entries are applied in `seq` order. **A `put`/`delete` entry whose `rev` is not greater than `base[path].rev` is ignored** (already applied or superseded: hydration may have applied a newer revision before the feed replays an older one). **A `rename` entry is resolved per side**: the source side (`from_path`, tombstone `from_rev`) is pending only if `base[from]` exists **and `base[from].rev < from_rev`** (a live or deleted base at a higher revision is newer than this rename and is left alone); the destination side (`path = to`, `to_rev`) is pending if `base[to]` is absent or has `rev < to_rev`. Hydration may have read `from` before the rename and `to` after it, leaving only the source side pending. Then:

| Pending sides | Local state | Action |
| --- | --- | --- |
| both | `from` clean, `to` absent | `vault.rename(from, to)` without link rewriting; confirm; `base[to] = {to_rev, hash}`, `base[from] = tombstone(from_rev)` |
| both | `from` dirty or `to` present | treat as the conflict rows below, then fetch `to` by `to_rev` |
| source only | `from` clean | trash `from`; `base[from] = tombstone(from_rev)` |
| source only | `from` dirty | conflict copy of `from` (§7.6), then trash `from` |
| destination only | `to` absent or clean | fetch `GET /v1/files/to?rev=to_rev`, write via `process`; `base[to] = {to_rev, hash}` |
| destination only | `to` dirty | conflict copy of `to`, then write fetched bytes |

For the remaining `put`/`delete` entries, with `L = local hash`, `B = base[path].hash`, `R = entry hash`:

| Local vs base | Remote | Action |
| --- | --- | --- |
| `L == B` (clean) | put | Apply remote bytes at path (atomic, below); `base = R` |
| `L == B` | delete | Move local file to `.trash/` (Obsidian trash, excluded from sync); `base = tombstone` |
| `L == R` (already identical) | any put | Only update `base = R`; no write, no conflict |
| `L != B` (dirty) and `L != R` | put / delete / rename | **Conflict, Option B** (§7.6) |
| path absent locally, no base | put | Create. If a local file exists with the same `path_key` but different `path` → `path_collision` locally: save remote under conflict-copy name and mark *attention* |

**Atomic apply for text** (R3): use `app.vault.process(file, current => current_hash == B ? remote_text : current)`. The hash check happens inside Obsidian's read-modify-write; if the callback sees different bytes, nothing is written and the entry is re-evaluated as dirty (its current local bytes become the conflict copy, §7.6).

**Echo suppression is separate from confirmed state.** Before writing, the plugin records `expected_writes[path] = R`. A `modify` event whose file hash equals `expected_writes[path]` is consumed as an echo and not published; any other hash is a genuine edit and is queued. `expected_writes[path]` is cleared when the apply completes or aborts. **`base[path]` advances to `R` only after the effect is confirmed** (the `process` callback returned `remote_text`, or the read-back hash equals `R`). If the callback refused, `base` is unchanged, so the entry is **not** discarded by the `rev ≤ base.rev` rule; it is re-evaluated against the dirty state.

**Blob apply** (binaries and oversized `.md`/`.canvas`): Obsidian offers no atomic read-modify-write for binaries. Procedure: `stat` (mtime, size) → read → hash check against `B` → **re-`stat` immediately before writing; any change aborts and re-evaluates the entry as dirty** → copy the bytes just read to `.ai-bridge/pre-apply/<hash>` (durable, excluded from sync) → `modifyBinary` → read back and verify `R` → only then `base[path] = R`. The remaining window spans the second `stat`, the durable pre-apply copy and the write itself, up to 25 MB of I/O. A user write landing inside it is lost from disk, but the bytes we read are preserved in `pre-apply` for 7 days. **This residual window was explicitly approved by the owner (§17.1).**

**Durable ordering** (R1): for every apply, `pending_apply` records `{path, rev R, step}` before the first local effect and is cleared after `base`/`cursor` are persisted. On restart, each `pending_apply` is resumed from its step; conflict copies are checked by name and hash before being rewritten.

### 7.6 Conflict handling (Option B execution)

Trigger: a dirty local path meets a confirmed remote put/delete/rename, or a `PUT`/`DELETE`/`rename` gets `412`.

Conflict copy name: `<stem> (conflict <device-name> <YYYY-MM-DD HHmm> r<R>).<ext>`, where `R` is the remote rev that caused it. The name is **deterministic** for (path, R, device): a retry finds the existing copy, verifies its hash, and does not create another.

Order of effects, each step durable before the next:

0. Read the **current local bytes** `L` and compute `conflict_path` from (path, R, device). Record `pending_apply {path, R, conflict_path, conflict_hash: hash(L), step: 'named'}` **before any write**. All later comparisons in this conflict use `L`, never the old base.
1. Write `L` to `conflict_path` with `vault.create`. If the path already exists: hash equal to `conflict_hash` → reuse it; **any other hash → never overwrite**: the item goes to *attention* ("conflict copy was edited before the sync finished") and the apply stops for this path until the owner resolves it. Read back and verify.
2. Set `step: 'copied'`.
3. Apply the remote state at `path` (put → `process` with hash check; delete → trash; rename → see §7.5). Under rename/edit: the pending bytes are already safe in the conflict copy at step 1; `to` receives the bytes fetched by `GET /v1/files/to?rev=to_rev`, never the pending local edit; local `from` is trashed.
4. Set `base[path]` (or `base[to]`) to `R`; set `base[conflict_path]` absent so the copy is published as a new file by the normal push.
5. Clear `pending_apply` and `expected_writes[path]`; mark the original pending op (if any) as resolved with reason `conflict`. On restart at any step, the recorded `conflict_path`/`conflict_hash` make the resolution idempotent.

The conflict copy is an ordinary file. It syncs everywhere, can be edited on any device, and if edited concurrently gets its own conflict copy. No name-pattern special-casing exists in the synchronizer.

Pending `DELETE` meets remote put (412): the delete is dropped; the remote bytes are applied at `path`; *attention* item "your delete of X was cancelled by a newer edit". Pending `rename X→Y` meets remote put on X (412): the rename is dropped; remote bytes applied at X; if local Y exists with hash equal to the old base of X, Y is moved to trash (it was only the moved copy); otherwise Y stays as an ordinary new file.

Identical bytes on both sides with different `rev` never produce a conflict (§7.5 row `L == R`).

### 7.7 Publishing local changes

- Change detection: vault events plus a startup scan comparing hashes to `base`. Changes are queued as `pending_ops` with a UUIDv7 key, `payload_hash`, and a durable payload reference (§7.1). A later edit of the same path before send replaces the op with a new key.
- `put` uses `If-Match: "<epoch>.<base.rev>"` or `If-None-Match: *` when no base. `delete` and `rename` are published **only from Obsidian `delete`/`rename` events** while the plugin is running (and, in coexistence mode, only after owner confirmation, §7.10). A file found missing at startup with a known base is **restored from the server**, never published as a delete.
- On `412`: §7.6. On `409 path_collision`: *attention* with the existing path. On `413`: *attention* "note too large to sync as text". On network error: retry with the same key, exponential backoff 2 s → 5 min, honoring `Retry-After`. On `operation_expired` or `idempotency_mismatch`: *attention*, no automatic retry.
- Receipt handling: on `2xx`, `base[path] = {rev, hash}`, remove the op. The response `seq` is not used to advance the cursor; the feed does that, and re-reading our own change is a no-op by hash.

### 7.8 Scope

Included: `**/*.md`, `**/*.canvas`, and attachments with extensions `png jpg jpeg gif webp svg pdf mp3 m4a wav mp4 mov webm json csv txt` up to 25 MB. Excluded always: `.obsidian/**`, `.trash/**`, `.ai-bridge/**`, `.DS_Store`, `*.icloud`, any path failing §5.1. The panel lists excluded and unsupported files on demand; the status never says "synced" while an in-scope file is pending, failed or in *attention*.

### 7.9 Status model

States shown per vault and per path in plain language: `disconnected`, `syncing`, `settled`, `pending`, `attention`, `revoked`, `paused`, `backup failed`. `settled` requires: empty `pending_ops`, empty `pending_apply`, `cursor == head_seq` at last poll, state persisted. Every *attention* item has a reason code, the path, and one safe action (open, restore, keep both, dismiss). Controls are keyboard-operable, labelled, and do not rely on color alone.

### 7.10 Coexistence mode (phase F4)

A setting the owner turns on while iCloud still syncs the same live vault and the plugin runs only on the Mac:

- Local `delete` and `rename` events are **queued for owner confirmation** in the panel; never auto-published. iCloud eviction and placeholder churn therefore cannot publish destructive operations.
- `*.icloud` placeholders are excluded; a path that flips to a placeholder is treated as "unavailable", not deleted.
- Pause and exit: *Pause* stops publishing and applying but keeps queues; *Exit coexistence* requires an empty confirmation queue and either disabling the plugin or turning the mode off for cutover.
- Residual risk disclosed in the panel: iCloud and the user still write the same files; a concurrent iCloud write during an apply is handled by the hash check for text and is best-effort for binaries.

## 8. MCP server

Transport: Streamable HTTP at `/mcp`. Auth: Bearer token from §9; resource metadata (RFC 9728) and authorization server metadata (RFC 8414) published. Every tool result includes the current `epoch`; `create_note` and `append_to_note` require it as an argument because they carry no `etag`. Server `instructions` (sent in `initialize`) describe the vault conventions: default folder `Agents/`, daily log path, frontmatter minimum (`created`, `source`), "search before create", "pass `etag` from `read_note` to `update_note`", "always generate a fresh `idempotency_key` (any unique string) for `append_to_note` and reuse the same key only when retrying the same append".

| Tool | Scope | Arguments | Returns |
| --- | --- | --- | --- |
| `list_notes` | read | `prefix?`, `include_large?` | paths with `etag, size, updated_at, large` |
| `read_note` | read | `path`, `etag?`, `offset?`, `length?` | `content`, `etag`, `truncated`. A supplied `etag` that no longer matches current returns the current `etag` and no content, so fragments never mix revisions |
| `search_notes` | read | `query`, `limit?` | `[{path, etag, snippet, score}]` (§10) |
| `create_note` | write | `path`, `content`, `epoch`, `idempotency_key?` | `etag`. Create-only; `409` if exists (includes existing `etag`); `409 epoch_mismatch` if `epoch` is stale |
| `update_note` | write | `path`, `content`, `etag`, `idempotency_key?` | new `etag`. `412` with current `etag` (and content, since MCP agents hold `read`) on mismatch |
| `append_to_note` | write | `path`, `text`, `epoch`, **`idempotency_key` (required)** | new `etag`. `409` on tombstone; `409 epoch_mismatch` if stale; `413` if result > 1 MB |
| `delete_note` | delete | `path`, `etag` | tombstone `etag` |
| `get_history` | read | `path` | retained revisions |
| `restore_note` | write | `path`, `source_etag`, `current_etag`, `as_conflict_copy?` | new `etag`. `412` if `current_etag` is stale |

All tools call the same DO operations as `/v1`. A successful mutation enters the feed and reaches every enrolled device by the normal pull, with `origin` set to the agent's client id and shown in the panel. Restore with `as_conflict_copy: true` writes in place at the same path and retains the displaced revision.

## 9. OAuth and authorization

### 9.1 Flows

OAuth 2.1 authorization code with PKCE, implemented by `@cloudflare/workers-oauth-provider`. Dynamic Client Registration (RFC 7591) enabled so ChatGPT, Claude and Claude Code register themselves; pre-registered client ids also accepted. No client-credentials grant. Refresh tokens rotate.

### 9.2 Owner authentication

`/authorize` and `/owner/*` sit behind **Cloudflare Access** (Zero Trust, free tier) with the owner's identity provider. The consent page shows client name, redirect URI, requested scopes, and lets the owner name the client. The Worker trusts the `Cf-Access-Jwt-Assertion` only after verifying it against the Access public keys.

### 9.3 Scopes

`vault:read`, `vault:write`, `vault:delete`. `write` does not imply `delete`. Each `/v1` route and each MCP tool declares its scope (§6.1, §8); the Worker enforces it on every request **and** the DO re-checks it, so announcing scopes in the OAuth library is never the only control.

### 9.4 Token storage on devices

§7.1. Tokens are never written to the vault folder except inside `app.secretStorage`'s own store.

### 9.5 Revocation (R7)

KV propagation is eventually consistent (60 s or more), so the DO is the authority:

1. Owner revokes a client in `/owner/clients`. The Worker **first** writes `revoked_grants` in the DO, **then** revokes in KV.
2. Every request to the DO carries `{client_id, grant_id, scopes}` validated by the Worker; the DO rejects a revoked grant with `401 revoked` before reading or writing anything.
3. Operations already committed are not undone. Responses already in flight are not recalled.
4. The plugin on a revoked device enters `revoked`: stops publishing and applying, keeps local files and queues, offers "Reconnect".
5. Expired access tokens are rejected by signature/expiry check in the Worker; a failed refresh fails closed.

## 10. Search contract

- Index: `files_fts` over `content` of live `kind='text'` Markdown rows whose final `.md` extension matches without ASCII case distinctions (`.canvas` is stored inline but not indexed). Near suffixes such as `.md.backup` are other file types. The tokenizer is `trigram case_sensitive 0 remove_diacritics 1`. Rows are deleted/inserted in the same transaction as the file mutation, so the index is never stale relative to `head_seq`.
- Semantics: **literal substring match**, case-insensitive, diacritic-insensitive, no stemming, no operators. The query is sent as a single quoted FTS phrase with internal `"` doubled, so `AND`, `OR`, `*`, `-`, `:` and quotes are literal.
- Limits: query length is 3–200 Unicode code points (`400 query_too_short` / `query_too_long`); `limit` is 1–50, default 20. Results use ascending native `bm25` score, with SQLite binary path order for ties. Each plain-text snippet uses at most 64 FTS tokens and 1,024 Unicode code points. ETags use the response epoch.
- `GET /v1/search?q=<query>&limit=<integer>` returns `{epoch, results, indexed_files, unindexed_large_files}`. Both coverage counts use the same case-insensitive final-extension rule as storage. `indexed_files` counts live indexed Markdown rows. `unindexed_large_files` counts live Markdown blob rows above 1,000,000 bytes. Canvas and other attachments do not count.
- The route rejects missing or duplicate `q`, duplicate or unknown parameters, and noncanonical integer limits with `400 invalid_request`. It preserves query spaces, punctuation, quotes, and Unicode without trimming or normalization.
- Acceptance examples (§13 AC-15): `bge-m3`, `wrangler.jsonc`, `If-Match`, `/v1/files`, `cafe` matching `café`, `"quoted"`, `AND` as a literal word, a two-character query rejected.
- Path/title search: `list_notes(prefix)` and client-side filtering; no `LIKE` on the server (DO limits patterns to 50 bytes and the diacritic-folded index does not accelerate `LIKE`).

## 11. Backup and restore

### 11.1 Consistent cut

A nightly cron (03:00 UTC) only **starts** an export; the work runs inside the DO as a chain of alarms so it is resumable and never depends on one invocation finishing.

1. In one DO transaction: create an `exports` row and an **export manifest**: `epoch`, `head_seq`, every `files` row including tombstones, and the list of retained `(path, rev)` revisions and referenced blob hashes **not yet present in the backup repository** (the DO keeps `backup_state` keyed by **`(epoch, path, rev)`** plus blob hashes already pushed; a new epoch starts an empty `backup_state`, and exports and pins from the previous epoch are abandoned). The manifest is written to SQLite as the export's immutable work list, and every `(path, rev)` it references is inserted into `export_pins`. **Pruning (§12) never removes a pinned revision**, whether by age or by capacity pressure. Pins are released when the export reaches `complete` or is abandoned; an export older than **14 days** is abandoned, its pins released, and a fresh export started from the current state.
2. Everything the manifest points to is immutable and, thanks to the pins, guaranteed to exist until the export ends. The cut is therefore consistent regardless of how long publishing takes.

### 11.2 Destination and publishing (incremental Git)

- A **dedicated private GitHub repository** (`obsidian-vault-backup`), separate from the code repo so BRAT releases and backups never mix. Token: fine-grained, contents read/write on that repo only.
- Layout in the repo: `manifest.json`, `files/<path>` (current content), `revisions/<path>/<rev>` (retained history), `blobs/<hash>`, `clients.json`. OAuth grants are **not** exported; after a disaster clients re-authorize.
- Publishing is **incremental** through the Git Data API: create one git blob per new or changed item (≤ 25 MB each, streamed one at a time), create a tree from the previous commit's tree plus the changes, create the commit, then **update `refs/heads/main`** (`PATCH /git/refs/heads/main`). The commit is not published until the ref moves; a crash before that leaves an orphan commit, and the next run re-creates the tree.
- Rate limits: GitHub's secondary limit for **content-creating requests** is 500 per hour and about 80 per minute. Blob, tree, commit and ref calls are all content-creating. The DO therefore paces at **≤ 450 content-creating calls per hour and ≤ 60 per minute**, tracked in `exports.calls_this_hour`, and reacts to `403`/`429` with `Retry-After` by sleeping the alarm. Each alarm invocation does at most 50 calls and re-arms itself one minute later. The DO stores the blob SHAs created so far.
- Duration: a first export needs roughly `ceil(items / 450)` hours, where items = files + retained revisions + blobs. For the measured vault (under 100 items) that is under one hour. At the v1 envelope (10,000 files, bounded history) the worst case is about four days, inside the 14-day abandonment window. An abandoned export does not lose its work: before creating a blob, the next export checks whether that content SHA already exists in the backup repository (a read call, outside the content-creating limit) and reuses it. A packed-baseline alternative is listed in §16. Subrequest limits per invocation are never approached.
- Failure: any error is recorded in `exports` with the step and retried on the next alarm with backoff (5 min → 1 h). An export is `complete` only after the ref update and verification. Every plugin shows `backup failed` when the last complete export is older than 48 hours **and no export is in progress**, and `backup in progress (N%)` otherwise. Maximum expected loss between complete exports: 24 hours of changes once the baseline exists.

### 11.3 Verification

After the ref update, the DO reads back the commit's `manifest.json` and compares its hash with the manifest it produced; mismatch → `backup failed`. Weekly, the same check runs against the latest commit.

### 11.4 Restore (`POST /owner/import`, Cloudflare Access only)

A restore **always creates a new vault** (new vault id, new DO). It never imports over a live vault, so there is no staging, no lock on the live data and no doubled storage.

1. The owner picks a backup commit. The Worker creates the new DO with `meta.state = importing`; any client request to it gets `503 importing` until activation.
2. Alarm-driven, resumable batches read the commit tree, write blobs to R2 and fill the new DO's tables. Progress is stored per batch; a crash resumes.
3. Activation: when the manifest hash verifies, one transaction sets `epoch` to a **fresh random generation id**, writes `changes` (one synthetic entry per current row), rebuilds `files_fts`, sets `state = ready`. The old vault's DO is set to `state = retired`: every request to it answers `410 vault_retired` with the new vault id.
4. Each plugin, on `410 vault_retired`, switches its vault id (same credentials, same grants: grants are bound to the owner, not the vault id) and re-hydrates per §7.3 under the new epoch: equal hashes stay clean, different hashes become conflict copies, nothing local is lost.
5. The retired vault is kept read-only for 30 days, then deleted by the owner from the console.
6. Acceptance (AC-07): restore from the last export, then read an intermediate revision older than the export and a deleted file, verifying hashes; a device with a local edit ends with that edit as a conflict copy.

### 11.5 Entry condition for F4 (R6)

Backup repository configured, one export `complete` and verified, and one restore demonstrated per §11.4 **before** the plugin touches the real vault.

## 12. Limits, retention and capacity (R9)

| Item | Limit | Behavior at limit |
| --- | --- | --- |
| Text file inline | 1,000,000 bytes | `413 text_too_large` for update/append; larger files sync as blobs, unindexed |
| Blob | 25 MB | `413 blob_too_large`; file listed as unsupported |
| Files per vault | 10,000 | `507 capacity_exceeded`; *attention* |
| Path | 512 bytes, 32 segments | `400 invalid_path` |
| Feed retention (`changes`) | 30 days | Older cursor → `410 cursor_expired` → full reconciliation |
| Revision retention (`revisions`) | 30 days, **floor 7 days** (floor approved by owner, §17.1); revisions pinned by an export are exempt | Pruned nightly. If logical payload bytes in `revisions` + `receipts` + `changes` exceed **1 GB**, prune oldest revisions beyond the 7-day floor. Raise *attention* "history reduced". Never cross the floor or remove export pins. |
| Tombstones (`files.deleted=1`) | kept forever | Negligible size; guarantees deletes are never inferred |
| Receipts | 30 days (accept window 25 days + 5 min skew) | §6.4 |
| DO SQLite total | **2 GB** product envelope, including admission storage. Needs Workers Paid. | Alert at 1.5 GB. At 2 GB, every mutation except `delete` returns `507 capacity_exceeded`. Every mutation writes a revision row, so content cannot be accepted without its revision. Reads continue. Raising this envelope is a v2 decision. |
| R2 blobs | 10 GB free tier | Alert at 4 GB; GC trigger at 1 GB unreferenced (§16) |
| Worker memory | 128 MB | No full-vault materialization anywhere; exports and hydration stream per file |
| Polling | §7.4 | *measure* in F4: requests/day per device, p95 feed latency |
| Export | ≤ 25 MB per Git blob, one at a time; ≤ 50 calls per alarm invocation; ≤ 60 content-creating calls per minute; ≤ 450 per hour | Partial export stays `in progress`; never announced as complete until the ref moves and verification passes; pinned revisions are never pruned |

Cloudflare lists 10 GB per SQLite Durable Object on Workers Paid and 1 GB on Workers Free. Its [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) give these limits. We read this page on 2026-10-17.

SQL queries accept at most 100 bound parameters. Tables can have at most 100 columns. Each string, BLOB, or table row can use at most 2 MB.

The [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), read 2026-10-17, states that `sql.databaseSize` returns database bytes. It also states that `transactionSync` rolls back when its synchronous callback throws.

The 2 GB total cap uses `sql.databaseSize`, including admission storage. Logical history counters do not replace this physical database observation. Retention runs in synchronous transactions of at most 64 selected feed rows or 49 composite-key rows. The native Vault alarm owner schedules continuation separately from the next nightly 03:00 UTC cycle.

History pressure uses logical payload bytes from `revisions`, `receipts`, and `changes`. Transactional `meta` counters track each category and their sum. Publication updates these counters in the same transaction as its rows and receipt. Pruning subtracts the deleted payload bytes in its deletion transaction.

Encode each complete row as a JSON array in its SQLite column order. Measure the UTF-8 byte length of that JSON text. Revision columns are `path`, `rev`, `hash`, `size`, `kind`, `content`, `blob_hash`, `deleted`, `origin`, and `at`. Receipt columns are `client_id`, `key`, `fingerprint`, `status`, `body`, and `at`. Change columns are `seq`, `op`, `path`, `rev`, `hash`, `from_path`, `from_rev`, `origin`, and `at`. Null values remain JSON `null`. Test Unicode, null content, and blob references. Exclude SQLite allocation overhead, indexes, FTS storage, and external R2 object bytes from these logical counters. Logical payload bytes do not claim exact physical table storage.

The pinned workerd SQLite runtime does not expose `dbstat`. Native tests on 2026-10-22 returned `no such table: dbstat: SQLITE_ERROR`. Exact per-table page attribution is not a prerequisite for logical history accounting. No platform investigation task applies.

The owner approved this accounting contract for OAB-6.8 on 2026-10-22. The 30-day retention policy, 7-day floor, permanent tombstones, and export-pin protection remain unchanged.

We did not verify the deployment account tier. This specification does not claim full-product Workers Free support. Admission storage feasibility uses the smaller 1 GB Workers Free limit.

The native admission storage test has a growth target of at most 32 MiB. It uses an initialized empty fixture and three saturation, expiry, cleanup, and refill cycles. This target does not add a runtime database-size guard.

Cost expectation: $5/month base. Included allowances cover the measured vault with two orders of magnitude of headroom.

The panel shows DO storage, R2 bytes, and requests per day. The owner sees drift before billing.

## 13. Acceptance cases

Each case is a test (Worker: `@cloudflare/vitest-pool-workers` against the real DO; plugin: two local vaults on the Mac driven by Obsidian) and a gate for the phase that introduces it.

| ID | Scenario | Expected |
| --- | --- | --- |
| AC-01 | `PUT` succeeds but the response is lost; client retries with same key | Stored receipt returned; one revision; one feed entry |
| AC-02 | Plugin killed after each step of §7.6 and restarted | Both versions exist exactly once; same resolution completes; no extra copy |
| AC-03 | A and B edit the same note offline, then both sync | Server has the first publisher's bytes at `path`; the other device holds `path` with server bytes and one conflict copy; both files appear on both devices |
| AC-04 | A deletes, B edited offline from the same base | Tombstone stands; B's bytes appear as conflict copy on both devices; `path` is trashed on B |
| AC-05 | A renames X→Y, B edited X offline | Y holds A's bytes everywhere; B's bytes appear as `Y (conflict …)`; X is gone; links rewritten by A arrive as ordinary puts without re-rewriting on B |
| AC-06 | B deletes while offline, A edited meanwhile | On B's reconnect the delete is dropped; A's bytes appear at `path` on B; *attention* item shown |
| AC-07 | Restore into empty DO from last export | Current files, an intermediate revision older than the export, and a deleted file are recoverable with matching hashes; old-epoch requests fail before mutating |
| AC-08 | Owner revokes a client | Next request to the DO fails `401 revoked` within one request, independent of KV propagation; device shows `revoked`, keeps files |
| AC-09 | Full ChatGPT loop | Read a note; create a note; it appears in Obsidian without manual review; edit in Obsidian; ChatGPT reads the change; concurrent offline edit yields a conflict copy; an interrupted append retried with a key produces one entry |
| AC-10 | User saves a new edit between hash check and write during apply | `process` callback sees different bytes; nothing written; the user's edit is published; no loss |
| AC-11 | Local and remote identical bytes, different from base | Base updated; no write; no conflict |
| AC-12 | Device offline 40 days returns | `cursor_expired` → full reconciliation; remote deletes applied via tombstones; dirty paths become conflict copies; no path treated as a new create |
| AC-13 | Restore bumped the epoch | Every client re-hydrates; clean files untouched; no duplicates |
| AC-14 | Create `Notes/café.md` when `notes/CAFÉ.md` exists; then rename `notes/CAFÉ.md` → `notes/Café.md` | Create returns `409 path_collision` with the existing path; the case-only rename of the same file succeeds |
| AC-15 | Search examples of §10 | Each returns the expected note with a snippet; two-character query rejected; `AND` matches literally |
| AC-16 | A 1.5 MB Markdown file | Synced as blob with exact bytes; listed `large: true`; readable by range; absent from search; shown in panel |
| AC-17 | Idempotency edge cases | Same key, different payload → `422`; key 26 days old → `409 operation_expired`; key 10 minutes in the future → rejected; key 4 minutes in the future → accepted |
| AC-18 | Pending rename X→Y meets remote edit on X | Rename dropped; X has remote bytes; local Y with old bytes trashed, or kept if it was edited |
| AC-19 | Coexistence mode: file removed by iCloud eviction | No delete published; owner sees a confirmation item; placeholder excluded |
| AC-20 | Enrollment of a second device whose vault already has content | Equal files clean; local-only uploaded; remote-only downloaded; differing files keep both via conflict copy; nothing overwritten |
| AC-21 | Hydration while another client writes | Manifest rows with `seq > head_seq` applied; feed revisits them as no-ops; a pruned pinned revision falls back to current |
| AC-22 | Append on a tombstoned note; append that would exceed 1 MB | `409 tombstone`; `413 text_too_large`; no partial write |
| AC-23 | Export fails (GitHub 5xx) mid-chunk | `exports` records failure and step; the next alarm resumes from stored blob SHAs; the ref moves only once; devices show `backup failed` only after 48 h without a complete export |
| AC-24 | Rename received by a device whose `from` is dirty | Local bytes saved as conflict copy; `to` holds the bytes fetched by `to_rev`; `from` trashed; no device waits for a later `put` |
| AC-25 | Hydration applied rev 3, feed later replays rev 2 for the same path | Entry ignored because `rev ≤ base.rev`; no write, no conflict |
| AC-26 | Rename into a path that was tombstoned with 10 prior revisions | `to_rev = 11`; `revisions` has no primary-key collision; history of `to` shows the rename |
| AC-27 | Client with `vault:write` only gets a `412` | Body has `etag`, `hash`, `deleted`; no content |
| AC-28 | Revoked client uploads a 20 MB blob | `authorize` fails before any byte reaches R2 |
| AC-29 | `append_to_note` without `idempotency_key` | Rejected `428`; with the same key twice → one revision |
| AC-30 | A `sent` op with lost response; user edits the same note before the retry | Retry uses the original key and bytes; the new edit is a second op with its own key and precondition; result: two revisions in order, no `422` |
| AC-31 | Blob apply where the file's mtime changes between hash check and write | Apply aborted; entry re-evaluated as dirty; conflict copy created; nothing overwritten |
| AC-32 | User edits during `process` so the callback refuses the remote write | `base` unchanged; the remote entry is re-evaluated as a conflict against the **current** local bytes; the remote revision is applied at `path` and the local bytes survive as the conflict copy; the entry is never discarded |
| AC-33 | Hydration read X before a rename and Y after; feed replays the rename | Destination side skipped (`base[Y].rev == to_rev`); source side applied (X trashed, tombstone recorded); no duplicate Y |
| AC-34 | `create_note`/`append_to_note` prepared before a restore, sent after | `409 epoch_mismatch`; no write |
| AC-35 | Requests during a restore | The new vault answers `503 importing` until activation; the old vault answers `410 vault_retired` after it; clients switch and re-hydrate by hash; no client ever reads a partial table |
| AC-36 | Export in progress while a pinned revision reaches 30 days or capacity pressure triggers pruning | Pinned revision survives; export completes with the exact bytes of the cut |
| AC-37 | Export against a mocked GitHub that returns `403` secondary-limit | Alarm sleeps for `Retry-After`; pacing never exceeds 60/min or 450/h in the test log; export completes |
| AC-38 | Two clients send the same idempotency key | Two independent receipts; no `422` |
| AC-39 | Crash after writing a conflict copy but before `copied`; user edits the copy; restart | The edited copy is never overwritten; item goes to *attention*; original path untouched |
| AC-40 | Feed replays a rename whose `from_rev` is lower than the live `base[from].rev` | Source side ignored; nothing trashed |
| AC-41 | After a restore the new epoch has `rev 3` where a device held `base.rev 8` | Hash comparison wins; base rewritten; a locally changed file becomes a conflict copy |
| AC-42 | Restore succeeds, response lost, another client deletes again, retry | `412` on `If-Match`; the note stays deleted |
| AC-43 | Vault at 10,000 files or 2 GB | Next content mutation `507`; reads and deletes continue; panel shows the limit |
| AC-44 | The same backup is restored twice; a device with a pending edit against the first restored vault switches to the second | The two vaults have different epochs; the pending `If-Match` fails with `epoch_mismatch`; the device re-hydrates by hash and its edit becomes a conflict copy; no silent overwrite |

## 14. Delivery phases

No disposable demos; every phase ships the same code.

F1 is a server-only gate. Local protocol, real Durable Object, and Worker HTTP tests establish only the tested Worker behavior. Independent task review, human branch review, and actual remote CI must also pass before F1 exit. This evidence does not qualify plugin sync, conflict copies, offline recovery, MCP/OAuth transport, deployed authentication, or device effects. Keep those obligations in their later phase gates. Keep OAB-6.8.2 Deferred.

| Phase | Deliverable | Entry | Exit |
| --- | --- | --- | --- |
| F0 | New repo: Bun monorepo (`apps/worker`, `apps/plugin`, `packages/protocol` with Zod schemas shared by Worker, plugin and tests), `AGENTS.md`, Backlog.md initialized with tasks and deferred items, CI (Biome, typecheck, Vitest) | Spec approved | `bun run check` green on first commit |
| F1 | Worker: DO schema, all `/v1` endpoints, authorize/commit tickets, idempotency, search, limits, revocation table; tests with real DO | F0 | Server portions of AC-01, 03–06, 11, 12, 14, 15, 16, 17, 18, 21, 22, 25, 26, 27, 28, 29, 34, 38, 40, and 43, plus independent task review, human branch review, and actual remote CI |
| F2 | OAuth (provider + Access), MCP server and tools, owner console (clients, revoke) | F1 | MCP Inspector, Claude Code and ChatGPT web connect; read and write work; AC-08. Owner verifies Developer mode and iPhone availability in their ChatGPT account; result recorded, owner decides on mobile client strategy |
| F3 | Plugin Desktop: enrollment, hydration, feed, publish, Option B, status panel, Sync now | F2 | Two test vaults on the Mac pass AC-02, 03, 04, 05, 06, 09, 10, 13, 20, 24, 30, 31, 32, 33, 39; AC-09 run against real ChatGPT |
| F3b | Backup: alarm-driven incremental export to the private backup repo, verification, restore into a new vault | F1 | AC-07, 23, 35, 36, 37, 41, 42, 44 against a synthetic 500-file vault (about one hour of paced export) |
| F4 | Real vault on the Mac in coexistence mode, plugin only on the Mac | F3 + F3b restore demonstrated | Two weeks max; AC-19; polling and storage measured; no *attention* item unexplained |
| F5 | Mobile: plugin installed via BRAT on iPhone and iPad against a **copy** of the vault, then the real one | F4 | AC-03/04/05 across three devices; `secretStorage` behavior recorded per platform; offline edit on iPhone resolves correctly |
| F6 | Cutover: new local vaults outside iCloud on each device hydrated from the service; iCloud no longer owns the live vault; coexistence mode off | F5 + fresh verified export | Single sync owner per device; AC-13 after a rehearsal restore |

## 15. Repository and process

### 15.1 Layout

```
apps/worker        Hono Worker, DO class, cron, MCP, OAuth; wrangler.jsonc
apps/plugin        Obsidian plugin (esbuild); manifest.json; BRAT-compatible releases
packages/protocol  Zod schemas: paths, ETags, error codes, API bodies, MCP tool schemas
AGENTS.md          agent rules (below)
Backlog.md         tasks and deferred items (tool: Backlog.md)
docs/spec.md       this document, in English
```

### 15.2 `AGENTS.md` (full content)

```markdown
# Agent rules

Sources of truth: docs/spec.md says what the product does; Backlog.md says what is in progress and what is deferred. There is no roadmap, no milestone marker, no qualification report.

Per task: pick a Backlog.md task; write the failing test first; implement; run `bun run check`; run the code-review skill; close the task. Evidence is a passing test, not a document.

Invariants no change may break: every mutation is conditional on the exact observed revision; absence never deletes; an obsolete revision never overwrites; every collision leaves two visible files or revisions.

Never: touch the owner's personal vault; deploy, modify or delete Cloudflare resources without explicit authorization in the current conversation; change git identity; add a dependency without stating why in the task; create demos, labs or parallel plugins. If something cannot be tested in the real code, add a deferred task with a trigger.

Conventions: English in the repo; Conventional Commits; Biome formatting; Zod schemas in packages/protocol are the only place protocol shapes are defined.
```

### 15.3 Tooling

Bun workspaces; Hono; `@cloudflare/workers-oauth-provider`; `@modelcontextprotocol/server`; Zod; Biome; Vitest with `@cloudflare/vitest-pool-workers`; Wrangler; esbuild for the plugin; BRAT for beta installs; Release Please optional later.

## 16. Deferred (tracked in Backlog.md, label `deferred`)

| Item | Why not now | Trigger to reopen | Seam preserved in v1 |
| --- | --- | --- | --- |
| Blob garbage collection | Race between orphan detection and new references during DO I/O awaits | Unreferenced blobs > 1 GB | `blob_refs` table; contract: mark hash in `blob_gc` inside the transaction, reject publishes referencing marked hashes, delete in R2, clear mark |
| WebSocket push from DO | 15–60 s polling is enough for one owner | Measured latency complaint or request cost > 50% of allowance | Feed is `seq`-based; push only says "new seq", pull unchanged |
| Embeddings / semantic search | FTS covers the current vault | Agents miss notes by synonym in real use | `search_notes` returns `rev` and snippets; a second backend plugs behind it |
| `.obsidian/` settings categories | Not needed to replace iCloud for content | Manual re-configuration becomes a daily cost | Scope is a pattern list |
| Append under a heading | No agent needs it yet | A concrete agent workflow requires it | `append` is a DO operation |
| Packed baseline export (one archive upload instead of one blob per item) | Only matters for first exports of large vaults; current vault exports in under an hour | Vault above 5,000 items, or owner unwilling to wait days for a first backup | Export manifest and pins are independent of how items are published |
| NAS or second storage | Export is already portable | R2 > 10 GB or desire for off-Cloudflare copy beyond GitHub | Blob access behind one `BlobStore` interface; nightly export format |
| Windows / Linux | No device | A device exists | No Node/Electron APIs in the plugin |
| E2E encryption | Would break server-side search and append | Owner requirement changes | None; would be a redesign |

## 17. Open items that do not block planning

1. Owner's ChatGPT account: Developer mode availability, write tools, iPhone/iPad connector availability (F2 exit).
2. `app.secretStorage` behavior on iOS/iPadOS (F5).
3. Measured polling cost, DO storage growth and feed latency (F4).
4. Owner may rename the agent folder convention and retention values (§2).

### 17.0 Review policy from v1.3

The specification is frozen for implementation. Cross-review continues on code and tests from F1 onward; a finding against the design becomes a Backlog.md task with the affected section named, and the spec is amended only when a task changes a contract. No further spec-only review rounds.

### 17.1 Explicit owner approvals

**Both approved by the owner on 2026-10-11.** The "default if approved" column is the active behavior.

| Decision | Default if approved | If rejected |
| --- | --- | --- |
| History floor of 7 days under the 2 GB capacity cap (§12) | Oldest revisions beyond 7 days are pruned with a visible *attention* item | New revisions are refused with `507 capacity_exceeded` once the cap is hit, history is never reduced |
| Blob apply residual window (§7.5) | Blobs are applied automatically with the double-`stat` guard and a 7-day `pre-apply` copy | Blob changes to any locally modified file go to *attention* and are applied only on owner action |
