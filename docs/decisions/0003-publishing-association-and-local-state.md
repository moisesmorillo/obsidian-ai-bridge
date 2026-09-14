# ADR 0003 — Publishing association and conservative local state

## Status

**Proposed.** Depends on approval of M3 decisions D1/D3/D5 and
[ADR 0002](0002-conditional-remote-note-mutation.md). No accepted product policy
or persisted M3 state exists yet.

## Context

M2 eligibility and stat evidence are neither publishing consent nor durable note
identity. M1 exposes one token-wide namespace. Existing paths may belong to an
unrelated vault or client. A GET returning equal text cannot establish ownership.
Obsidian plugin data persistence offers no documented transactional/CAS contract
across plugins, devices or processes. Retaining note bodies just to make retry
convenient would add an unnecessary sensitive local copy.

## Decision

Subject to approval:

- Support one configured Worker origin representing one personal remote namespace,
  mapping each unchanged literal local `NotePath` to that same remote path. No
  vault UUID, prefix remapping, database or per-user authorization. User confirms
  this destination explicitly; no background connection or implicit association.
- Persist individual selection paths independently of per-note remote baselines.
  Default selection is empty. Every manual active-note publish additionally
  confirms path and origin. No folders, select-all, automatic rename tracking or
  selection inferred from inspection, remote listing, filename similarity or text.
- A note without a baseline uses conditional create only. An existing remote
  object, including identical or legacy text, refuses association. A note with a
  baseline uses only its last validated successful publishing revision. Ordinary
  inspection never advances it; remote missing never converts it to create.
- Persist schema-versioned non-content state via a narrow plugin-state port and
  Obsidian loadData/saveData adapter. Use validated DTOs and a single application
  state owner serializing entire read-current/apply/persist transitions, not just
  disk calls with stale precomputed snapshots. No unchecked merging. Token is
  session-only under recommended D2-A and never enters that DTO. The local state is a convenience/safety record, not trustworthy
  remote authority or isolation against other plugins/host software.
- Before a PUT, persist a single unresolved-attempt record containing exact path,
  origin, original `absent | matching(revision)` precondition and SHA-256 of the
  bytes to send. It is a crash safety interlock, not a replayable offline queue:
  no body, timer, wakeup, automatic request or startup reconciliation. If saving
  this record fails or its durability is uncertain, do not send.
- After a valid success response, save the returned revision as that path's
  baseline and clear the unresolved record in the same serialized settings write.
  Only then show fully recorded success. If this save fails, show remote-stored /
  local-state-unrecorded and keep publishing blocked. Do not roll back the remote
  note. A later UI lifetime must not silently inherit a late success.
- A typed definite no-write response on the only dispatched attempt allows clearing
  the unresolved record, once host work settles and saving succeeds. A transport
  failure, malformed success, timeout, cancellation after dispatch or 5xx is
  ambiguous: retain the record. If any earlier attempt was ambiguous, a later 412
  is not proof that the earlier attempt did not commit; keep blocked.
- While still in the same foreground enable lifetime, offer one explicit retry
  of a **known-revision update** after an ambiguous retryable failure, only after
  the underlying client request settles and only with the original in-memory bytes
  and original matching precondition. Never replay an ambiguous create: a prior
  create may have committed and then been independently deleted, making absence
  true again. Avoid resurrecting it through a retry without tombstone/history.
  Require fresh consent, unchanged connection/token generation and selection.
  Do not reread a newer local body and substitute it. A successful replay may
  resolve state; a 412 is conflict/unknown, never inferred success. After unload
  or restart, release content and do not reconstruct/replay the attempt from the
  digest. Report unresolved previous publishing; no automatic adoption/recovery.
- Revoking selection never deletes remote content or baselines. Persist revocation
  before reporting it complete; deny further sends immediately in memory. If
  persistence fails, block publishing and warn that restart may restore older
  selection. Already dispatched work may commit; explicitly say so. Cancellation
  and token removal are not remote rollback. Require reselect plus a fresh manual
  confirmation before any future publishing.
- Disconnect/reset clears selection and token immediately, stops new dispatch,
  then clears non-content connection/baseline/attempt state after in-flight work
  settles. Require a warning that existing remote content remains and cannot be
  automatically re-associated. If persistence fails, stay blocked; never claim
  durable erase. Changing origin is this reset followed by explicit setup, not
  rebinding old revisions. Reset does not make an occupied remote path writable.

## Consequences

The remote conditional predicate remains authoritative even with stale/copied
local metadata. A lost, corrupted or rolled-back settings file can cause safe
refusal or loss of convenient association, not permission to overwrite an unknown
remote revision. Restored selections still require an explicit per-note publish
confirmation. This design does not promise tamper resistance, fsync guarantees,
multiple-process settings consistency or content recovery after a crash.

There is only one active operation and one unresolved record per plugin instance.
An unresolved record blocks further publishing globally until resolved or explicitly
reset, rather than accumulating a durable queue. M2 local inspection remains
available after pending work settles and any retained retry dialog closes.
Remote inspection is manual and
read-only; it reports current state without repairing baselines.

Settings contain sensitive paths, endpoint and content fingerprints, though no
note text. Backups/sync can copy them. Treat them as private; do not log them.
M4 must migrate this schema before adding adoption/recovery or reconciliation,
not reinterpret deselection as deletion or digest equality as consent.

## Alternatives

- Vault-ID namespaces help multiple vaults but require namespace/list migration and
  copied-ID/reset policy without being necessary for conditional path safety.
- Automatic adoption of equal content confuses text equality with intent and may
  associate unrelated files. Reviewed adoption belongs to M4.
- Durable content queue would improve retry convenience but violates M3 scope and
  adds a sensitive local copy. This proposal deliberately trades availability for
  conservative refusal after ambiguous outcomes.
- No unresolved-attempt record is simpler, but loses clear crash/partial-save
  reporting and permits a new attempt to obscure the uncertainty of a prior send.
- Persisting native secret references is a separate D2 choice, not a hidden field
  added to this metadata model. Plaintext token persistence is not recommended.

## Evidence / related documents

- `apps/obsidian-plugin/src/main.ts` and plugin lifecycle regression tests;
  `src/infrastructure/obsidian-local-vault.ts` and M2 saved-file evidence limits.
- [M3 decision brief](../plans/m3-design-decisions.md),
  [specification and persistence table](../milestones/m3-remote-bridge-client-and-publishing.md#state-and-persistence),
  [plan](../plans/m3-remote-bridge-client-and-publishing.md).
- [Official settings/secret API evidence](../plans/m3-design-decisions.md#verified-platform-evidence).
