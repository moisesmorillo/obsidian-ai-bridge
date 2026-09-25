# Worker API

The Worker exposes an experimental authenticated personal-mirror API. M5's limited
software-support window is for release v1.0.2 on the exact profile in the [operator
guide](operations.md#current-m5-qualification-and-support); no production Worker/R2
service is claimed. Public routes are `GET /health`, `GET /openapi.json`, and
`GET /docs`. `/api` and every descendant (including retired v1 and unknown routes)
require:

```http
Authorization: Bearer <token>
```

Missing, malformed, incorrect, or invalidly configured credentials return the same sanitized `401 unauthorized` with `WWW-Authenticate: Bearer`. The active version-1 registry is the only authentication authority, accepts at most 16 named clients, and stores only canonical domain-separated SHA-256 digests. Successful authentication resolves a secret-free principal containing client ID, name, and the exact configured `read`/`write`/`delete` set. One exhaustive operation policy enforces the required independent permission before service/storage dispatch. An authenticated client without it receives sanitized `403`; the response does not expose the principal's permission set or registry metadata. Mirror association/writer IDs and application preconditions remain separate later guards. API content, JSON, and errors use `Cache-Control: no-store`; principals, tokens, and digests are not returned.

The `:path` segment is canonical unpadded base64url of a validated literal lowercase-`.md` NotePath. For example, `Homelab/DNS/Technitium.md` is `SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA`. Paths are not URI-decoded or repaired. Traversal, absolute paths, backslashes, empty/dot segments, invalid UTF-8 identifiers, and noncanonical encodings are rejected.

## V2 mirror API

The public v2 routes are:

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v2/mirror` | `read` | Protocol limits and configured association/designated writer IDs |
| GET | `/api/v2/notes?cursor=...` | `read` | One bounded page of visible legacy/live paths |
| GET | `/api/v2/notes/:path` | `read` | Raw legacy/live Markdown; absent/tombstone is 404 |
| GET | `/api/v2/notes/:path/state` | `read` | Metadata-only absent/legacy/live/tombstone state |
| PUT | `/api/v2/notes/:path` | `write` | Conditional create, live update, or tombstone recreation |
| DELETE | `/api/v2/notes/:path` | `delete` | Recovery-first conditional tombstone, never physical DELETE |
| GET | `/api/v2/recovery?cursor=...` | `read` | One metadata-only recovery page |
| GET | `/api/v2/recovery/:id` | `read` | Recovery metadata only |
| GET | `/api/v2/recovery/:id/content` | `read` | Prepared/unexpired-sealed recovery text |
| POST | `/api/v2/recovery/:id/seal` | `write` | Explicit conditional sealing repair |
| POST | `/api/v2/recovery/:id/purge` | `delete` | Explicit conditional expired-content purge to a marker |

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

## Retired v1 HTTP API

No `/api/v1` route or OpenAPI compatibility path is registered. A valid registry bearer receives the ordinary sanitized `404 not_found` for v1 paths; a missing or invalid bearer receives `401 unauthorized`. Both outcomes occur before mirror-service construction or storage access. There is no `410` compatibility handler or old mutation fallback.

Retirement changes only the HTTP surface. It does not rewrite or remove R2 objects. Untagged legacy Markdown remains governed by the established v2 read/adoption policy. Operators upgrading into this version must first provision and verify the full-writer registry credential, migrate the plugin's native SecretStorage bearer, stop/drain any old v1 client, and never roll old Worker code back over format-2 objects or revoked credentials.

## Errors and generated contract

Errors use a stable sanitized JSON envelope:

```json
{"error":{"code":"precondition_failed","message":"The supplied application generation is stale or targets the wrong state."}}
```

The implemented codes cover `unauthorized`, sanitized 403 `forbidden_writer` (used without permission-set detail for permission or designation refusal), `invalid_path`, `invalid_request`, `unsupported_media_type`, `invalid_body`, `payload_too_large`, `not_found`, `conflict`, `recovery_unavailable`, `precondition_failed`, `precondition_required`, and `internal_error`. The protocol schema retains historical `mutation_api_retired`, but no registered route emits it after v1 retirement. No response contains credentials, raw exceptions, storage keys, R2 validators, or storage envelope bytes.

`GET /openapi.json` is generated as OpenAPI 3.1 and describes only the actual v2 authenticated surface, required permissions, `401` versus `403`, headers, optional empty PUT body, media types, pagination, current/recovery schemas, distinct metadata/content routes, and relevant statuses. `GET /docs` serves Scalar. These public documentation routes do not grant note access.

The generated plugin now composes this v2 surface for the explicitly activated
designated writer. Artifact qualification proves a packaged saved-file event reaches a
real conditional v2 PUT with canonical addressing and required identity/operation
headers, with no v1 mutation fallback. This remains local host-double/development
evidence—not proof of a deployment, remote bucket, real Obsidian host, iCloud event
trace, or production operation. See the [operator guide](operations.md) for setup,
recovery seal/purge requests, handoff, rotation, and downgrade restrictions.
