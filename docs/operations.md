# M3 operator guide

M3 is an experimental one-way Obsidian-to-Worker mirror. It is not production
certified, a complete backup, or bidirectional synchronization. This guide describes
the implemented operating contract without authorizing deployment or installation in
a personal vault. Use a disposable vault and separately authorized development
resources for any manual qualification.

## Operating model and trust boundary

- iCloud remains the working-vault device sync. AI Bridge observes official Obsidian
  saved-file events; it does not receive a transactional iCloud log.
- Exactly one explicitly designated Obsidian device writes one mirror association.
  Other Obsidian devices may continue using iCloud, but their plugin instances remain
  passive for remote mutations unless the operator completes a safe handoff.
- Writer availability determines mirror freshness. There is no election, lease,
  automatic takeover, multi-writer coordination, or always-on iOS claim.
- `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID` are non-secret operational guards
  for cooperating clients. They are not authorization or cryptographic device
  identities. The bearer remains privileged for every operation in the namespace.
- Eligible Markdown is sent and stored as plaintext. The Obsidian host and other
  privileged plugins, plugin runtime, Worker, Cloudflare/R2 operator, and authorized
  bearer holders are inside the trusted plaintext boundary. Private R2 does not make
  the bearer least-privilege.
- Eligibility controls mirror scope, not remote-client permission. Only lowercase
  `.md` files that pass the literal path, dot/config-directory exclusion, and 1 MiB
  UTF-8 rules are included. Attachments, Obsidian configuration, arbitrary files, and
  note instructions are not mirrored or executed.

## Initial setup for a new empty association

The initial M3 association must use a separately authorized **empty** R2 bucket or
isolated namespace. Do not point a new association at old keys and do not infer that
committed development configuration means a remote resource exists.

1. **Provision the Worker/R2 prerequisite separately.** Bind `VAULT_BUCKET` to the
   intended empty bucket. Generate fresh canonical lowercase UUID-v4 values for
   `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID`. Configure a strong bearer through
   the Worker secret `OBSIDIAN_BRIDGE_TOKEN`; never commit it to `wrangler.jsonc`,
   `mise.local.toml.example`, plugin data, screenshots, or documentation. The values
   committed in `apps/worker/wrangler.jsonc` are non-secret local-development
   examples, not a deployed association.
2. **Build and qualify before any manual installation.** Run the canonical tasks in
   [plugin development](plugin-development.md). If manually testing, use Obsidian
   1.13.0+ and a disposable vault only. M3 has no real-host qualification yet.
3. **Obtain the plugin device UUID.** Enable AI Bridge, open its settings, and copy
   **Local device / writer ID**. This value is non-secret. Configure that exact value
   as the Worker's `MIRROR_WRITER_ID`; configure the independently generated
   association UUID as `MIRROR_ASSOCIATION_ID`.
4. **Create/select the bearer in native SecretStorage.** Use Obsidian's native secret
   management and select its reference under **Bearer secret reference**. `data.json`
   stores only the reference. Host-local mirror state and the handoff ledger must not
   contain the plaintext bearer either. Native SecretStorage is host-managed
   vault-local secret storage, not a documented OS-keychain guarantee.
5. **Configure the endpoint.** Enter an absolute origin with no userinfo, query,
   fragment, or non-root path. HTTPS is required. Plain HTTP is allowed only after
   explicit consent for the exact literal `localhost`, `127.0.0.1`, or `[::1]` origin
   including its port. There is no LAN, DNS-name, suffix, alternate numeric-address,
   or mobile-to-desktop loopback exception.
6. **Verify designation.** Use **Authenticated server identity** and confirm that the
   returned association matches the intended association and the designated writer
   equals the displayed local device UUID. A mismatch remains passive and fails
   mutation closed.
7. **Give whole-scope consent.** Read and accept the whole eligible Markdown,
   plaintext trust, and runtime-deletion disclosure. There is no per-note selection,
   per-folder allow-list, or per-delete confirmation.
8. **Activate only after exact alignment.** For a genuinely new empty association,
   enable **Enable whole eligible Markdown mirror** after designation verification.
   The plugin registers official Vault listeners before layout-ready bootstrap,
   enumerates positive eligible saved state, checks remote state, and uses create-only
   conditions for unassociated paths. Existing live, legacy, or tombstone collisions
   block rather than being adopted or overwritten. Startup or scan absence never
   creates deletion authority.
9. **Verify staged behavior.** Use metadata-only status and **Check mirror now**.
   Expect bounded bootstrap/catch-up and then observing status. Verify remote state
   with authenticated read-only v2 requests before relying on freshness. Do not treat
   one scan as proof that iCloud hydration is complete.

Enabling an unconfigured, disabled, or non-writer plugin does not send note content.
M2 inspection commands remain independent and do not grant upload consent.

## Saved-event and iCloud uncertainty

The plugin receives host events, not human-intent provenance or a globally ordered
transaction log. Once bootstrap has completed, an observed eligible delete event for
an already associated path—including an event caused by iCloud or another external
change—can authorize a recoverable remote tombstone after the five-second grace and
an exact local-absence check.

Changes made while the writer is offline, while the plugin is disabled, or during a
listener gap can later be rediscovered **positively** by a fresh scan. A missing path
during startup or such a gap does not authorize deletion. Consequently, an offline
local deletion may remain as a stale remote live head until a later reviewed M4 or
operator reconciliation flow exists. Ordering across devices is not globally
transactional, and the designated writer must run for mirror freshness. No desktop,
mobile, iCloud event trace, background iOS execution, or always-on behavior has been
qualified.

## Safe upgrade, disable, and re-enable

- Pause new admission and inspect status before an upgrade. Preserve every unresolved
  intent, blocker, deferred rename prerequisite, plugin preference, and host-local
  ledger. A requested abort does not roll back a Worker mutation.
- A compatible plugin replacement or re-enable in the same JavaScript/App realm
  reuses the versioned runtime owner. In-flight reservations and settlement are not
  reset merely because a Plugin instance, UI session, listener set, or bundle is
  replaced. An incompatible registry version fails closed instead of replacing the
  owner.
- A new process reconstructs from validated device-local state. Unresolved receipts,
  retry/evidence budgets, ACKs, deletion evidence, and rename prerequisites remain
  durable; no historic plaintext body queue exists.
- Every detached-listener gap receives conservative positive reconciliation. Missing
  entries in that scan never authorize delete. Unsupported runtime capabilities,
  state/configuration failures, and incompatible persisted versions fail closed.
- Disabling or uninstalling does not prove remote requests were cancelled, erase a
  shared native secret, revoke a bearer, or make persisted state safe to discard.

## Safe writer handoff

There is no automatic takeover and no iCloud-synchronized transactional ledger.
Perform this sequence exactly:

1. On the old writer, pause for handoff and drain accepted work.
2. Prove there is no unresolved mutation intent, blocked path, persistence failure,
   or deferred rename dependency. A timeout, client abort, quiet interval, or GET of
   the old revision is not proof of quiescence.
3. Export the validated content-free handoff metadata. It contains association,
   origin, per-path ACK/hash or tombstone identifiers, and an integrity checksum; it
   excludes note bodies, bearer, secret reference, activation, and device ID.
4. Disable the old writer. As a separately authorized server operation, change the
   Worker's designated writer ID to the new device. Rotate the bearer independently;
   designation does not revoke the old bearer.
5. On the new device, configure the endpoint and its own native SecretStorage
   reference, then explicitly import the same-association handoff metadata.
6. Run staged local and remote verification. Every transferred live entry must match
   the current saved local SHA-256 and exact remote revision; every transferred
   tombstone must be locally absent and remotely exact. Events arriving during this
   sample invalidate the evidence and require another complete batch.
7. Activate only after the serialized alignment transition succeeds. Keep the old
   device disabled.

If the old writer or ledger is lost, unresolved, or cannot be drained, do **not**
automatically take over the same association. Preserve the old bucket, credentials,
and local evidence for recovery. The safe reset is a separately authorized new empty
bucket/namespace, new association UUID, new credentials, and new designation with no
route for delayed old requests to reach it.

## Bearer rotation

Bearer rotation is independent from association and writer identity:

1. Pause and conservatively settle pending or unknown effects before replacing
   connection identity. Preserve unresolved evidence; do not clear the ledger.
2. Change/revoke the old `OBSIDIAN_BRIDGE_TOKEN` server-side using the authorized
   Worker secret mechanism.
3. Create or update the native SecretStorage entry and select only its reference in
   plugin settings. Never put plaintext in `data.json`, host-local state, handoff
   metadata, logs, notices, or committed configuration.
4. Reverify authenticated association/writer identity, then resume. Rotation does not
   redefine the association, and rotating `MIRROR_WRITER_ID` is not a substitute for
   revoking the old bearer.

## Deletion and recovery operations

### Implemented semantics

- Only persisted post-bootstrap runtime event evidence grants delete authority.
  Startup, inventory, scan, or listener-gap absence never does.
- The plugin waits five seconds and rechecks exact local absence.
- The Worker prepares a recovery snapshot before replacing the live head. The exact
  conditional tombstone PUT is the deletion linearization point.
- Recovery retention is 30 days from the stored tombstone generation's upload time.
  Sealing may occur after tombstoning. Seal failure does not undo the committed
  deletion: prepared/unsealed or orphan material may over-retain and remains
  ineligible for purge until the required proof exists.
- Recovery list, metadata, and content routes are distinct from normal note reads.
  Retrieval/export is not automatic local restore. M4 owns richer restoration and
  any remote-to-local write.
- Expiry affects recovery content, not the authoritative current tombstone/head.
  Purge is an explicit `If-Match` CAS that replaces an expired sealed recovery body
  with a content-free marker. It is not native R2 hard delete. Current tombstones and
  recovery markers remain, and M3 has no scheduled garbage collector.

### Read-only recovery inspection

Use a trusted HTTP client and supply the bearer without committing it or exposing it
in shell history. Placeholders below are descriptive; they are not credentials.
All GETs are read-only.

```http
GET <bridge-origin>/api/v2/recovery?cursor=<opaque-next-cursor>
Authorization: Bearer <privileged-bearer>
```

The response is one metadata-only page (at most 50 scanned objects) with
`nextCursor` or `null`. Continue even if a page has no visible entries but has a
cursor. Do not manufacture or decode cursors.

```http
GET <bridge-origin>/api/v2/recovery/<recovery-uuid>
Authorization: Bearer <privileged-bearer>
```

Inspect the closed metadata state and strong application `ETag`; this endpoint does
not return note text.

```http
GET <bridge-origin>/api/v2/recovery/<recovery-uuid>/content
Authorization: Bearer <privileged-bearer>
```

Prepared and unexpired sealed content returns Markdown. Expired or purged content
returns `410 recovery_unavailable`; unknown IDs return 404. Export deliberately to a
protected destination. The API does not write an Obsidian note.

### Seal repair

For a valid prepared/unsealed entry, use its exact current application ETag and fresh
canonical UUID-v4 operation identity:

```http
POST <bridge-origin>/api/v2/recovery/<recovery-uuid>/seal
Authorization: Bearer <privileged-bearer>
Bridge-Association-Id: <association-uuid>
Bridge-Writer-Id: <designated-writer-uuid>
Bridge-Operation-Id: <fresh-operation-uuid>
If-Match: "m3-<current-recovery-revision-uuid>"
Content-Length: 0
```

The Worker seals only when it can prove the still-current matching tombstone and its
stored upload time. Missing proof returns 409; stale predicates return 412. Exact
already-sealed operation replay is read-only idempotent and does not extend the
retention deadline.

### Conditional expiry purge

After `recoverUntil`, use the exact sealed recovery ETag and a fresh operation UUID:

```http
POST <bridge-origin>/api/v2/recovery/<recovery-uuid>/purge
Authorization: Bearer <privileged-bearer>
Bridge-Association-Id: <association-uuid>
Bridge-Writer-Id: <designated-writer-uuid>
Bridge-Operation-Id: <fresh-operation-uuid>
If-Match: "m3-<sealed-recovery-revision-uuid>"
Content-Length: 0
```

Unsealed or unexpired entries return 409; stale predicates return 412. Success writes
a new purged-marker generation. It does not remove the current tombstone, the recovery
key, or another generation. Do not configure blanket R2 lifecycle expiration for
current or recovery namespaces.

See [Worker API](api.md) for complete statuses, media types, CORS, and validator
rules.

## Rollback and downgrade restrictions

No rollback path is claimed safe unless it has been tested. Use these alternatives:

| Unsafe action | Why it is unsafe | Safe response |
| --- | --- | --- |
| Run old plugin code that does not understand the current device-state schema against an active M3 writer | It may ignore or corrupt ACKs, intents, deletion evidence, or fences. | Pause, preserve state/evidence, and upgrade forward to compatible code. |
| Downgrade to v1 PUT/DELETE behavior | Unconditional mutation bypasses format-2 revisions, tombstones, and recovery. | Keep v1 mutations retired; upgrade Worker/client forward. |
| Redirect delayed old-association requests into a reset association or reused bucket | Pending privileged requests could mutate the new namespace. | Use an isolated empty bucket/association/credentials and preserve old state. |
| Delete unresolved ledger/intents to make a writer look healthy | Unknown remote effects and original conditions become unprovable. | Pause, inspect exact receipts, drain/recover, or retain the blocker for handoff/M4. |
| Assume local-state rollback is always detectable | A valid stale snapshot can pass schema validation. | Pause and explicitly revalidate local hashes, remote revisions, designation, and pending effects. |
| Restore stale `data.json` or host-local state as authority | Synced preferences are not writer authority; stale ACKs can cause divergence. | Preserve the restore as evidence, reconfigure, and complete staged handoff/alignment or isolated reset. |
| Re-enable an old writer after handoff without server redesignation and credential handling | It can still hold valid local authority or a privileged bearer. | Keep it disabled; redesignate deliberately, rotate/revoke credentials as needed, and repeat the safe handoff gate. |
| Roll back Worker code over format-2 objects or restore a stale bucket snapshot into an active association | Old code can bypass current/recovery invariants or repeat obsolete generations. | Stop writers, preserve evidence, upgrade forward, or create an isolated association after review. |

Do not discard local state, old buckets, tombstones, markers, or credentials merely to
silence a stuck state. Preserve evidence first; use pause, forward upgrade, verified
handoff, explicit revalidation, or isolated reset.
