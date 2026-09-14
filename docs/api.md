# M1 API

The Worker protects `/api/v1` and its descendants, including unknown API routes.
`GET /health`, `GET /openapi.json` and `GET /docs` are outside that prefix and
public. Authenticated requests require:

```http
Authorization: Bearer <token>
```

The token is configured as the `OBSIDIAN_BRIDGE_TOKEN` Wrangler secret. Missing or
empty configuration fails closed. The bearer scheme is case-insensitive; missing,
malformed or incorrect credentials return 401 with `WWW-Authenticate: Bearer`.
One token grants all note operations; there are no per-client permissions.

The API accepts Markdown paths ending in lowercase `.md` and stores them in R2
under `vault/`. Paths are validated before storage; traversal, absolute/drive
paths, backslashes, null bytes, empty/dot segments, dangerous encoded characters
and malformed/noncanonical identifiers are rejected. A literal vault path is not
a URL to decode; clients should use core path validation and encoding rather than
invent a separate normalization policy.

The `:path` segment in note item routes is a canonical base64url encoding of the normalized UTF-8 note path, without padding. For example, `Homelab/DNS/Technitium.md` is addressed as `/api/v1/notes/SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA`. This keeps vault path separators and dot segments out of the URL path parsed by the Fetch runtime.

## Endpoints

The generated OpenAPI 3.1 document is available at `GET /openapi.json`. Interactive Scalar documentation is available at `GET /docs`.

### `GET /health`

Returns `200` with a liveness response (not an R2 connectivity or credential check):

```json
{"status":"ok"}
```

### `GET /api/v1/notes`

Returns `200` with `{"notes":["Folder/Note.md"]}`: a sorted, deduplicated list of
safe stored Markdown paths within the size limit. The internal `vault/` prefix is
not included. The adapter follows R2 cursors internally; this API returns the whole
list, with no public cursor or revision metadata.

### `GET /api/v1/notes/:path`

Returns `200` with `text/markdown; charset=utf-8`. A missing note returns `404`.
An oversized persisted R2 object is rejected before reading its text and maps to
a sanitized `500 internal_error`, not an incoming-payload `413`.

### `PUT /api/v1/notes/:path`

Accepts raw UTF-8 text with `Content-Type: text/markdown` or `text/plain`,
case-insensitively and including parameters. The maximum body size is 1 MiB
(1,048,576 bytes), not characters. Actual streamed bytes are bounded independently
of `Content-Length`; malformed UTF-8 is rejected. Exactly the limit is accepted.
Empty text is valid; runtime also accepts a missing body and a missing/empty
content type. Unsupported declared media types return 415.

Creation returns `201`; replacement returns `200`, with
`{"path":"Folder/Note.md","stored":true}`. These statuses reflect an existence
check before an **unconditional** put, not an atomic create or compare-and-swap.
There are no conditional requests, revisions or conflict responses. A concurrent
write can be overwritten; this endpoint is not a safe automatic sync primitive.

The generated OpenAPI PUT declaration currently requires a body and advertises
the two explicit media types; it does not express all runtime permissiveness or
path/byte constraints. Clients should send an explicit supported content type.
M3 must reconcile and test this contract gap before relying on generated clients;
this documentation handoff does not change runtime or generated OpenAPI behavior.

### `DELETE /api/v1/notes/:path`

Immediately deletes the remote object and returns `204`. Deleting an already
missing note also returns `204`. No tombstone, undo, local-vault deletion or sync
propagation exists. Do not infer a deletion instruction from absence in a list.

## Errors

API failures use this JSON shape:

```json
{
  "error": {
    "code": "invalid_path",
    "message": "The note path is invalid."
  }
}
```

| Status | Stable code |
| --- | --- |
| 400 | `invalid_path`, `invalid_body` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 500 | `internal_error` |

Unsupported methods on valid item identifiers currently return 404, not 405.
Malformed/hierarchical item paths return `400 invalid_path`. Unexpected failures
never expose storage errors, credentials or stack traces.

JSON API/health/error and Markdown content responses include
`Cache-Control: no-store`; this does not describe the public documentation pages
or the bodyless DELETE response. M1 responses do not use the protocol package's
reserved metadata envelope or include sync revisions.

## Accepted M3 API design — not implemented

The [M3 v2 contract](milestones/m3-remote-bridge-client-and-publishing.md#v2-contract-surface)
and accepted-design [ADR 0002](decisions/0002-conditional-remote-note-mutation.md)
specify a safe interface for automatic local→remote mirroring. Product decisions
are resolved, but these are **not endpoints or guarantees in current code**.

- Authenticated v2 association/designation description, paginated list, content
  read and separate current-state inspection (including tombstones/own receipts).
- Conditional create/update/recreation: If-None-Match:* or one strong If-Match of
  the acknowledged application revision. Fresh server revisions inside envelopes
  distinguish same-text generations. No get-then-unconditional-write or adoption.
- Conditional DELETE is a recovery-before-tombstone PUT, not physical object
  deletion. Normal note reads/listing hide tombstones. Separate recovery metadata/
  text endpoints, explicit conditional sealing repair and expiry purge implement
  the 30-day policy in
  [ADR 0004](decisions/0004-recoverable-mirror-deletions.md); small safety markers remain.
- V2 mutations require operation/association/writer IDs and the bearer. Static
  writer designation is an operating guard, not scoped auth; mirror eligibility
  likewise does not determine future REST/MCP permission.
- Upgraded Worker retires **both v1 PUT and DELETE** with authenticated 410. V1
  reads/listing decode live envelopes and omit tombstones; untagged legacy text
  remains readable, not automatically adopted or converted. No v1 mutation fallback
  when talking to an old server that ignores conditional headers.
- Slice 1 implements strict shared NotePath/receipt/revision/conditional/recovery DTO
  schemas and their public exports, but no route consumes them yet. Slice 2 must add
  explicit v2 PUT content types/optional zero-byte body, 412/428 outcomes, bounded
  streams, no-store and narrowly registered CORS together with generated OpenAPI.

Do not send content to an assumed v2 implementation, deploy, migrate, expire current
R2 keys or run old Worker code over new envelopes as part of this planning PR.

See [current state](current-state.md), [architecture](architecture.md) and the
[roadmap](roadmap.md) for evidence, safety boundaries and deferred capabilities.
