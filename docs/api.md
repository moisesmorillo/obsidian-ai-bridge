# M1 API

The Worker exposes the API under `/api/v1`. All API routes except `/health` require:

```http
Authorization: Bearer <token>
```

The token is configured as the `OBSIDIAN_BRIDGE_TOKEN` Wrangler secret. The API accepts Markdown paths ending in `.md` and stores them in R2 under `vault/`. Paths are validated before storage; traversal, absolute paths, backslashes, null bytes, malformed encoding, and dot segments are rejected.

The `:path` segment in note item routes is a canonical base64url encoding of the normalized UTF-8 note path, without padding. For example, `Homelab/DNS/Technitium.md` is addressed as `/api/v1/notes/SG9tZWxhYi9ETlMvVGVjaG5pdGl1bS5tZA`. This keeps vault path separators and dot segments out of the URL path parsed by the Fetch runtime.

## Endpoints

### `GET /health`

Returns `200` with:

```json
{"status":"ok"}
```

### `GET /api/v1/notes`

Returns `200` with a sorted list of stored Markdown paths. The internal `vault/` prefix is not included.

### `GET /api/v1/notes/:path`

Returns `200` with `text/markdown; charset=utf-8`. A missing note returns `404`.

### `PUT /api/v1/notes/:path`

Accepts a raw Markdown or plain-text body with `Content-Type: text/markdown` or `text/plain`, including parameters. The maximum body size is 1 MiB. Creation returns `201`; replacement returns `200`.

### `DELETE /api/v1/notes/:path`

Deletes the note and returns `204`. Deleting an already missing note also returns `204`.

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

Stable error codes are `unauthorized`, `invalid_path`, `unsupported_media_type`, `invalid_body`, `payload_too_large`, `not_found`, and `internal_error`.
