# Worker API

The Worker exposes an experimental authenticated personal-mirror API. Public routes are `GET /health`, `GET /openapi.json`, and `GET /docs`. `/api/v1`, `/api/v2`, and every descendant (including unknown routes) require:

```http
Authorization: Bearer <token>
```

Missing, malformed, or incorrect credentials return `401 unauthorized` with `WWW-Authenticate: Bearer`. One bearer remains privileged for the namespace; mirror association/writer IDs are cooperating-writer guards, not separate authentication or authorization scopes. API content, JSON, and errors use `Cache-Control: no-store`.

The `:path` segment is canonical unpadded base64url of a validated literal lowercase-`.md` NotePath. For example, `Homelab/DNS/Technitium.md` is `SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA`. Paths are not URI-decoded or repaired. Traversal, absolute paths, backslashes, empty/dot segments, invalid UTF-8 identifiers, and noncanonical encodings are rejected.

## V2 mirror API

The public v2 routes are:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v2/mirror` | Protocol limits and configured association/designated writer IDs |
| GET | `/api/v2/notes?cursor=...` | One bounded page of visible legacy/live paths |
| GET | `/api/v2/notes/:path` | Raw legacy/live Markdown; absent/tombstone is 404 |
| GET | `/api/v2/notes/:path/state` | Metadata-only absent/legacy/live/tombstone state |
| PUT | `/api/v2/notes/:path` | Conditional create, live update, or tombstone recreation |
| DELETE | `/api/v2/notes/:path` | Recovery-first conditional tombstone, never physical DELETE |
| GET | `/api/v2/recovery?cursor=...` | One metadata-only recovery page |
| GET | `/api/v2/recovery/:id` | Recovery metadata only |
| GET | `/api/v2/recovery/:id/content` | Prepared/unexpired-sealed recovery text |
| POST | `/api/v2/recovery/:id/seal` | Explicit conditional sealing repair |
| POST | `/api/v2/recovery/:id/purge` | Explicit conditional expired-content purge to a marker |

All GET routes are read-only. List calls inspect at most 50 R2 objects and return an opaque `nextCursor` or `null`; accepted cursors are nonempty and at most 4096 characters. Clients must not supply a storage prefix. Empty visible pages may still have continuation. Recovery pages never include note plaintext or private R2 validators/metadata.

### Formats and application validators

Untagged pre-M3 objects remain `legacy` raw Markdown. Tagged format-2 live envelopes are decoded before response; tombstones are hidden from ordinary content/list reads. Malformed, unsupported, invalid-UTF-8, or oversized tagged objects produce sanitized `500 internal_error`, never raw bytes or false absence.

Recognized live/tombstone current generations and all recovery generations use the strong application ETag:

```text
"m3-<canonical-lowercase-uuid-v4-revision>"
```

It is not an R2 ETag, upload version, or content checksum. Successful mutations return the exact generation supplied by the conditional storage result, even if a later generation wins before response delivery. Note content responses expose `Bridge-Note-Format: legacy` or `Bridge-Note-Format: 2`; revisioned content also exposes `ETag`. State/recovery metadata responses expose ETag when revisioned and never contain note content.

### Mutation identity and conditions

Every v2 mutation requires canonical lowercase UUID-v4 headers:

```http
Bridge-Association-Id: <configured association>
Bridge-Writer-Id: <configured writer>
Bridge-Operation-Id: <one exact mutation identity>
```

Malformed/missing request IDs return `400 invalid_request`. A valid ID that does not match static Worker configuration, or unavailable/invalid configuration, returns `403 forbidden_writer` before storage mutation. Authentication runs before this check. Configure non-secret `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID` deliberately; the committed Wrangler values are local-development examples and do not prove a deployed association.

Conditions are strict:

- First create: exactly `If-None-Match: *`, with no `If-Match` or date condition; success is `201`.
- Update/recreate/tombstone/seal/purge: exactly one strong `If-Match: "m3-<uuid-v4>"`; success is `200`.
- No condition is `428 precondition_required`.
- Weak/list/wildcard-update/date/both condition forms are `400 invalid_request`.
- A stale generation or wrong recognized target state is `412 precondition_failed`.
- Unknown/not-dispatched storage effects are sanitized `500`, never reported as `412`.

A matching-revision update, recreation or tombstone additionally requires the
existing live/tombstone receipt to belong to the request association. A mismatch is
`412 precondition_failed` before any current or recovery write. This continuity
check does not make an arbitrary populated bucket safe for another association.
The accepted reset remains a separately provisioned isolated empty bucket/namespace,
new association and new credentials; never repoint a reset association at old keys.

PUT derives update versus recreation from the recognized live/tombstone action contract, then delegates the exact transition to application policy. It requires an explicit `text/markdown` or `text/plain` media type, case-insensitively with parameters. The body is streamed and strictly decoded as UTF-8 up to 1 MiB independently of `Content-Length`; explicit supported content type with no stream or zero bytes means valid empty text. Unsupported/missing content type is 415, malformed UTF-8 is 400, and oversize is 413. DELETE, seal, and purge accept only an empty body.

DELETE first creates/proves recovery content, then CAS-replaces the exact live head with a permanent tombstone, then independently attempts sealing. Its JSON response includes the exact tombstone acknowledgement, metadata for the prepared recovery generation, and the independent sealing certainty/generation. A sealing failure never rolls back a confirmed tombstone.

### Recovery semantics

Prepared recovery remains recoverable without an expiry and cannot be purged. Sealing proves the still-current matching tombstone and sets `recoverUntil` from that tombstone generation's stored upload time plus 30 days. Sealed content is readable before that instant. At/after expiry, or after purge, the distinct content endpoint returns `410 recovery_unavailable`; metadata remains available. Purge accepts only an exact sealed expired generation and CAS-replaces it with a content-free retained marker. It never calls R2 DELETE.

Seal proof unavailable and unsealed/unexpired purge are `409 conflict`. Missing recovery IDs are 404. Stale maintenance predicates are 412. Exact already-sealed/already-purged operation replays are read-only idempotent 200 responses; different operation/predicate replays are refused.

### V2 CORS

Registered v2 routes support narrow credential-free CORS. Responses use `Access-Control-Allow-Origin: *`, expose `ETag, Bridge-Note-Format`, and never enable credential cookies. Registered OPTIONS preflight is handled without service/storage resolution and validates the route's actual method set plus these request headers:

`Authorization`, `Content-Type`, `If-Match`, `If-None-Match`, `Bridge-Operation-Id`, `Bridge-Association-Id`, `Bridge-Writer-Id`.

State/recovery item routes advertise GET only, maintenance routes POST only, and the note item route GET/PUT/DELETE. Unknown v2 OPTIONS requests remain bearer-protected. Errors for declared v2 route/method combinations carry the same CORS response headers. Unknown routes, noncanonical static-segment aliases, and undeclared methods (including HEAD) do not.

## Retained v1 compatibility

`GET /api/v1/notes` retains the sorted `{ "notes": [...] }` compatibility response while decoding format-2 objects, listing legacy/live paths, and hiding tombstones. It aggregates at most 1,000 pages of 50 scanned objects (50,000 scanned objects); continuation beyond that ceiling fails with sanitized `500 internal_error` rather than claiming a complete inventory. `GET /api/v1/notes/:path` returns raw legacy text or decoded live text and hides absent/tombstone as 404. Malformed/unsupported tagged objects fail with sanitized 500.

Authenticated `PUT /api/v1/notes/:path` and `DELETE /api/v1/notes/:path` now return `410 mutation_api_retired` without reading a request body or mutating storage. There is no old mutation fallback or alternate native DELETE route. Operators must stop/drain old writers before upgrading and must not roll old Worker code back over format-2 objects.

## Errors and generated contract

Errors use a stable sanitized JSON envelope:

```json
{"error":{"code":"precondition_failed","message":"The supplied application generation is stale or targets the wrong state."}}
```

The implemented codes cover `unauthorized`, `forbidden_writer`, `invalid_path`, `invalid_request`, `unsupported_media_type`, `invalid_body`, `payload_too_large`, `not_found`, `conflict`, `mutation_api_retired`, `recovery_unavailable`, `precondition_failed`, `precondition_required`, and `internal_error`. No response contains credentials, raw exceptions, storage keys, R2 validators, or storage envelope bytes.

`GET /openapi.json` is generated as OpenAPI 3.1 and describes v1 retirement plus the actual v2 security, headers, optional empty PUT body, media types, pagination, current/recovery schemas, distinct metadata/content routes, and relevant statuses. `GET /docs` serves Scalar. These public documentation routes do not grant note access.

This implementation is local/development evidence, not proof of a deployment, bucket, production operation, or connected Obsidian client. The plugin is still local-only and makes no Worker calls; Slice 3 is the next internal M3 work.
