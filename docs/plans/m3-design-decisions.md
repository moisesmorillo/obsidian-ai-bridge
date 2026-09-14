# M3 design decisions — maintainer review required

**Status: proposal, not implementation authorization.** Baseline: merged M2 at
`b300726` (PR #7), clean `main` when research began. M2 is COMPLETE, M3 is the
single NEXT milestone, and no M3 production code exists. The
[specification](../milestones/m3-remote-bridge-client-and-publishing.md) and
[sequential plan](m3-remote-bridge-client-and-publishing.md) describe the recommended
branch of this design. They remain blocked until the choices below are approved.
No approval has been inferred from the request to perform planning.

## Decision authority

**Technical conclusions supported by repository constraints:** eligibility is not
consent; deny excluded paths even when selected; use the existing literal
`NotePath` predicate and 1 MiB UTF-8 bound; never GET-then-unconditionally-PUT;
preconditions must be applied atomically by storage; do not automatically adopt
existing notes; no core platform imports; validate remote/persisted inputs; retain
operation exclusion through actual settlement, separately from UI lifetime; no
local mutation, remote deletion, automatic retries or background work is needed.
A database is not justified by single-object conditional publishing.

**Maintainer decisions:** the selection/trigger product surface, credential
persistence and minimum host version, endpoint development policy, compatibility
break for existing API writers, stronger per-write identity/storage format, and
transport/platform support policy. Recommended constants are proposals, not
observed operational limits. Approval must identify options, not merely say that
CI passed.

## D1 — selection and trigger granularity

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| **A: persistent individual paths; publish active selected note only (recommended)** | Every send requires selection plus per-operation confirmation; M2 eligibility grants nothing. Hard exclusions always win. No bulk path expansion. Revocation stops future sends, never deletes remote content. | Two deliberate actions initially; tedious for many notes but understandable. Persist exact paths separately from revision baselines; confirmation names endpoint and path each time. | Reuses M2 captured saved-file reads. Test path replacement, revocation during read, empty selection and no enumeration-to-upload loop. M4 can add reviewed sets without changing existing consent meaning. |
| B: persistent individual paths with reviewed selected-set publishing | Safe with frozen manifest, final authorization checks and no implicit additions. More exposure per mistaken confirmation; partial successes cannot be rolled back. | Faster bulk use; requires per-note progress, bounded set size, cancellation of remaining entries and batch stop policy. Same path persistence plus ephemeral manifest. | Additional overlapping/revocation/partial-failure tests. Useful M4 batch orchestration, but not a prerequisite for M3. |
| C: folder rules (optionally individual exceptions) | Future files may gain consent without ever being seen; excludes and overlapping rule precedence become security policy. Frozen explicit expansion each run is safer than persistent recursive authority. | Convenient large-vault UX; highest rule/revocation complexity; persist rules and exceptions, not just paths. | More migration, rename and rule-expansion tests; preselects M4 semantics too early. Not recommended in M3. |

**Approve D1-A?** Empty by default; select one active eligible note explicitly;
revoke via a selected-path management dialog, including missing notes; no folder,
select-all, tag or frontmatter rules. Selection never follows a rename. A different
file later occupying a selected path still requires fresh publish confirmation;
M3 does not claim durable local file identity. Retain non-consent revision metadata
on deselection so reselecting cannot turn a known update into an unsafe create.

## D2 — credential persistence and host compatibility

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| **A: session-only token (recommended minimum M3)** | No token in plugin data or syncable settings; still readable by host/other privileged plugins while used. Removing a token cannot retract an already dispatched request. No keychain claim. | Re-enter after disable/restart. Password-style transient entry, explicit Set/Remove; never refill/reveal a stored value. Endpoint/selection/metadata persist, token does not. Smallest sensitive persistence surface. | Preserves minimum 1.5.0 using commands/modals rather than deprecated settings-tab display. Test missing/removed token, unload and poisoned diagnostics. M4 can add approved secret references through schema migration. |
| B: native SecretStorage reference | Avoids plaintext token in plugin data.json, but official docs describe vault-keyed local storage accessible by plugins, not isolation from the host or a documented OS keychain. Removing our reference does not delete a shared secret. | Native select/create secret UX; rotate in host secret manager. Persist reference only. Distinguish disconnect from revocation at Worker and deletion of shared host secret. | SecretStorage requires 1.11.4+. Prefer an explicit newer minimum (1.13.0 for modern declarative settings), or feature-gate with session-only fallback. Test unavailable API, missing shared entry, rotation, shared-reference removal. Useful later, requires maintainer compatibility preference. |
| C: opt-in plaintext token in plugin data.json | Cross-platform but vulnerable to settings sync, backups and filesystem/other-plugin access. Never make this the silent fallback for B. | Lowest repeated-entry friction; requires prominent plaintext warning, opt-in and erase/rotation paths. Persist secret separately modeled from non-secret state, though same file is not separate protection. | Compatible with 1.5.0; tests must inspect serialized bytes/removal and failed saves. Carries avoidable sensitive migration/recovery burden into M4. Not recommended. |

**Approve D2-A, or choose B with an explicit minimum/fallback?** Installed Obsidian
1.13.1 types mark `SettingTab.display()` deprecated since 1.13.0. The recommended
1.5.0-compatible design uses an explicit connection modal command, not that API.
Do not copy the docs' unchecked `Object.assign` settings example. No need to
introduce a compatibility lint suppression or raise the manifest incidentally.

## D3 — endpoint trust and local development

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| A: HTTPS only | Prevents plaintext transport, not sending to a malicious user-configured server. Reject credentials/query/fragment in URLs; never probe automatically. | Simplest rule; local Wrangler requires a deliberate TLS setup. Persist canonical origin only. | Works with hosted Worker. Test invalid/insecure URLs and redirects. No M4 protocol impact. |
| **B: HTTPS plus explicit exact-loopback HTTP opt-in (recommended)** | Default HTTPS; insecure exception only for literal localhost, 127.0.0.1 or [::1], with separate warning and disposable token. No arbitrary private networks, suffix matches or DNS-derived exceptions. Local software is trusted for development. | Compatible with current local Wrangler workflow. Persist development permission bound to the chosen origin; reset on origin change. | Test alternate IPv4 spellings, userinfo, lookalikes, encoded hostnames and redirects. Mobile loopback is the device itself; not LAN development. M4 inherits no insecure default. |

**Approve D3-B?** Restrict base URL to an origin (optional trailing `/`), not
arbitrary reverse-proxy prefixes; default port canonicalization is allowed, path
repair is not. HTTPS on nonstandard ports is allowed. Changing destination clears
token and selections and requires explicit disconnect/reset confirmation; metadata
must never be silently rebound to another destination. Same URL with a replacement
bucket is caught by per-note revision checks, not assumed to be the same mirror.

## D4 — server safety, identity strength and old clients

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| A: raw Markdown + R2 content ETag CAS | Atomically protects different content, but identical-body writes and delete/recreate can reuse the validator (ABA). A unique ID only in customMetadata cannot fix the check-to-put race. Requires explicit acceptance of content-equivalence instead of per-write identity. | Smallest storage change; ambiguous retries must refuse association unless separately proven. Store acknowledged validator locally. | Existing raw objects remain natural. Test same-body ABA as a limitation, not pretend ETag is R2 version. Leaves M4 migration if distinct history/identity is needed. Not recommended for the stronger association requirement. |
| **B: one versioned storage envelope per note, fresh server revision inside its body, R2 ETag CAS (recommended)** | Compare application revision from one GET, then CAS that exact object's storage ETag. Every accepted write changes body identity even when note text is identical. No separate metadata transaction. First publish only creates absent paths. Conditional failure never writes. | Small adapter codec and two-stage guarded update, no DB. Persist envelope at the existing note key and acknowledged opaque revision locally. Fail closed on legacy/unknown format for publishing. | Consequential storage/API migration. Old raw notes remain readable but cannot be adopted by plugin. Must close unconditional PUT access to this namespace. Test identical-body replacement, delete/recreate, dropped ACK, old client, and real local R2 conditional semantics. Stronger foundation for M4 without merging/importing history. |
| C: coordinator plus revision state (e.g. Durable Object) | Can serialize stronger transactions if every writer participates, but an R2 side path still bypasses it. No demonstrated multi-object transaction requirement in M3. | More infrastructure, state, failure/rollback and deployment complexity. | Requires new dependency/ADR, migration and coordinator crash tests. Potential M4 need is not justification today. |

**Approve D4-B and the compatibility break?** Proposed [ADR 0002](../decisions/0002-conditional-remote-note-mutation.md)
introduces `/api/v2/notes` over the **same** namespace: conditional PUT requires a
precondition (428 otherwise), and upgraded Worker v1 PUT returns 410 without a
write. The plugin must use v2: an old Worker ignores conditional headers on v1 PUT,
so even a separate capability probe would leave a downgrade race. Unknown v2
routes on the old Worker refuse instead of writing. Do not retain a legacy
unconditional route into the same namespace. Existing authenticated v1 DELETE
remains explicitly destructive external-client behavior, never called by the
plugin; no delete/recovery safety is claimed. A separate protected namespace could
preserve old writers but creates two divergent collections and migration/list
semantics. Prefer a documented experimental writer upgrade with v1 reads retained.
Deployment/rollback must not put an old Worker back in front of envelope objects;
planning and validation never deploy.

A SHA-256 checksum alone is not a storage predicate. `R2Object.version` is unique
but not accepted by `onlyIf`. A HEAD/existence check only for response status is
also not atomic create classification. See the ADR for the exact safety argument,
residual validator assumptions and preservation of raw legacy objects.

## D5 — mirror association and uncertainty persistence

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| **A: one configured namespace, exact paths, acknowledged per-note baselines; refuse uncertain adoption (recommended)** | Connection confirmation is not authority to replace existing paths. Initial create absent only; update only from successful publishing ACK. Even matching remote text never authorizes adoption. Lost metadata sacrifices availability, not existing content. | Dedicated personal Worker/bucket expectation; easy to explain. Persist origin, selections and last validated revision, with at most one unresolved-attempt metadata record. No vault-content copy or DB. Explicit blocked state after ambiguous failure; retry is bounded and manual. | Preserves `vault/<path>` layout. Test copied/reset state, same URL new bucket, lost ACK, failed save, remote absence and stale revision. M4 owns reviewed adoption/recovery; baseline schema is deliberately versioned. |
| B: explicit vault-ID namespaces | Separates independently configured vaults by construction, but does not replace consent or CAS; copied plugin data can copy vault IDs. | Better multiple-vault UX at the price of API route/list migration and identity reset/import policy. Persist vault ID on both sides. | Requires broader protocol/Worker changes and multi-vault tests; introduces M4/M5 identity product surface early. |
| C: explicit reviewed adoption of existing remote notes | Can be safe if both content and current revision are reviewed and committed conditionally, but equal text alone is insufficient. | Convenient recovery/first use; needs trustworthy comparison and review UX, not a hidden checkbox. Persist association evidence. | Starts conflict/adoption resolution work deferred to M4; substantial review/race testing. Not recommended in M3. |

**Approve D5-A and conservative blocked recovery?** An unresolved attempt record is
a safety interlock, not a durable offline queue: contains path, prior revision or
absence condition, attempted content SHA-256, and no body; it never causes a send
on load. A response lost after remote commit may leave the note blocked until M4
or deliberate operator recovery outside the plugin. Do not claim seamless crash
recovery. An ambiguous known-revision update may be retried once with the same prior
matching condition and exact in-memory payload; never GET the latest revision and
use it as new write authorization. An ambiguous create cannot be replayed: a prior
create followed by an independent delete makes absence true again, and M3 has no
history/tombstone proving that replay would not resurrect it. Clearing
local state cannot remove remote objects; future first-create still refuses them.

## D6 — transport, cancellation and network bounds

| Option | Correctness / data loss / security | UX / complexity / persistence | Compatibility / testing / M4 |
| --- | --- | --- | --- |
| **A: standards Fetch adapter, redirect:error, AbortController; narrowly specified Worker CORS (recommended, compatibility qualification required)** | Explicit no-redirect policy prevents forwarding bearer/body to another URL. Abort stops client waiting, not an already committed Worker/R2 mutation. Streaming byte limits are possible. No cookies. | Timeout/cancel has a real client transport signal. Adds CORS surface; CORS is not authorization. No new persisted network work. | Need desktop/mobile runtime qualification; no Node/Electron fallback. Test redirect denial, CORS preflight, exposed revision header, abort and delayed commit. M4 can reuse typed adapter, not pretend abort is rollback. |
| B: official Obsidian requestUrl | Avoids CORS and is host-provided, but published API has no abort, redirect policy, stream limit or final-URL property. A Promise.race timeout does not release in-flight ownership. Cannot establish a strict no-redirect guarantee from current declarations. | Host-friendly transport; timeout is only a UI deadline, potentially indefinite busy state until host settles. Fully buffers replies. | Requires a separately approved endpoint/redirect trust policy and demonstrated host redirect behavior before token-bearing publishing. Test host settlement after timeout/unload/re-enable and never claim network cancellation. Not a transparent fallback to A. |

**Approve D6-A and its CORS/qualification scope?** Proposed bounds: one foreground
operation and one request at a time per plugin instance; 30-second request/body
read deadline; zero automatic retries; manual retry after a retryable failure
only with unchanged payload/precondition and renewed consent. Inspection reads can
be retried manually. For ambiguous writes, status remains unknown even after an
abort. Ambiguous creates have no retry action; only known-revision updates may use
the one explicit original-condition replay. No batch means no cross-note
rollback/partial batch semantics; a successful
remote write followed by failed metadata persistence is still partial completion.
No real host transport compatibility has been tested in this planning session.

## Verified platform evidence

Repository reads: Worker repository/service/handlers/OpenAPI and their tests;
protocol schemas/tests; plugin entry/local adapter/host bridge and lifecycle
unit/integration tests; core path/eligibility/port and tests; M2 spec/plan;
`.mise.toml`, Vitest/V8, CI. Current source confirms unconditional M1 PUT, plain
schema-string response paths, missing body/content-type permissiveness, and
plugin-instance (not merely enable-session) M2 exclusion.

Public sources consulted (documentation snapshots are evidence, not approval):

- [Cloudflare Workers R2 reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
  `put` with `onlyIf` returns null without storing on failed condition; supports
  `Headers` or `R2Conditional`; unique upload version has no corresponding
  conditional field. SHA-256 options verify received bytes, not current revision.
- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/):
  strong binding reads/writes; unconditional simultaneous writes remain
  last-writer-wins. Strong consistency alone is not CAS.
- [Historical wildcard parsing issue](https://github.com/cloudflare/workerd/issues/2572)
  (closed): object-shaped wildcard was once parsed as a literal. Use constructed
  `Headers` with `If-None-Match: *`, and require local runtime contract tests, not
  a fake that assumes wildcard behavior. No claim that the closed bug persists.
- Installed `@cloudflare/workers-types` 5.20260910.1, `index.d.ts` R2Bucket,
  R2Object, R2Conditional and R2PutOptions match those signatures. The repository's
  narrower `r2.types.ts` does not expose them yet. Wrangler 4.130.0 declares
  Miniflare `5.20260908.0-alpha`; a direct test dependency must be explicitly
  version-aligned/locked if added, not imported through transitive internals.
- [Official secret guide](https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Plugins/Guides/Store%20secrets.md):
  plaintext `data.json` risk; native store is local storage keyed to a vault and
  shares secret references between plugins. No OS keychain/encryption guarantee
  was established. Installed 1.13.1 declarations mark SecretStorage since 1.11.4;
  no `deleteSecret` method is declared. Do not invent that removal API.
- [Official settings guide](https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Plugins/User%20interface/Settings.md):
  loadData/saveData use plugin `data.json`; current declarative settings require
  1.13.0. Installed types deprecate SettingTab.display since 1.13.0, with documented
  older-host fallback. The repository forbids incidental deprecated API usage.
- [Official API declarations](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts):
  requestUrl bypasses CORS; RequestUrlParam exposes neither signal nor redirect
  control. Plugin data APIs return/accept weak library types: validate immediately
  inside the adapter, not across core.
- [Mobile development](https://github.com/obsidianmd/obsidian-developer-docs/blob/c56c7e770ba25dd0ea392aacf4588f9425970d36/en/Plugins/Getting%20started/Mobile%20development.md):
  no Node/Electron APIs on mobile. Non-desktop manifest is intent, not evidence
  that a new Fetch/CORS integration works on all hosts.

## Approval record

Pending: **D1-A, D2-A (or B with minimum/fallback), D3-B, D4-B including v1 writer
break/storage migration, D5-A conservative recovery, D6-A CORS and platform gate**.
No maintainer choice has been recorded. If any recommendation changes, revise
its dependent spec/ADR/plan slices and rerun semantic review before declaring
implementation readiness. M3 remains NEXT, planning only; M4 remains PLANNED.
