# Vaultwire — Specification v1.3

Self-hosted vault sync and storage, with MCP tools for AI agents.

**Status:** design specification, approved for planning once the owner reviews it. It is the single current contract. Earlier documents (PRD, Rewrite Brief, Contraste de análisis §1–§11) are history; where they differ from this document, this document wins.

**Date:** 2026-10-11 (v1.3, frozen for implementation after the fourth cross-review; further findings become Backlog.md tasks against code, not spec rounds). **Authors:** Claude (Fable 5.1) with cross-review by a second agent (Amp). **Owner:** Moisés Morillo.

**How to read:** sections 1–3 say what and why. Sections 4–12 are contracts. Section 13 lists acceptance cases that every phase must pass. Sections 14–16 define delivery, repository process and deferred work. Numbers are design limits to be confirmed by measurement where marked *measure*.

---

## 1. Purpose

One Obsidian vault, usable offline on Mac, iPad and iPhone, synchronized through a private service on Cloudflare that is also reachable by authorized AI clients over MCP. The service replaces iCloud Drive as the vault's sync provider and lets agents read and write the vault from anywhere without the Mac being on.

### 1.1 Goals (v1)

1. Bidirectional sync of the vault across enrolled Obsidian installations with no designated writer.
2. MCP access for authorized agents (ChatGPT first; Claude and Claude Code use the same server) to list, read, search, create, update, append, delete and restore notes, with changes arriving in Obsidian automatically.
3. No silent data loss: exact-revision conditional writes, recoverable history, visible conflicts. iCloud Drive keeps an independent copy of the live vault until cutover (§11).
4. Cost target: Workers Paid base ($5/month); everything else inside included allowances at the measured vault size.

### 1.2 Non-goals (v1)

End-to-end encryption; sync while iOS/iPadOS suspends Obsidian; automatic text merge; multi-user collaboration or per-folder permissions; NAS or any second storage backend; sync of `.obsidian/` settings categories; semantic/embedding search; WebSocket push; Windows/Linux support; automatic blob garbage collection. Each appears in §16 with a reopening trigger.

## 2. Fixed owner decisions

| Decision | Value |
| --- | --- |
| Product | Vaultwire |
| Tagline | Self-hosted vault sync and storage, with MCP tools for AI agents |
| Worker script | `vaultwire` |
| Service hostname | `vaultwire.mmorillo.dev` |
| R2 buckets | `vaultwire-blobs` and `vaultwire-backups` |
| OAuth KV namespace | `vaultwire-oauth` |
| Deploy token | `vaultwire-github-deploy` |
| Current sync | iCloud Drive; vault at `iCloud~md~obsidian/Documents/Vault` |
| Scope of v1 | Both agent access and iCloud replacement |
| First MCP client | ChatGPT; OAuth is generic (2.1 + PKCE + discovery + DCR), nothing client-specific |
| Permissions | Per client: `vault:read`, `vault:write`, `vault:delete` over the whole vault. No path ACLs |
| Plan | Workers Paid accepted |
| Legacy | Repo and git history restarted from scratch; worker `obsidian-bridge.mmorillo.dev`, bucket `obsidian-ai-bridge` and KV wiped; nothing migrated |
| Conflict policy | **Option B**: the confirmed remote operation stands; pending local content is preserved as a conflict copy at a new path; nothing is resurrected automatically |
| Backup destination | Hourly packed current-file snapshots in the dedicated `vaultwire-backups` R2 bucket. Infra deletes `backups/` objects after 15 days (§11) |
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
     └─ (hourly scheduled trigger starts a packed baseline; the owner console can also start one; Vault alarms resume work, §11)
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

- **Vault epoch** (`epoch`): a **random 128-bit generation id** (32 hex chars) assigned when a vault is created and again by every service-vault restore (§11.4). A local packed-baseline restore does not change the service epoch. It is never derived from a previous epoch, so two service restores of the same backup never share ETags. Every ETag and every feed cursor carries it. A mismatch means "re-hydrate".
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

CREATE TABLE packed_exports (
  id TEXT PRIMARY KEY NOT NULL, epoch TEXT NOT NULL, created_at TEXT NOT NULL,
  head_seq INTEGER NOT NULL, status TEXT NOT NULL, object_key TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, size INTEGER, upload_id TEXT,
  zip_state TEXT NOT NULL, manifest_size INTEGER NOT NULL,
  completed_parts TEXT NOT NULL, error TEXT,
  CHECK (status IN ('queued','uploading','complete','failed'))
);
CREATE UNIQUE INDEX packed_exports_identity ON packed_exports(epoch, created_at);
CREATE TABLE packed_export_files (
  export_id TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL,
  rev INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('revision_text','revision_blob','snapshot_text','snapshot_blob')),
  PRIMARY KEY (export_id, ordinal)
);
CREATE UNIQUE INDEX packed_export_files_path ON packed_export_files(export_id, path);
CREATE TABLE packed_export_chunks (
  export_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('manifest','pending','source')),
  ordinal INTEGER NOT NULL, data BLOB NOT NULL CHECK (length(data) <= 1,000,000),
  PRIMARY KEY (export_id, kind, ordinal)
);
```

The canonical schema version is 9. Versions 1 through 5 fail closed without writes. The service upgrades exact version-6, version-7, and version-8 stores in one transaction and rejects other unsupported storage without repair. Version 4 adds `history_revisions_bytes`, `history_receipts_bytes`, `history_changes_bytes`, `history_pressure_bytes`, and `history_reduced` metadata. Version 5 adds `retention_category` and `retention_pruned_feed_seq`. Version 6 adds nullable `files.renamed_to` for the immediate destination of a source rename tombstone. Version 7 adds the owner registry and one-use CSRF tables. Version 8 adds resumable packed-export tables, bounded payload chunks, and their unique indexes. Version 9 adds the `blob_gc` mark table (`hash`, `size`, `marked_at`) and the blob garbage-collection metadata `blob_gc_generation`, `blob_gc_run_id`, `blob_gc_phase`, `blob_gc_cursor`, `blob_gc_delete_owner`, `blob_gc_delete_state`, and `blob_gc_failure` (OAB-13). Fresh version-9 vaults initialize all history counters and the feed boundary to zero, and the blob garbage-collection state to generation 0 and phase `idle`.

The startup check rejects every catalog object that the schema does not define. It ignores only platform objects: SQLite internals, native FTS shadow tables, the `_cf_METADATA` alarm table, and the local Miniflare table `__miniflare_do_name` with its exact definition `(id INTEGER PRIMARY KEY, name TEXT)`. A different definition or another `__miniflare_` name still fails.

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
- MCP: `append_to_note` and `append_under_heading` **require** `idempotency_key` in their input schemas; other mutating tools may accept it optionally and use their `etag` or create-only preconditions. No server heuristic de-duplicates appends.

### 6.5 Request limits

The production Worker declares a CPU limit of 30,000 ms per invocation in its Wrangler configuration. This needs Workers Paid. On Workers Free the platform stops an invocation after 10 ms of CPU. A stop before headers returns error 1102. A stop after headers leaves a cut HTTP 200 body and an incomplete read lease until the reclaim grace. The OAB-53 production run on 2026-11-10 showed this on manifest, feed, and MCP reads.

Eight body-bearing mutations share synchronous slots across clients, vault hosts, and router instances in one Worker isolate. PUT, append, rename, and restore use this budget. A request beyond this count receives `429 admission_limited` without body demand or durable reservation.

A slot covers body handling, storage, authority calls, cleanup, and application-owned response preparation and production. Operation cleanup and response production must both settle before slot reuse. Response production ends after producer EOF or cancellation cleanup, not after the final chunk enters a stream.

This boundary does not prove client receipt or release by the last native owner. Cancellation or ticket expiry does not release a slot before started work settles. Permanently blocked work can exhaust slots and cause safe refusals.

Mutation failure responses preserve complete authorized text through bounded JSON chunks. Encoding does not create a complete escaped content string or a complete JSON body. Response reads and encoded chunks stay at or below 65,536 bytes.

JSON read and MCP responses join encoded tokens into chunks of at most 16,384 bytes. A token part that does not fit flushes the chunk first. Feed, manifest, and history pages also flush before each storage batch request, so batch demand stays one at a time. Each response chunk crosses the runtime output pipe on its own. Token-sized chunks made a 1,000-entry feed page (219 KB) 54,017 chunks. Local reads took about 470 ms, and production reads took 5 to 15 s (OAB-53, 2026-11-10). Coalesced, the same local page takes about 33 ms.

Native body reads request at most 65,536 bytes at a time. Raw inline text bodies and decoded note text remain limited to 1,000,000 bytes. The REST heading-append JSON body has a separate 6,100,000-byte wire limit for JSON escaping. Inline readers allocate at most their per-request wire limit and do not retain borrowed chunks. Blob reads and writes use bounded native streams, without a complete blob buffer.

REST reads use four isolate-local slots and a separate 18,000,000-byte pool. Each REST read reserves 4,500,000 bytes. MCP reads use eight separate slots and cannot consume REST capacity.

Each read lease expires after 60,000 ms. Admission, completion checks, and capacity observations sweep overdue leases when request timers stop. Expiry frees logical capacity but does not prove that physical source work stopped.

Every owned read response registers its remaining work with `waitUntil`. The registration ends when response work completes. After a lease deadline it ends when the expired work settles, or at most 5,000 ms later when source or cancellation work never settles. A response without a deadline lease, such as some MCP failure bodies, has no such bound and relies on the platform `waitUntil` limit. The platform cancels every task of a request whose client disconnects unless `waitUntil` holds it. Without this registration a canceled body never sees its failed write or cancels its source. Its lease and bytes then stayed held until the reclaim deadline, about 120 s (OAB-53). With it, a canceled 25 MB blob read returns its REST slot and 4,500,000 bytes after the pending storage read and source cancellation settle. Native fixed-length framing and the OAB-36 ordering stay unchanged.

Known limit: generic JSON read responses (feed, manifest, history, search, vault, content JSON, MCP) are JavaScript byte streams. In the local Workers runtime (workerd 1.20261006), a client that cancels such a body after its first chunk never triggers the stream's cancel callback, even with `waitUntil`. The lease and bytes then stay held until the lease deadline and the reclaim deadline. A local socket probe showed the same for byte streams on workerd 1.20251011. Fixed-length blob responses are not affected because their writer observes the cancellation.

Byte ownership continues until started source work and cancellation settle, or until the reclaim deadline. The reclaim deadline is the lease deadline plus a 60,000 ms grace. At that deadline the Worker releases the byte reservations of unsettled work once and counts the lease as reclaimed unsettled. A REST lease releases its REST read bytes. An MCP read lease releases its MCP envelope reservation in the shared pool, which also frees one MCP admission count. A later settlement releases nothing a second time. Admission and capacity observations apply the reclaim without a timer. Reclaim bounds the time a stalled read can fill the REST or shared pool. It does not prove that physical source work stopped. Count or byte refusal occurs before metadata or R2 demand.

Vault, manifest, changes, history, and search responses and their read failures send `Cache-Control: no-transform`. File content, blob, and history-command responses send it, and so do file failure responses. MCP JSON responses send `Cache-Control: no-store, no-transform`. The header stops edge compression, which could end a body that the Worker errors at its lease deadline as a short 200 (observed 2026-11-10). A body that a lease deadline stops errors the response stream. It never ends as a clean short body.

Each successful read keeps one durable admission through response production and cleanup. Metadata responses demand one bounded batch at a time. Response encoding never creates a complete escaped inline string or JSON page. Cancellation joins started RPC, storage reads, and cleanup before physical ownership ends. Unknown authority results keep the original admission deadline. Producer EOF does not prove client receipt or native release.

Body-bearing mutations and MCP envelopes share one 64,000,000-byte pool. Ordinary REST bodies reserve 8,000,000 bytes. Heading-append bodies reserve 32,000,000 bytes.

MCP reserves `4,000,000 + 8 × B + 128 × min(B, 65,536)` bytes, where `B` is the checked wire-byte upper bound. A maximum 6,100,000-byte envelope reserves the full 64,000,000-byte pool. An absent Content-Length uses that maximum bound.

A valid Content-Length limits streamed bytes before decoding or parsing. MCP reservations include nested read and mutation data, without a second byte charge. Body counts remain independent of byte ownership.

Eight MCP envelopes can run at the same time if their bytes fit. MCP admission waits at most 2,000 ms, with at most 30 queued requests and no queued body demand. Release wakes eligible requests in FIFO order, but a large request cannot block smaller requests that fit.

A full logical MCP read pool returns `Retry-After` from its earliest active lease deadline. The estimate uses whole seconds rounded upward, bounded from 2 through 60. This estimate does not predict physical-byte release.

Unknown physical-byte completion returns `Retry-After: 2`. Logical read expiry does not establish physical completion. Durable authority retry values stay unchanged.

A Vault Durable Object call that the platform refuses as overloaded (`overloaded === true`, for example "Durable Object is overloaded. Requests queued for too long.") returns `429 admission_limited` with `Retry-After: 5` on REST. An MCP tool result carries the `admission_limited` tool error. An overload in the MCP request epoch check returns HTTP 429 with `retry-after: 5`. The Worker does not retry the call. The platform does not promise that a refused call never reached the object. Every path therefore keeps the durable admission of an overloaded call uncertain, never settled, with its original deadline, and mutation retries stay conditional on the observed revision. Other unknown RPC failures remain `500 internal_error`. The plugin retries the refusal after the larger of its backoff and `Retry-After`.

The plugin treats a 2xx response whose body is not valid JSON as a truncated transfer. It raises the retryable network failure class, so status reports a network failure and the next cycle retries. A valid JSON body that fails its schema stays a protocol fault.

Byte ownership continues through operation cleanup and response production. Timers serve only active leases, waiters, and bounded cleanup. Completed owners leave no polling, alarms, or agent-only idle timers.

The combined application reservation ceiling is 82,000,000 bytes, including the separate 18,000,000-byte REST read pool. This leaves 46,000,000 bytes within a conservative 128,000,000-byte isolate limit. These reservations cover selected application data, not the complete runtime heap.

OAB-53 measured isolate memory on 2026-11-10. In local workerd with a 128 MB V8 heap cap and the Worker and Vault Durable Object in separate isolates, the REST, MCP, upload, slow, and cancel workloads ran at concurrency 1 through 12 without isolate failure, workerd exit, or 5xx. Admission returned 429 at some levels. The stalled-read phase held 4 REST and 8 MCP reads past the reclaim grace. Peaks were 57.7 MB heap used and 90.4 MB heap plus ArrayBuffer backing stores in the Worker isolate. In the Vault isolate they were 118.0 MB and 132.1 MB, because its heap fills to the cap before collection. After collection the heaps held at most about 33 MB (Worker) and 25 MB (Vault).

Production on Workers Paid (Worker 1.0.4, `limits.cpu_ms` 30,000) showed no memory failure up to concurrency 12. The first production limit was the single Vault Durable Object request queue, not isolate memory. Production telemetry gives only invocation outcomes. In production, native stream buffers, transport-retained RPC results, and native response fragments stay unmeasured. OAB-6.8.2 stays deferred until Cloudflare exposes isolate memory telemetry or an owner-approved workload can observe native memory categories. The 128-byte structural allowance is an estimate, not an object-size guarantee. Profile again before another concurrency increase or after an exceeded-memory event.

Body ≤ 26 MB (25 MB blob + headers). Manifest page ≤ 256 rows. Feed page ≤ 1,000 entries. Search ≤ 50 results. Range reads ≤ 1 MB per response. Concurrency per client: the plugin runs at most 4 in-flight requests; the Worker returns `429` with `Retry-After` above 16 concurrent requests per client.

## 7. Plugin

Single codebase for Desktop and mobile (`isDesktopOnly: false`, `minAppVersion: 1.13.0`). No Node or Electron APIs. Network via `requestUrl`.

### 7.1 Per-device state

Device authority stays outside `data.json`, which iCloud syncs between devices:

- **Credentials**: OAuth tokens in `app.secretStorage` when available on the device (Obsidian ≥ 1.11.4); otherwise `app.saveLocalStorage` with a visible "tokens stored unencrypted on this device" status. Verified per platform in F3 and F5. `data.json` holds only shared non-secret settings, such as server URL, device label, and coexistence flag.
- **Settings sync**: Every device opts in separately. The master setting `Sync settings categories` defaults off. Category switches default on behind the master. These selected files sync as exact-byte blobs through adapter access, including files absent from the Vault index. Raw create and modify events capture existing selected files; missing paths never create delete intent. Settings consent and category switches use `app.saveLocalStorage`, not `data.json`. A shared `enabled: true` value never grants device consent. Scope expansion saves a full-manifest hydration duty with the local policy before new work. This duty survives Pause, disconnection, suspension, interrupted persistence, and restart. Recovery completes a fresh full-manifest pass before normal event admission, scans, publication, or feed work. An old-scope checkpoint cannot replace this pass. Incomplete traversal or failed completion persistence retains the duty. Immutable sent-operation retries can resolve traversal blockers. Queued dispatch still waits for complete hydration. This contract supersedes the historical `.obsidian/` settings non-goal in §1.2.

| Setting | Default | Included paths relative to `.obsidian/` |
| --- | --- | --- |
| Master | Off | Gates all settings categories |
| Appearance | On | `appearance.json`, `themes/**`, `snippets/**` |
| Core | On | `app.json`, `core-plugins.json`, `hotkeys.json`, `types.json` |
| Community plugins | On | `community-plugins.json`, `plugins/*/manifest.json`, `plugins/*/main.js`, `plugins/*/styles.css`, `plugins/*/data.json` |
| Always excluded | N/A | `workspace*.json`, `plugins/vaultwire/**`, `cache*`, `graph.json`, `plugins/*/node_modules/**` |

Excluded paths stay excluded under every switch combination. This selected-settings exception overrides §7.8's blanket `.obsidian/**` exclusion only for the listed included paths. Preserve different local bytes as visible conflict copies under `Vaultwire settings conflicts/`, outside `.obsidian`. Every settings conflict copy uses a sync-supported extension. Unsupported extensions gain `.txt`, including `.js`, `.css`, and `.woff2`. Extensionless files gain `.txt`. Global `.DS_Store` and `*.icloud` exclusions also apply inside selected settings trees. Vaultwire exclusion uses the canonical case-folded path identity. Enumeration prunes excluded dependency, cache, and irrelevant trees. A change to a community plugin's `data.json` needs that plugin to reload or Obsidian to restart. An enabled-plugin list change needs a vault reload or Obsidian restart. Changes to Vaultwire plugin settings need the plugin to reload or Obsidian to restart.

Automatic settings installation uses a pre-write target stat, an adapter write, and a hash-checked read-back. Observed competing versions remain visible as conflict files, with attention status. This guarded write is not atomic. A local version can appear after the last observation and disappear under the adapter write before any read observes it. The plugin cannot detect or recover that unobserved version. Creation and replacement both retain this race. This owner-approved limit overrides claims of complete collision protection for settings adapter writes. No manual-placement fallback applies.

- **Sync state** in `app.saveLocalStorage`, one JSON document, written atomically as a whole and read back after each write; a failed write puts the plugin in *attention* and stops publishing until it succeeds:
  - `device_id`, `client_id`, `epoch`, `cursor` (last applied `seq`)
  - `base[path] = {rev, hash}` — the exact server state this device last acknowledged per path
  - `pending_ops[]` — queue of outgoing operations: `{key (UUIDv7), op, path, to?, precondition, payload_hash, payload_ref, created_at, attempts, state ∈ {queued, sent, resolved}}`. **Before** an op leaves `queued`, its bytes are copied to `.vaultwire/pending/<key>` (excluded from sync) and verified by hash; `payload_ref` points there. A `sent` op is immutable: it is removed only on a receipt or an explicit rejection, and a newer edit of the same path becomes a new `queued` op behind it. Only `queued` ops can be replaced.
  - `pending_apply[]` — in-progress incoming applications (§7.5) for crash recovery: `{path, R, step, conflict_path?, conflict_hash?}`
  - `expected_writes[path] = hash` — echo suppression for writes the plugin itself is about to make (§7.5); never used as confirmed state
  - `attention[]` — items needing the owner

### 7.2 Enrollment

1. Owner opens Settings → Connect. Plugin opens the browser to `/authorize` (PKCE). Owner authenticates through Cloudflare Access, names the device, and approves all three scopes.
2. Callback via `obsidian://vaultwire/callback?code=…` (works on mobile). Plugin exchanges the code, stores tokens, registers in `clients`.
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

**Blob apply** (binaries and oversized `.md`/`.canvas`): Obsidian offers no atomic read-modify-write for binaries. Procedure: `stat` (mtime, size) → read → hash check against `B` → **re-`stat` immediately before writing; any change aborts and re-evaluates the entry as dirty** → copy the bytes just read to `.vaultwire/pre-apply/<hash>` (durable, excluded from sync) → `modifyBinary` → read back and verify `R` → only then `base[path] = R`. The remaining window spans the second `stat`, the durable pre-apply copy and the write itself, up to 25 MB of I/O. A user write landing inside it is lost from disk, but the bytes we read are preserved in `pre-apply` for 7 days. **This residual window was explicitly approved by the owner (§17.1).**

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

Included: `**/*.md`, `**/*.canvas`, and attachments with extensions `png jpg jpeg gif webp svg pdf mp3 m4a wav mp4 mov webm json csv txt` up to 25 MB. Excluded always: `.obsidian/**`, `.trash/**`, `.vaultwire/**`, `.DS_Store`, `*.icloud`, any path failing §5.1. The panel lists excluded and unsupported files on demand; the status never says "synced" while an in-scope file is pending, failed or in *attention*.

### 7.9 Status model

States shown per vault and per path in plain language: `disconnected`, `syncing`, `settled`, `pending`, `attention`, `revoked`, `paused`. The plugin does not show backup progress. The owner console lists completed packed snapshots under §11. `settled` requires: empty `pending_ops`, empty `pending_apply`, `cursor == head_seq` at last poll, state persisted. Every *attention* item has a reason code, the path, and one safe action (open, restore, keep both, dismiss). Controls are keyboard-operable, labelled, and do not rely on color alone.

### 7.10 Coexistence mode (phase F4)

A setting the owner turns on while iCloud still syncs the same live vault and the plugin runs only on the Mac:

- Local `delete` and `rename` events are **queued for owner confirmation** in the panel; never auto-published. iCloud eviction and placeholder churn therefore cannot publish destructive operations.
- `*.icloud` placeholders are excluded; a path that flips to a placeholder is treated as "unavailable", not deleted.
- Pause and exit: *Pause* stops publishing and applying but keeps queues; *Exit coexistence* requires an empty confirmation queue and either disabling the plugin or turning the mode off for cutover.
- Residual risk disclosed in the panel: iCloud and the user still write the same files; a concurrent iCloud write during an apply is handled by the hash check for text and is best-effort for binaries.

## 8. MCP server

Transport: Streamable HTTP at `/mcp`. Auth: Bearer token from §9; resource metadata (RFC 9728) and authorization server metadata (RFC 8414) published. Every tool result includes the current `epoch`; `create_note` and `append_to_note` require it as an argument because they carry no `etag`. `append_under_heading` requires the exact `etag` from the observed note revision. Server `instructions` (sent in `initialize`) describe the vault conventions: default folder `Agents/`, daily log path, frontmatter minimum (`created`, `source`), "search before create", "pass `etag` from `read_note` to `update_note` and `append_under_heading`", "always generate a fresh `idempotency_key` (any unique string) for each append and reuse that key only when retrying the same request".

| Tool | Scope | Arguments | Returns |
| --- | --- | --- | --- |
| `list_notes` | read | `prefix?`, `include_large?` | paths with `etag, size, updated_at, large` |
| `read_note` | read | `path`, `etag?`, `offset?`, `length?` | `content`, `etag`, `truncated`. A supplied `etag` that no longer matches current returns the current `etag` and no content, so fragments never mix revisions |
| `search_notes` | read | `query`, `limit?` | `[{path, etag, snippet, score}]` (§10) |
| `create_note` | write | `path`, `content`, `epoch`, `idempotency_key?` | `etag`. Create-only; `409` if exists (includes existing `etag`); `409 epoch_mismatch` if `epoch` is stale |
| `update_note` | write | `path`, `content`, `etag`, `idempotency_key?` | new `etag`. `412` with current `etag` (and content, since MCP agents hold `read`) on mismatch |
| `append_to_note` | write | `path`, `text`, `epoch`, **`idempotency_key` (required)** | new `etag`. `409` on tombstone; `409 epoch_mismatch` if stale; `413` if result > 1 MB |
| `append_under_heading` | write | `path`, `heading`, `text`, exact `etag`, **`idempotency_key` (required)** | new `etag`. First trimmed, case-sensitive heading match outside fenced code; missing heading refuses without a revision |
| `delete_note` | delete | `path`, `etag` | tombstone `etag` |
| `get_history` | read | `path` | retained revisions |
| `restore_note` | write | `path`, `source_etag`, `current_etag`, `as_conflict_copy?` | new `etag`. `412` if `current_etag` is stale |

All tools call the same DO operations as `/v1`. A successful mutation enters the feed and reaches every enrolled device by the normal pull, with `origin` set to the agent's client id and shown in the panel. Restore with `as_conflict_copy: true` writes in place at the same path and retains the displaced revision.

## 9. OAuth and authorization

### 9.1 Flows

OAuth 2.1 authorization code with PKCE, implemented by `@cloudflare/workers-oauth-provider`. Dynamic Client Registration (RFC 7591) enabled so ChatGPT, Claude and Claude Code register themselves; pre-registered client ids also accepted. No client-credentials grant. Refresh tokens rotate.

### 9.2 Owner authentication

`/authorize` and `/owner/*` sit behind **Cloudflare Access** (Zero Trust, free tier) with the owner's identity provider. The consent page shows client name, redirect URI, and requested scopes. It keeps `vault:read` selected and mandatory. Owners can clear requested `vault:write` or `vault:delete` scopes. The Worker validates selections against the stored consent request before it creates a durable grant. The Worker trusts the `Cf-Access-Jwt-Assertion` only after verifying it against the Access public keys.

### 9.3 Scopes

The Worker advertises `vault:read`, `vault:write`, and `vault:delete`. `vault:read` is mandatory at owner consent. Owners can grant either requested optional scope or both. `vault:write` does not imply `vault:delete`. The provider challenge accepts the full vocabulary, but token grants contain only selected requested scopes. Each `/v1` route and each MCP tool declares its scope (§6.1, §8). The Worker enforces scope on every request, and the Durable Object checks it again.

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

The Access-protected owner console starts packed current-file snapshots. A Workers Cron Trigger also starts one export each hour at `0 * * * *`. Both write archives to the dedicated R2 bucket `vaultwire-backups`; blob payloads remain in `vaultwire-blobs`. The `cloudflare-infra` lifecycle rule deletes objects under `backups/` after 15 days and aborts incomplete multipart uploads after seven days. Worker code does not prune archives. The separate `exports` table remains reserved for the former GitHub design. `packed_exports`, `packed_export_files`, and `export_pins` store resumable baseline work.

### 11.1 Consistent current-file cut

The owner starts an export from `/owner/exports`. The server assigns a canonical UTC millisecond timestamp. The epoch and timestamp form the idempotency identity. The Cron Trigger uses its scheduled timestamp as that identity. If queued or uploading work owns the vault, a scheduled attempt skips and emits a structured `scheduled_export_skipped` event. One SQLite transaction prevents concurrent owner and Cron starts from creating separate active exports.

1. One SQLite transaction captures the vault `epoch`, `head_seq`, and every current live file's exact `(path, rev, hash, size)`. It writes the manifest size, source authority, file rows, and revision pins.
2. If retention removed a current text revision before capture, the transaction copies that current payload into bounded source chunks. Retained text revisions remain the source when present. Blob sources use the exact current content hash and size.
3. The manifest contains the epoch, head sequence, timestamp, and paths in SQLite binary order. It omits deleted paths, retained history, OAuth grants, and service secrets. The archive contains `manifest.json` and each current payload at `files/<path>`.
4. Text reads use a bounded range from the retained revision or frozen source chunks. Blob reads use the captured content hash and a bounded R2 range. Metadata queries select content presence and size, not full revision payloads.
5. Retention keeps every existing pinned revision until export completion or typed failure. A retry with the same epoch and timestamp returns the existing operation.

### 11.2 Bounded ZIP32 and R2 output

- The encoder writes store-only ZIP32 entries. It rejects unsafe paths and calculates exact local headers, data descriptors, central-directory entries, and end records before R2 output starts.
- The complete encoded archive must fit the 2 GB product envelope and ZIP32 fields. It contains at most 10,000 current files plus the manifest entry.
- One alarm step emits at most 1 MiB of archive bytes, reads at most 1 MiB of file bytes, and starts at most 16 source ranges. Each file range is at most 64 KiB.
- Archive R2 writes use `BACKUP_BUCKET` and fixed 5 MiB multipart parts. The final part can be smaller. SQLite stores the upload id, ZIP cursor, CRC state, byte offsets, accepted part receipts, and bounded remainder after each step.
- Manifest, pending-part, and frozen-text bytes use chunk rows with at most 1,000,000 payload bytes. The complete estimated row stays below the 2,000,000-byte SQLite row limit. Snapshot inserts use at most 100 SQL parameters per statement.
- Each cursor update compares the exact observed cursor. An interrupted part can be sent again at the same part number from the same immutable source bytes. Only the final R2 object can become a completed snapshot.

### 11.3 Owner operations and failures

- `GET /owner/exports` lists completed snapshot timestamps and byte sizes, plus failed timestamps and safe failure kinds. `POST /owner/exports` starts an export through an Access-protected, same-origin, one-use CSRF form.
- `GET /owner/exports/{epoch}/{created_at}/download` streams only a completed R2 object whose stored size matches SQLite. Incomplete and failed exports have no download link. A missing archive returns a no-store 404 that directs the owner to `/owner/exports` to create a new export.
- A missing pinned source or an exact archive limit failure records a typed failure, aborts a known incomplete multipart upload, and releases pins after source reads settle.
- R2 storage faults leave the durable cursor active. The next alarm retries the same output step. A lost multipart-completion response is checked against the exact R2 key and size before SQLite marks completion.
- Local tests validate byte, range, and output bounds. Production CPU duration and account-tier measurements remain evidence limits. They do not change the local step ceilings.

### 11.4 Restore a new local vault

The owner follows [Restore a packed baseline into a new local vault](packed-export-restore.md). This procedure verifies each path, byte size, and SHA-256 hash before copying files into a new empty local vault outside iCloud Drive. It does not import a server vault, reset an epoch, restore deleted paths, or restore revision history. A separate service-side import remains out of scope.

### 11.5 Entry condition for F4 (R6)

iCloud Drive remains the owner of the live vault through F4 and F5. Before the plugin touches the real vault, the owner keeps one dated copy of the vault outside iCloud, for example a zip in local storage. Hourly packed service snapshots provide an extra recovery copy.

The service holds one vault per host name (`idFromName(host)`), shared by every enrolled device and every test vault. While the real vault is enrolled, a test vault that publishes a file puts that file into the real vault on the next feed. During F4 and later phases, test vaults enrolled in the deployed service must not create, change, rename or delete service files. Live proofs that write need a second service vault or the end of the trial (observed 2026-11-05).

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
| Packed baseline | 2 GB exact encoded archive, 10,000 current files, 1 MiB output and source-byte step, 16 source ranges per alarm | Owner-started or scheduled hourly. Archives use `vaultwire-backups`; infra removes `backups/` objects after 15 days. R2 multipart faults resume from the stored cursor. Terminal limit or source faults block download. |

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

The measurements page and its JSON also report the responding Worker isolate. Fields are active logical read slots, held REST and MCP leases, reserved REST read and shared bytes, and the expired count. They also include the reclaim grace, the reclaimed unsettled count for REST and MCP leases, and the route and age of the oldest held REST lease. Route labels name the REST route family; MCP leases use the `mcp` label. A held lease has not completed and has not been reclaimed. It can be past its hold deadline. These isolate fields are optional and additive in the protocol. They reset on isolate restart and do not describe other isolates.

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
| AC-07 | Restore a packed baseline into a new local vault | The owner verifies manifest paths, sizes, and SHA-256 hashes, then copies current files into an empty local vault. Deleted paths and revision history are not in the archive. |
| AC-08 | Owner revokes a client | Next request to the DO fails `401 revoked` within one request, independent of KV propagation; device shows `revoked`, keeps files |
| AC-09 | Full ChatGPT loop | Read a note; create a note; it appears in Obsidian without manual review; edit in Obsidian; ChatGPT reads the change; concurrent offline edit yields a conflict copy; an interrupted append retried with a key produces one entry |
| AC-10 | User saves a new edit between hash check and write during apply | `process` callback sees different bytes; nothing written; the user's edit is published; no loss |
| AC-11 | Local and remote identical bytes, different from base | Base updated; no write; no conflict |
| AC-12 | Device offline 40 days returns | `cursor_expired` → full reconciliation; remote deletes applied via tombstones; dirty paths become conflict copies; no path treated as a new create |
| AC-13 | Service-vault restore bumped the epoch | Every client re-hydrates. Clean files remain untouched. No duplicates occur. *No production trigger exists in v1. A service-vault restore changes the epoch (§11). Controlled proof is recorded in OAB-8.8.* |
| AC-14 | Create `Notes/café.md` when `notes/CAFÉ.md` exists; then rename `notes/CAFÉ.md` → `notes/Café.md` | Create returns `409 path_collision` with the existing path; the case-only rename of the same file succeeds |
| AC-15 | Search examples of §10 | Each returns the expected note with a snippet; two-character query rejected; `AND` matches literally |
| AC-16 | A 1.5 MB Markdown file | Synced as blob with exact bytes; listed `large: true`; readable by range; absent from search; shown in panel |
| AC-17 | Idempotency edge cases | Same key, different payload → `422`; key 26 days old → `409 operation_expired`; key 10 minutes in the future → rejected; key 4 minutes in the future → accepted |
| AC-18 | Pending rename X→Y meets remote edit on X | Rename dropped; X has remote bytes; local Y with old bytes trashed, or kept if it was edited |
| AC-19 | Coexistence mode: file removed by iCloud eviction | No delete published; owner sees a confirmation item; placeholder excluded |
| AC-20 | Enrollment of a second device whose vault already has content | Equal files clean; local-only uploaded; remote-only downloaded; differing files keep both via conflict copy; nothing overwritten |
| AC-21 | Hydration while another client writes | Manifest rows with `seq > head_seq` applied; feed revisits them as no-ops; a pruned pinned revision falls back to current |
| AC-22 | Append on a tombstoned note; append that would exceed 1 MB | `409 tombstone`; `413 text_too_large`; no partial write |
| AC-23 | R2 rejects a multipart part or loses its completion reply | The export remains active at its exact cursor. The next alarm retries the same part or verifies the completed R2 key and size. No incomplete object is downloadable. |
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
| AC-35 | Requests during a service-side restore | *Not applicable: this feature restores local files only.* The packed export does not create or activate a service vault. |
| AC-36 | Export in progress while a pinned revision reaches 30 days or capacity pressure triggers pruning | The exact pinned revision survives until the export completes or records a typed terminal failure. |
| AC-37 | Export against R2 when a multipart call fails | The export keeps its durable cursor and the existing Vault alarm schedules a retry. The test checks the retry at the same part number. |
| AC-38 | Two clients send the same idempotency key | Two independent receipts; no `422` |
| AC-39 | Crash after writing a conflict copy but before `copied`; user edits the copy; restart | The edited copy is never overwritten; item goes to *attention*; original path untouched |
| AC-40 | Feed replays a rename whose `from_rev` is lower than the live `base[from].rev` | Source side ignored; nothing trashed |
| AC-41 | After a service-vault restore the new epoch has `rev 3` where a device held `base.rev 8` | *Not applicable in v1. No service-vault restore exists (§11).* Hash comparison wins. The client rewrites its base. A locally changed file becomes a conflict copy |
| AC-42 | Service-vault restore succeeds, response lost, another client deletes again, retry | *Not applicable in v1. No service-vault restore exists (§11).* `412` on `If-Match` keeps the note deleted |
| AC-43 | Vault at 10,000 files or 2 GB | Next content mutation `507`; reads and deletes continue; panel shows the limit |
| AC-44 | The same backup is restored twice; a device with a pending edit against the first restored vault switches to the second | *Not applicable in v1. No service-vault restore exists (§11).* The two vaults have different epochs. The pending `If-Match` fails with `epoch_mismatch`. The device re-hydrates by hash. Its edit becomes a conflict copy. No silent overwrite occurs |

## 14. Delivery phases

No disposable demos; every phase ships the same code.

F1 is a server-only gate. Local protocol, real Durable Object, and Worker HTTP tests establish only the tested Worker behavior. Independent task review, human branch review, and actual remote CI must also pass before F1 exit. This evidence does not qualify plugin sync, conflict copies, offline recovery, MCP/OAuth transport, deployed authentication, or device effects. Keep those obligations in their later phase gates. Keep OAB-6.8.2 Deferred.

| Phase | Deliverable | Entry | Exit |
| --- | --- | --- | --- |
| F0 | New repo: Bun monorepo (`apps/worker`, `apps/plugin`, `packages/protocol` with Zod schemas shared by Worker, plugin and tests), `AGENTS.md`, Backlog.md initialized with tasks and deferred items, CI (Biome, typecheck, Vitest) | Spec approved | `bun run check` green on first commit |
| F1 | Worker: DO schema, all `/v1` endpoints, authorize/commit tickets, idempotency, search, limits, revocation table; tests with real DO | F0 | Server portions of AC-01, 03–06, 11, 12, 14, 15, 16, 17, 18, 21, 22, 25, 26, 27, 28, 29, 34, 38, 40, and 43, plus independent task review, human branch review, and actual remote CI |
| F2 | OAuth (provider + Access), MCP server and tools, owner console (clients, revoke) | F1 | MCP Inspector, Claude Code and ChatGPT web connect; read and write work; AC-08. Owner verifies Developer mode and iPhone availability in their ChatGPT account; result recorded, owner decides on mobile client strategy |
| F3 | Plugin Desktop: enrollment, hydration, feed, publish, Option B, status panel, Sync now | F2 | Two test vaults on the Mac pass AC-02, 03, 04, 05, 06, 09, 10, 13, 20, 24, 30, 31, 32, 33, 39; AC-09 run against real ChatGPT |
| F3b | Removed: plugin-side backup history or recurring export schedule | — | — |
| F4 | Real vault on the Mac in coexistence mode, plugin only on the Mac | F3 + one dated local copy of the real vault (§11.5) | Two weeks max; AC-19; polling and storage measured; no *attention* item unexplained |
| F5 | Mobile: plugin installed via BRAT on iPhone and iPad against a **copy** of the vault, then the real one | F4 | AC-03/04/05 across three devices; `secretStorage` behavior recorded per platform; offline edit on iPhone resolves correctly |
| F6 | Cutover: new local vaults outside iCloud on each device hydrated from the service; iCloud no longer owns the live vault; coexistence mode off | F5 + owner review of the packed baseline console and restore procedure (§11) | Single sync owner per device |

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

Bun workspaces; Hono; `@cloudflare/workers-oauth-provider`; `@modelcontextprotocol/server`; Zod; Biome; Vitest with `@cloudflare/vitest-pool-workers`; Wrangler; esbuild for the plugin; BRAT for beta installs; Release Please for plugin and Worker releases.

## 16. Deferred (tracked in Backlog.md, label `deferred`)

Hourly current-file backups use the `vaultwire-backups` R2 bucket. The infra lifecycle rule retains `backups/` objects for 15 days and aborts incomplete multipart uploads after seven days. Worker code does not prune this bucket.

| Item | Why not now | Trigger to reopen | Seam preserved in v1 |
| --- | --- | --- | --- |
| Blob garbage collection | Initially deferred because orphan detection could race new references during Durable Object I/O | Owner activation through OAB-13; no 1 GB threshold gates the owner action | Implemented in OAB-13. Inventory R2 `blobs/`, then check live files, retained revisions, and active packed-export sources. Transactionally mark candidates, reject stale or marked publication evidence, delete exact marked keys, and clear marks only after R2 confirms deletion. An unresolved post-restart outcome stays fenced and appears as `unknown`. An owner retry cannot clear it. Recover only with settlement or fencing evidence (OAB-41). Never list or delete `backups/`. See [Blob garbage collection API](api/blob-gc.md). |
| WebSocket push from DO | 15–60 s polling is enough for one owner | Measured latency complaint or request cost > 50% of allowance | Feed is `seq`-based; push only says "new seq", pull unchanged |
| Embeddings / semantic search | FTS covers the current vault | Agents miss notes by synonym in real use | `search_notes` returns `rev` and snippets; a second backend plugs behind it |
| `.obsidian/` settings categories | Triggered 2026-11-06 because manual re-configuration became a daily cost | Device proof: device available and BRAT release plugin-v0.1.0 published. Current code target: 0.1.4, with no release authorization. | Implemented in §7.1. Consent and hydration duties stay device-local. The master switch defaults off. Guarded writes retain the documented unobserved-version race. Device proof remains open. |
| Historical backup history | Packed baselines contain current files only | Owner requires retained revisions or service-side historical restore | Hourly current-file archives use `vaultwire-backups` for 15 days. Incomplete multipart uploads expire after seven days. Service-side import and historical export remain unbuilt. |
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
