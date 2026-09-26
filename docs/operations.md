# M3/M4/M5 operator guide

M3 provides the Obsidian-to-Worker mirror. M4 adds explicit reviewed reconciliation;
it does not make the mirror automatically bidirectional. R2 is not a complete backup.
This guide describes the implemented operating contract and M5's limited software-
support envelope; it does not certify security or approve a production service or
Worker/R2 deployment. Manual qualification must use a disposable vault and separately
authorized development resources, never a personal vault.

## Current M5 qualification and support

The only M5-qualified release is **v1.0.2**, latest-only, for one active designated
writer on **Obsidian Desktop 1.13.7 / macOS 26.6.2 / Apple M4 Pro**, with up to
**10,000 eligible Markdown notes**. The declared host API minimum remains 1.13.0, but
that does not qualify other Obsidian/macOS versions. The bound reflects synthetic-vault
active-writer and current v5 migration/restart evidence; it is not a latency SLA,
complete-backup guarantee, or certification of a deployed service. See the [M5
qualification report](qualification/m5-final.md) for exact measurements and retained
prior evidence.

Mobile writers, Intel macOS, Windows/Linux, other desktop versions, iCloud event
ordering, background iOS, multiple active writers, and deployed Worker/R2 behavior
are not qualified. The manifest remains `isDesktopOnly: false` for loadability only;
it does not broaden the supported writer platform. The v1.0.2 GitHub release contains
no downloadable binary assets; the qualified plugin bundle is generated from the
version-aligned tagged source and must be built reproducibly. From the v1.0.2 tag, run
`mise install`, `mise run install`, `mise run plugin:build`, and `mise run plugin:smoke`,
then use only the generated `main.js` and `manifest.json` as described in [plugin
development](plugin-development.md). No earlier release or rollback line is supported,
and no backports are promised. Configuration is not proof of deployed resources or
credentials.

## Staged release deployment

`.github/workflows/deploy-worker.yml` checks out current `main` for a manual first
deployment, or an existing stable release tag for later automatic deployments.
Both paths require the current `main` commit; release events also require the tag
to match the package version. The workflow runs the canonical `mise run check`
(including the release identity gate) and deploys the
configured Worker using `cloudflare/wrangler-action@v4` with the repository's
pinned Wrangler version, without automatic resource provisioning. The deployment preserves
dashboard-set non-secret vars, including any later configured association/writer IDs;
it does not create or select those IDs. Publication of a release
starts this job only after the repository variable `WORKER_AUTO_DEPLOY` is set to
`true`. Until then, an operator can start it manually with `workflow_dispatch`
from the current `main`. Neither path runs during pull request validation.

The `production` GitHub environment must hold `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as environment secrets. Scope the API token to the intended
account and Worker deployment permissions. The configured R2 bucket must already
exist in that account. The current Worker still requires the separately provisioned
`OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY` Worker secret; GitHub's Cloudflare deployment
token is not a bridge client credential. Do not put either credential in source,
workflow inputs, or logs. The committed configuration omits both example mirror IDs,
so v2 mutations remain disabled until the real association and plugin-generated
writer ID are deliberately configured. A deploy job does not grant mirror activation
or personal-vault installation approval.

For the first manual deployment, leave `WORKER_AUTO_DEPLOY` unset, run the workflow
manually, then validate the exact Worker endpoint, authentication/authorization,
R2 binding and non-destructive behavior with synthetic data. Confirm the deployed
version and preserve the prior version for rollback. Only after this evidence and
the intended client-authentication design are accepted should the repository variable
be set to `true` for later releases. Worker version rollback changes code only; it
does not undo R2 writes, credential changes, or client-local state.

## Operating model and trust boundary

- iCloud remains the working-vault device sync. AI Bridge observes official Obsidian
  saved-file events; it does not receive a transactional iCloud log.
- Exactly one explicitly designated Obsidian device writes one mirror association.
  Other Obsidian devices may continue using iCloud, but their plugin instances remain
  passive for remote mutations unless the operator completes a safe handoff.
- Writer availability determines mirror freshness. There is no election, lease,
  automatic takeover, multi-writer coordination, or always-on iOS claim.
- `MIRROR_ASSOCIATION_ID` and `MIRROR_WRITER_ID` are non-secret operational guards
  for cooperating clients. They are not authentication, permissions, or cryptographic
  device identities. Authentication resolves a named principal from the bounded
  credential registry. Slice 4 enforces exact independent permissions before service/
  storage dispatch. Current writer credentials require `read`, `write`, and `delete`;
  `write` never implies `delete`.
- Eligible Markdown is sent and stored as plaintext. The Obsidian host and other
  privileged plugins, plugin runtime, Worker, Cloudflare/R2 operator, and authorized
  bearer holders are inside the trusted plaintext boundary. Private R2 does not make
  the bearer least-privilege.
- Eligibility controls mirror scope, not remote-client permission. Only lowercase
  `.md` files that pass the literal path, dot/config-directory exclusion, and 1 MiB
  UTF-8 rules are included. Attachments, Obsidian configuration, arbitrary files, and
  note instructions are not mirrored or executed.

## Independent vault backup and restore

R2 is a conditional mirror with 30-day deleted-content recovery, not a complete vault
backup. M5 does not select, configure, or guarantee any external backup provider; the
vault owner must keep an independent, versioned backup appropriate to the data. A backup of
the vault does not capture native SecretStorage contents or necessarily capture
Obsidian host-local mirror state. `data.json` contains only a secret reference, not the
bearer itself. Keep content backup, credentials, and the content-free mirror ledger as
separate recovery concerns.

1. Before a risky plugin update, handoff, or recovery-maintenance operation, pause the
   writer and preserve the complete working vault with the independently selected
   backup mechanism. Follow that provider's integrity/retention contract; verify a
   restore on an isolated copy and compare the intended paths/content before relying
   on it. M5 did not qualify a provider or remote backup service.
2. Never restore a vault over a live writer or overwrite/delete the original copy as
   part of a test. Open a restored copy without activating the mirror. Treat restored
   notes as current local data that requires exact identity/revision review; do not
   infer remote absence, replay old operations, or silently overwrite remote content.
3. Preserve R2 and the original host-local state as evidence when a restore is needed.
   Do not treat restored `data.json`, a vault copy, or a structurally valid old ledger
   as mirror authority. Re-establish credentials separately, verify authenticated
   association/writer identity, and use the documented handoff, reconciliation, or
   isolated-reset procedure before activating a writer.
4. For one deleted note, use the bounded [recovery API procedure](#read-only-recovery-inspection)
   to inspect metadata and explicitly export exact content. This does not restore the
   whole vault, reset remote state, or replace the independent backup.

## Initial setup for a new empty association

The initial M3 association must use a separately authorized **empty** R2 bucket or
isolated namespace. Do not point a new association at old keys and do not infer that
committed development configuration means a remote resource exists.

1. **Provision the Worker/R2 prerequisite separately.** Bind `VAULT_BUCKET` to the
   intended empty bucket and generate a fresh canonical lowercase UUID-v4 only for
   `MIRROR_ASSOCIATION_ID`. Do not invent `MIRROR_WRITER_ID`; the plugin owns that
   device identity. The committed configuration omits both IDs, so it cannot grant
   write authority before an operator configures a real association.
2. **Build, qualify, and load the plugin passively.** Run the canonical tasks in
   [plugin development](plugin-development.md). The M5 support envelope names
   Obsidian Desktop 1.13.7 on macOS 26.6.2 / Apple M4 Pro; use a disposable vault for
   any manual test. Enable AI Bridge while it is unconfigured and keep the mirror
   inactive; passive loading provisions its device UUID without sending note content.
   The bounded M5 report covers only synthetic active-writer and recovery scenarios,
   not a real personal association or deployed service.
3. **Obtain the generated plugin device UUID.** Open AI Bridge settings and copy the
   read-only **Local device / writer ID**. This value is non-secret and is the only
   writer UUID to use for this device.
4. **Configure the Worker identity.** Set `MIRROR_ASSOCIATION_ID` to the independently
   generated association UUID and `MIRROR_WRITER_ID` to the exact plugin device UUID
   from the previous step. A mismatch remains passive and fails mutation closed.
5. **Configure the client credential and endpoint.** Follow
   [credential provisioning](#credential-registry-lifecycle-and-singleton-migration)
   to create a full-writer client with `read,write,delete`, apply its digest-only
   registry through `OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY`, and transfer the raw token
   exactly once into native SecretStorage. Registry authentication is the only runtime
   mode; never configure `OBSIDIAN_BRIDGE_TOKEN` or `OBSIDIAN_BRIDGE_AUTH_MODE`, and
   never commit the registry or raw token to `wrangler.jsonc`,
   `mise.local.toml.example`, plugin data, screenshots, or
   documentation. Select only the corresponding native SecretStorage reference under
   **Bearer secret reference**; `data.json` stores only the reference. Host-local
   mirror state and handoff records must not contain the plaintext bearer. Enter an absolute endpoint
   origin with no userinfo, query, fragment, or non-root path. HTTPS is required.
   Plain HTTP is allowed only after explicit consent for the exact literal
   `localhost`, `127.0.0.1`, or `[::1]` origin including its port. There is no LAN,
   DNS-name, suffix, alternate numeric-address, or mobile-to-desktop loopback
   exception. Native SecretStorage is host-managed vault-local secret storage, not a
   documented OS-keychain guarantee.
6. **Verify designation.** Use **Authenticated server identity** and confirm that the
   returned association matches the intended association and the designated writer
   equals the displayed local device UUID. A mismatch remains passive and fails
   mutation closed.
7. **Give whole-scope consent.** Read and accept the whole eligible Markdown,
   plaintext trust, and runtime-deletion disclosure. There is no per-note selection,
   per-folder allow-list, or per-delete confirmation.
8. **Activate only after exact alignment.** For a genuinely new empty association,
   enable **Enable whole eligible Markdown mirror** after designation verification.
   The plugin waits for workspace layout readiness before registering official Vault
   listeners. It classifies persisted observation gaps and runs positive bootstrap; the
   early scheduler slot is limited to current-scan positive paths without unresolved M3
   intent or M4 reservations. It durably drains a bounded startup event buffer before
   normal scheduling and persisted M4 resume. Buffer overflow, failed drain, or active event-delivery rejection leaves
   the lease and normal work closed; reload/re-enable to establish a fresh classified
   listener epoch, and do not treat existing operations as resumable before review. It
   enumerates positive eligible saved state, checks remote state, and uses create-only conditions
   for unassociated paths. Existing live, legacy, or tombstone collisions block rather
   than being adopted or overwritten. Startup or scan absence never creates deletion
   authority.
9. **Verify staged behavior.** Use metadata-only status and **Check mirror now**.
   Expect bounded bootstrap/catch-up and then observing status. Verify remote state
   with authenticated read-only v2 requests before relying on freshness. Do not treat
   one scan as proof that iCloud hydration is complete.

Enabling an unconfigured, disabled, or non-writer plugin does not send note content.
M2 inspection commands remain independent and do not grant upload consent.

## Live diagnostic boundary

Worker application logs are platform-managed live diagnostics with zero-day
application retention. No Workers Logs, Logpush, Tail Worker persistence, OTLP export,
or project durable sink is configured. A missed or sampled live session may leave no
record; these events are not a durable security audit trail, non-repudiation evidence,
or recovery authority.

Each completed request event contains only the event kind, HTTP method, registered
route template or bounded `unknown`, closed operation category (`public`, `mirror_read`,
`current_read`, `current_mutation`, `destructive_mutation`, `recovery_read`,
`recovery_maintenance`, or `unknown`), closed authentication result (`public`,
`rejected`, or `authenticated`), canonical client ID when authenticated, HTTP status,
stable API error code when available, and duration. It excludes client display names, permission metadata, raw
bearers, token digests, authorization headers, request/response bodies, concrete or
encoded note/recovery identifiers, revisions, content hashes, operation/recovery
receipts, storage envelopes, and raw exceptions. Public and rejected requests have no
client ID. Repeated traffic and destructive attempts remain observable but no request
quota, rate limit, 429 behavior, or durable history is implied.

## Saved-event and iCloud uncertainty

The plugin receives host events, not human-intent provenance or a globally ordered
transaction log. Once bootstrap has completed, an observed eligible delete event for
an already associated path—including an event caused by iCloud or another external
change—can authorize a recoverable remote tombstone after the five-second grace and
an exact local-absence check.

Changes made while the writer is offline, while the plugin is disabled, or during a
listener gap can later be rediscovered **positively** by a fresh scan. Listeners attach
only after layout readiness; buffered startup events are durably sequenced before normal
scheduling. A rejected active event callback synchronously closes effect authority and
is classified as a new observation gap. Every active M4 operation spanning a cold start,
listener gap, or delivery failure remains fenced until fresh complete-group review safely
settles or transfers its reservations;
unknown effects and unreviewable evidence stay reserved. A missing path during startup
or a gap never authorizes deletion. Consequently, an offline local deletion may remain
as a stale remote live head until explicit reviewed reconciliation. Ordering across
devices is not globally transactional, and the designated writer must run for mirror
freshness. The bounded M5 scale and v4→v5 migration/restart evidence is in the [final
qualification report](qualification/m5-final.md); corrective host details remain in the
[listener-gap report](qualification/m4-listener-gap-recovery.md). The exact qualified
profile does not establish other desktop configurations, mobile/iCloud ordering,
background iOS, or always-on behavior.

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
- Every fresh listener epoch durably gap-fences active M4 operations before effectful
  resume. The startup event buffer must drain successfully before normal scheduling;
  missing entries in positive scans never authorize delete. Unsupported runtime
  capabilities, state/configuration failures, and incompatible persisted versions fail
  closed.
- Disabling or uninstalling does not prove remote requests were cancelled, erase a
  shared native secret, revoke a bearer, or make persisted state safe to discard.

## Safe writer handoff

There is no automatic takeover and no iCloud-synchronized transactional ledger.
Perform this sequence exactly:

1. On the future writer, build and load AI Bridge passively, obtain its generated
   read-only **Local device / writer ID**, and keep its mirror inactive. Do not import
   activation from the old writer or designate this device yet.
2. On the old writer, pause for handoff and drain accepted work.
3. Prove there is no unresolved mutation intent, blocked path, persistence failure,
   or deferred rename dependency. A timeout, client abort, quiet interval, or GET of
   the old revision is not proof of quiescence.
4. Export the validated content-free handoff metadata. It contains association,
   origin, per-path ACK/hash or tombstone identifiers, and an integrity checksum; it
   excludes note bodies, bearer, secret reference, activation, and device ID.
5. Disable the old writer. Only now, as a separately authorized server operation, set
   the Worker's `MIRROR_WRITER_ID` to the already-known future-writer device ID.
   Rotate the bearer independently; designation does not revoke the old bearer.
6. On the future writer, configure the endpoint and its own native SecretStorage
   reference, then explicitly import the same-association handoff metadata. Keep it
   inactive for ordinary mirror mutations until verification succeeds.
7. Run staged local and remote verification. Every transferred live entry must match
   the current saved local SHA-256 and exact remote revision; every transferred
   tombstone must be locally absent and remotely exact. Events arriving during this
   sample invalidate the evidence and require another complete batch.
8. Activate only after the serialized alignment transition succeeds. Keep the old
   device disabled.

If the old writer or ledger is lost, unresolved, or cannot be drained, do **not**
automatically take over the same association. Preserve the old bucket, credentials,
and local evidence for recovery. The safe reset is a separately authorized new empty
bucket/namespace, new association UUID, new credentials, and new designation with no
route for delayed old requests to reach it.

## Credential registry lifecycle and singleton migration

The credential tool is offline: it makes no HTTP administration call, changes no
Worker binding, and never deploys. Registry files contain confidential digest verifier
material and must use a protected path outside the repository. Secret-generating
commands require an interactive terminal and refuse redirected stdout. They display
the raw canonical base64url token once after atomically writing the digest-only
registry with owner-only permissions. Copy that token directly into the consuming
client's approved secret store; do not put it in a CLI argument, file, shell history,
clipboard automation, log, screenshot, issue, or documentation.

### Create and provision

1. Choose a unique 1–64 character ADR-compliant name and the least exact permissions.
   The current designated writer needs all three permissions for complete M3/M4 behavior.
2. Create or update a protected outside-repository registry:

   ```bash
   mise run credentials -- create \
     --registry "$HOME/.config/obsidian-ai-bridge/credentials.json" \
     --name "Obsidian writer" \
     --permissions read,write,delete
   ```

3. Transfer the displayed token once into the client's native SecretStorage entry.
4. Apply only the registry file through the authorized Worker secret boundary, for
   example by feeding it on stdin to `wrangler secret put
   OBSIDIAN_BRIDGE_CREDENTIAL_REGISTRY`; do not pass verifier JSON as a command
   argument. No authentication-mode variable is accepted.
5. Verify authenticated server identity and intended non-destructive current behavior.
   Local generation alone is not provisioning success.

### Upgrade from a singleton-authentication version

This version has no singleton mode, fallback, token binding, fixed migration principal,
or automatic secret copying. Operators must complete credential provisioning **before**
upgrading the Worker into this version:

1. Pause the writer and settle or preserve every pending/unknown M3/M4 effect while the
   previously deployed version remains available.
2. Use the offline lifecycle tool to create a distinct full-writer registry credential
   with `read,write,delete`, install its raw token in native SecretStorage, and stage the
   digest-only registry secret through the authorized platform boundary.
3. Switch the plugin/client to that registry bearer and verify authenticated server
   identity plus a non-destructive v2 read against a registry-capable Worker version.
4. Stop/drain every v1 or singleton client, preserve unresolved effect evidence, then
   upgrade forward to this version. V2 is the sole authenticated HTTP API.
5. Prove the old singleton token now receives sanitized `401`, remove
   `OBSIDIAN_BRIDGE_TOKEN` and any `OBSIDIAN_BRIDGE_AUTH_MODE` variable through the
   authorized platform mechanism, and verify the new registry client again.
6. Resume only after preserved effects are reconciled. Never roll back to singleton
   authority or a registry snapshot containing revoked credentials.

### Rotate with bounded overlap

1. Pause or settle relevant writer work. Rotation is independent of association/writer
   identity and never mutates the old token.
2. Create a distinct replacement name/client while retaining the old entry:

   ```bash
   mise run credentials -- rotate \
     --registry "$HOME/.config/obsidian-ai-bridge/credentials.json" \
     --client-id "$OLD_CLIENT_UUID" \
     --name "Obsidian writer next" \
     --permissions read,write,delete
   ```

   Rotation refuses when all 16 slots are occupied; explicitly revoke an unrelated
   credential or accept a controlled no-overlap replacement instead of eviction.
3. Apply the overlapped registry, install the new token, verify the new principal with
   non-destructive behavior, switch the client, and settle old in-flight work.
4. Revoke the old client exactly, reapply the registry, and prove its old token returns
   `401`:

   ```bash
   mise run credentials -- revoke \
     --registry "$HOME/.config/obsidian-ai-bridge/credentials.json" \
     --client-id "$OLD_CLIENT_UUID"
   ```

### Revoke or replace a lost token

Exact revoke removes only the named client ID and never changes unrelated clients.
Apply and verify the replacement registry before considering revocation effective.
A raw token cannot be recovered from its digest.

Treat loss as possible disclosure. To skip overlap and atomically replace the old
entry in the local candidate registry:

```bash
mise run credentials -- replace-lost \
  --registry "$HOME/.config/obsidian-ai-bridge/credentials.json" \
  --client-id "$LOST_CLIENT_UUID" \
  --name "Recovered writer" \
  --permissions read,write,delete
```

Install the new raw token, apply the registry, prove the old token fails, and inspect
preserved operation evidence before resuming. If limited overlap is safer than outage,
use the rotation procedure but minimize the interval and explicitly revoke the old ID.

### Total registry loss

Do not reconstruct tokens from digests, clients, logs, or documentation. Pause clients
and writer admission; authentication remains fail-closed. Preserve R2, device state,
receipts, active/unknown operations, recovery evidence, and platform audit evidence.
Build an unrelated registry with one declaration per client:

```bash
mise run credentials -- replace-registry \
  --registry "$HOME/.config/obsidian-ai-bridge/credentials.json" \
  --client "Obsidian writer=read,write,delete" \
  --client "Read client=read"
```

Every client receives a fresh ID and token. Deliberately reinstall each token, apply
the all-new registry, verify required principals, and reconcile possibly committed
in-flight effects before resuming. Registry loss never authorizes R2 reset, device-state
reset, deletion, or restoration of an arbitrary stale registry.

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
Authorization: Bearer <client-bearer>
```

The response is one metadata-only page (at most 50 scanned objects) with
`nextCursor` or `null`. Continue even if a page has no visible entries but has a
cursor. Do not manufacture or decode cursors.

```http
GET <bridge-origin>/api/v2/recovery/<recovery-uuid>
Authorization: Bearer <client-bearer>
```

Inspect the closed metadata state and strong application `ETag`; this endpoint does
not return note text.

```http
GET <bridge-origin>/api/v2/recovery/<recovery-uuid>/content
Authorization: Bearer <client-bearer>
```

Prepared and unexpired sealed content returns Markdown. Expired or purged content
returns `410 recovery_unavailable`; unknown IDs return 404. Export deliberately to a
protected destination. The API does not write an Obsidian note.

### Seal repair

For a valid prepared/unsealed entry, use its exact current application ETag and fresh
canonical UUID-v4 operation identity:

```http
POST <bridge-origin>/api/v2/recovery/<recovery-uuid>/seal
Authorization: Bearer <client-bearer>
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
Authorization: Bearer <client-bearer>
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

## Reviewed M4 reconciliation

M4 registers **AI Bridge: Review remote divergence** and **AI Bridge: Restore recovery
snapshot** for the attached, layout-ready, identity-matched designated writer. Opening
either command performs bounded read-only discovery. It does not grant blanket remote
authority or mutate a note. The same one designated writer owns M3 and M4 work; there
is no multi-writer election, lease, automatic takeover, or background-iOS guarantee.

### Review, refresh, defer, and action selection

1. Verify **Authenticated server identity** and inspect mirror status. Settle M3
   unresolved effects before M4; M3 evidence takes precedence.
2. Run **Review remote divergence**. Select one candidate to create a process-local,
   exact evidence snapshot. Inventory can be incomplete and is never mutation
   authority.
3. Open local or remote previews only when needed. They use literal text controls;
   Markdown, HTML, links, embeds, commands, frontmatter, and note instructions are not
   rendered or executed. Imported plaintext may later be handled by other trusted-host
   plugins, so inspect untrusted remote text before writing it.
4. Choose one offered typed action. Buttons do not determine safety: admission
   rechecks the review ID, session, lifecycle, listener epoch, local generation/hash,
   baseline, remote revision/receipt, recovery identity, paths, and reservations.
5. If status reports stale/unavailable, close the old modal and run the command again.
   Refresh always creates a new review; it never upgrades an old decision to the latest
   revision. Defer performs no content mutation and leaves the divergence visible.

The ordinary actions mean:

| Action | Operational result |
| --- | --- |
| **Keep local** | Preserve the exact reviewed remote competitor, then conditionally update the original remote path from its reviewed revision. |
| **Use remote** | Preserve the exact reviewed local competitor, then atomically compare-and-replace local text. It performs no remote mutation. |
| **Keep both** | Preserve the competitor and use an explicitly entered, separately sampled eligible destination; no collision suffix is invented. |
| **Defer** | Make no content change. Reopen a fresh review later. |
| **Fork legacy** | Preserve unversioned remote text and create a different absent local/remote path. The original legacy object remains untouched and unassociated. |

A manual merge is performed in Obsidian, not in the modal. That edit invalidates the
open review; open a fresh review and normally choose Keep local or Keep both. Equal
text alone never adopts a remote revision. A remote change after review makes the
original predicate stale; the client never fetches the latest revision and overwrites
against it.

### Conflict preservation and cleanup

Before replacement or reviewed remote cleanup, the competing bytes are create-only
and post-verified under one of these excluded paths:

```text
ai-bridge-conflicts/<operation-uuid>/<side>.md
ai-bridge-conflicts/<parent-operation-uuid>/<step-uuid>/<side>.md
```

The second form is used by grouped history steps. Remote paths and note titles never
shape these names. The current host-visible root and historical
`.ai-bridge-conflicts` root are both explicitly excluded from scans, saved-file events,
review candidates and remote propagation. Conflict artifacts contain sensitive
plaintext and are not a complete backup. Collision, unknown effect, or failed reread
stops the action; there is no overwrite/suffix/delete fallback.

Frozen legacy receipts retain their exact dot-prefixed paths. The plugin does not
rewrite, move, copy, repair, infer an unindexed physical effect, or redispatch that
unknown effect under the current root. A pending/unknown legacy preservation therefore
remains blocked or evidence-required until existing effect-certainty policy can prove
it; new operations use only `ai-bridge-conflicts`.

Cleanup is manual in M4. After status proves the reviewed operation complete, inspect
and copy/export any artifact still needed, then remove it deliberately through
Obsidian. Do not remove an artifact while its operation is active, blocked,
`evidence-required`, `successor-review-required`, or `restored-pending-review`. The
plugin does not automatically delete preservation artifacts or claim filesystem
transactionality.

### Tombstone acceptance and recreation

A remote tombstone never deletes or moves a live local note. For a freshly proven
local absence, **adopt tombstone** records only the exact tombstone baseline. Startup,
scan, listener-gap, partial-hydration, or remote physical absence is not acceptance
authority.

For a live local note, the available reviewed choices preserve/defer, copy to a
separately sampled path, or conditionally recreate the remote live generation from the
exact tombstone revision. Recreate preserves the local competitor first and retains the
existing recovery object. To accept deletion of a live local note, remove or move it
manually in Obsidian, allow the event to be recorded, then open a fresh absent-path
review. Never clear the ledger to simulate absence.

### Recovery restore and pending review

1. Run **Restore recovery snapshot**. The list is metadata-only and distinguishes
   prepared, sealed-active, sealed-expired, purged, and incomplete rows. Only prepared
   or unexpired sealed rows from a complete list are actionable.
2. Select one row and type the exact destination path. The plugin re-inspects metadata,
   reads and validates bounded UTF-8 content, and rechecks the current remote head.
3. An absent destination is create-only. An occupied destination requires reviewed
   preservation plus exact compare-and-replace; folder, excluded/config, invalid,
   oversized, or newly occupied destinations refuse.
4. Restore writes locally first and performs **no remote mutation or baseline update**.
   It remains `restored-pending-review`, reserved across restart/re-enable, until a
   fresh linked review explicitly recreates/publishes, adopts an exact live head, or
   remains deferred. An alternate restored path also needs an explicit absence-only
   Keep local publication decision.

Do not interpret restored local bytes as remotely published. Do not discard state to
release the reservation; complete the linked review or preserve the blocker for later
operator attention.

### Rename/history attention

Deferred rename chains, overlaps, duplicate live sources, and former-source cleanup are
reviewed as one bounded current-evidence group. The application, not the UI, derives
the complete group. Choose retain independently, defer, or an offered cleanup toward
an existing grouped candidate. Cleanup preserves each exact remote former source and
uses one recovery-first conditional tombstone per ordered step. A stale/unknown/refused
step blocks later steps; completed steps are not replayed.

History performs no local create, replace, rename, move, trash, or delete. If the
intended mapping needs local restructuring, do it manually in Obsidian and open a fresh
ordinary review. No atomic multi-path rename or reconstruction of historical intent is
claimed.

### Attention states, unknown effects, and handoff

Closing a modal, disabling the plugin, or replacing its UI session invalidates
transient review authority and discards sampled bodies. It does not cancel an admitted
operation. Compatible same-realm replacement retains durable/in-flight ownership;
incompatible registry or runtime versions fail closed and require a host restart.

Treat `blocked`, `evidence-required`, `unknown`, `successor-review-required`, migrated
legacy-history attention, and `restored-pending-review` as preservation states, not
errors to erase. An unknown remote effect may complete only from its exact operation
receipt; an unknown local effect may complete only from the exact expected saved
postcondition. A later local event, even with identical text, is successor evidence and
requires fresh review or exact no-effect alignment.

Any active M4 operation, unknown effect, history blocker, restored path, or successor
review blocks handoff drain/export. Pause new work and resolve or retain the blocker;
never delete host-local state, reuse a parent operation ID, or force handoff because a
request timed out.

### Device-state migration and downgrade prohibition

Current startup accepts strict version 5 or performs the same-key deterministic
**v2→v3→v4→v5** transition. Frozen v2/v3 projections remain unchanged; v4→v5 preserves
all prior evidence and marks every nonterminal historical operation as requiring
fresh gap review. The complete projection is validated, written once, and read back as
exact canonical bytes before owner publication or effectful resume. Decode, quota,
save, read-back, integrity, or version failure closes startup. Version 3 and 4 remain
frozen historical formats: unrefined history remains attention, and started local
effects require exact read/hash evidence without redispatch. No decision or event
causality is inferred.

Every fresh layout-ready listener epoch durably fences active operations before the
dispatch lease is published. A bounded callback buffer is drained before ordinary
scheduling, review UI, and persisted M4 resume; each effect also checks the exact
current listener/configuration lease immediately before dispatch. Runtime owner and
same-realm registry structural versions are 5. Version-2/3/4 code must reject v5, and
v5 code refuses an older same-realm owner. There is no reverse migration or supported
downgrade. Pause, preserve state and conflict artifacts, restart the host when crossing
an incompatible same-realm runtime, and upgrade forward.

## Rollback and downgrade restrictions

No rollback path is claimed safe unless it has been tested. Use these alternatives:

| Unsafe action | Why it is unsafe | Safe response |
| --- | --- | --- |
| Run version-2/3/4 plugin code after device-state v5 exists | Older code must reject v5; stripping history, gap-review, effect, or reservation evidence can discard partial authority. | Preserve state/evidence, restart into compatible code, allow only the built-in verified v2→v3→v4→v5 migration, and upgrade forward. |
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
