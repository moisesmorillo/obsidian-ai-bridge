# Synthetic local sync API lab

M8 delivery 1 provides a separate loopback Worker/API over the existing private
SyncStore; delivery 2 adds a durable exact-base client; delivery 3 composes it
only into the separate synthetic experimental plugin. Neither is the
deployed API or a plugin sync release, nor qualification of Workers Free, real R2,
desktop/mobile hosts or real data. G1–G6 remain open. The experimental plugin and
two-vault artifact demonstration are delivery 3.

## Start only the isolated lab

1. Generate three new disposable credentials in a **new outside-repository file**:

   ```bash
   mise run credentials -- create --registry /tmp/m8-demo-registry.json --name vault-a --permissions read,write
   mise run credentials -- create --registry /tmp/m8-demo-registry.json --name vault-b --permissions read,write
   mise run credentials -- create --registry /tmp/m8-demo-registry.json --name rest-demo --permissions read,write
   ```

   Keep each once-displayed raw token in its approved client secret store. Do not
   reuse a production registry, grant, token or vault identity. No delete permission
   is needed. This command is offline; do not provision Cloudflare secrets.

2. Generate a fresh server-side lab vault UUID and three separate origin UUIDs
   locally with `crypto.randomUUID()`. The origins are provenance, not credentials.
   In the ignored `mise.local.toml`, set **only the separate demo keys**:

   ```toml
   [env]
   DEMO_CONFIGURATION = '''{"mode":"synthetic-local-only","vaultId":"<new-vault-uuid>","paths":["demo.md"],"participants":[{"clientId":"<vault-a-client-uuid>","origin":"<vault-a-origin-uuid>"},{"clientId":"<vault-b-client-uuid>","origin":"<vault-b-origin-uuid>"},{"clientId":"<rest-client-uuid>","origin":"<rest-origin-uuid>"}]}'''
   DEMO_CREDENTIAL_REGISTRY = '''<exact digest-only JSON from the new registry file>'''
   ```

   Placeholders intentionally fail validation. Replace them with generated UUIDs
   and the new digest registry; never insert raw tokens into these fields. Admit
   only synthetic ASCII Markdown paths (at most three, excluding preservation
   namespaces and case aliases). Each note is limited to 16 KiB UTF-8. Even verified
   M7 current/version records above that smaller scope are refused, never exposed as
   an admitted note or replaced with empty success.

3. Validate/build and start only the new configuration:

   ```bash
   mise run demo:build
   mise run demo:dev
   ```

   The task forces `--local`, `127.0.0.1:8789`, a distinct `DEMO_BUCKET`, no routes,
   and no remote R2 binding. State persists only under the ignored
   `.pi/tasks/m8-local-demo-state`, separate from normal Wrangler development state.
   It does not use `mise run dev` or the deployed Worker's
   configuration. Missing arming/registry fails closed. Local schema-derived
   OpenAPI/Scalar are at `/openapi.json` and `/docs`; neither grants note access.

No existing vault is scanned or installed into by this delivery. Do not install
or activate the release plugin against this endpoint.

## REST operation contract

All data operations use `POST http://127.0.0.1:8789/demo/v1/request` with a separately
configured registry bearer and `Content-Type: application/json`. CORS allows only
`app://obsidian.md`; this is not authentication. Every response is `no-store`.
The exact generated wire contract is the local OpenAPI document.

| Request | Permission | Outcome |
| --- | --- | --- |
| `{"operation":"current","path":"demo.md"}` | read | Exact live/tombstone metadata, verified never-seen, or typed failure |
| `{"operation":"version","revision":"<revision-uuid>"}` | read | Verified immutable version with exact Markdown bytes, absent or typed failure |
| `{"operation":"changes","cursor":"<opaque-vault-bound-cursor>"}` | read | At most 100 closed changed/aborted metadata events and an opaque continuation, or typed failure |
| `{"operation":"mutate","mutation":{...}}` | write | Exact committed revision/feed position, or typed pending/unknown/refusal |

A create command is:

```json
{
  "operation": "mutate",
  "mutation": {
    "kind": "create",
    "path": "demo.md",
    "parent": { "kind": "never_seen" },
    "operationId": "<new-operation-uuid>",
    "revision": "<new-revision-uuid>",
    "content": "# Synthetic demo\n"
  }
}
```

An update uses `kind: "update"` and
`parent: {"kind":"revision","revision":"<exact-observed-head-uuid>"}`. Keep a
fresh operation/revision identity for that new change. Vault, origin, digest and
media type are server-bound, never accepted from the caller. A stale parent is
refused; do not replace it with the latest head and retry an overwrite.

The first admitted mutation creates/read-back-verifies only the fresh configured
vault marker; reads never create it. Before that, the existing marker-gated store
returns `storage_unavailable`, not an empty successful vault. A divergent existing
marker is refused without repair. There is no legacy namespace read-through.

### Pending is not success

HTTP `200` carries a typed store outcome, including non-success. **Only
`kind: "committed"` acknowledges a mutation.** Persist the original request and
any `retryAfterEpochMs`; resubmit only that identical full command after its floor.
This resumes the existing exact journal without a bare operation-ID capability
that could resume another participant's operation. A changed request/origin gets
`operation_id_reused`; missing original bytes requires attention, not a new ID or
refreshed parent. There is no Worker sleep/retry loop.

Transport rejection uses `400` for invalid JSON/UTF-8/schema/media type (including
JSON strings with lone surrogates that UTF-8 encoding would silently replace), `401` for
failed registry authentication, `403` for missing independent permission or an
unbound participant, `413` above 102,400 encoded request bytes, and `503` for an
unarmed/non-loopback/unavailable lab. The stream ceiling ignores Content-Length
claims. Exceptions are sanitized; note text and credentials are not logged.

Feed cursors reuse the protocol-major-one checkpoint codec. The durable client
starts at the zero vector for this fresh lab identity and treats events as hints
for verified current reads; historical events never regress a newer ACK. No
inventory, tombstone application, deletion, rename, migration or MCP endpoint is
exposed by the lab.

## Exercise the uncomposed durable client

```bash
mise run test -- sync-demo-client sync-demo-ledger sync-demo-fetch
```

The integration scenario composes `SyncDemoClient`, strict `SyncDemoLedgerRepository`
and `SyncDemoFetchRemote` with the actual local Worker entrypoint/service/R2 adapter.
Two simulated local hosts exchange exact Markdown A→B and B→A, restart by loading
separate disposable on-disk ledgers, apply an independently authenticated REST edit,
and preserve a concurrent local edit plus verified excluded remote copy. Every pass
asserts at most 32 HTTP requests. The storage clock/conditional bucket and local
atomic host are deterministic doubles, not native R2 or desktop Vault evidence.
Additional actual-HTTP cases deny wrong intended vault/participant and credential
rotation after an earlier request, with zero storage objects created.
Temp ledger directories are created and removed only by that test; no existing
vault or persisted emulator state is read or changed.

| Durable state | Behavior |
| --- | --- |
| ACK | Exact revision/hash, no note body; unrelated equal text cannot be silently adopted |
| Push | Original operation/revision/parent/hash/floor/certainty; explicit pre-journal refusal requires unchanged saved bytes; uncertain journal replay may use a fully matching immutable tuple; only committed acknowledges |
| Prepared local effect | Persist before create/atomic compare-and-replace; interruption settles only its exact saved postcondition, otherwise attention without redispatch |
| Conflict | Keep local/base, create-only and verify competing remote bytes under excluded `ai-bridge-conflicts`, retain visible attention; never republish copies |
| Checkpoint | Start at zero; historical events select fresh current/version reconciliation; advance only after every selected path settles, never past pending/conflict |
| Invalid/unavailable storage | Bound encoded state to 16 KiB before parsing; reject unsupported/corrupt/foreign state unchanged; failed save/read-back fences the owner, never resets to empty |

The Fetch adapter admits only exact loopback HTTP base URLs, reads the bearer at
dispatch, sends the paired expected vault/authenticated-origin headers described
in [API contracts](api.md), forbids redirects, bounds UTF-8 JSON response streams
and applies one scheduled 10-second deadline including secret retrieval and body
consumption (not a preemptive whole-command latency guarantee). Only the strict
HTTP 400 binding refusal becomes invalid-input attention; error-status bodies
can never acknowledge a mutation. An unsettled
late request retains its permit; timeout is not rollback. Pending work may need
another explicit invocation after its original epoch retry floor; no busy loop.

Delivery 3 composes official Vault read/create/process/preservation,
whole-vault metadata preflight, listeners/session fencing and retained owner,
App-local string persistence, native SecretStorage, explicit disposable-lab arming,
a separate experimental artifact and Sync now/status. Follow the
[disposable installation and five-flow artifact demonstration](qualification/m8-experimental-plugin-demo.md).
These adapters are not attached to release `main.ts` or M3. Conflict resolution/deletes/renames/MCP remain out of
scope. Divergent prepared effects or expired cursors require review of the
disposable experiment, not silent reset or repair. See the
[implementation/evidence ledger](plans/m8-durable-sync-client.md).

## Evidence and teardown boundary

Fast tests compose the real application/transport and conditional adapter with
isolated deterministic storage. The native fixture imports the **actual demo
entrypoint** inside pinned workerd and uses local R2; its server clock is injected
by the test wrapper, not the production entrypoint. Synthetic legacy sentinel
setup/audit calls are excluded from the counted application binding calls. Neither
clock injection nor counted calls qualifies real time, CPU, memory or Workers Free.

The native scenario exercises create, exact replay, immutable bytes, conditional
update, stale-parent refusal and committed feed visibility while preserving the
legacy sentinel. It is a REST/store integration scenario, **not** the two-vault
plugin demonstration and not MCP evidence.

Stop the lab process. Remove only its disposable credentials/configuration and
isolated local emulator state after confirming the exact lab path. Do not remove
shared Wrangler state indiscriminately or target existing vault/bucket data. The
experimental entrypoint/configuration and the production Worker/plugin remain
separate; no release or deployment command is authorized by these instructions.
