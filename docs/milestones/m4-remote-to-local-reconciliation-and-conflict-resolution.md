# M4 — Remote-to-local reconciliation and conflict resolution

**Status: NEXT — refined planning specification only. Production implementation
requires a separate authorization after PR #27's M3→M4 transition becomes canonical.**

This planning specification records the post-M3 work without adding M4 code.
It builds on M3's accepted outward authority, conditional revisions, permanent
current heads, recovery snapshots, one designated writer, and device-local ledger.
It must not reinterpret or weaken those completed invariants.

## Objective

Let an operator deliberately inspect and resolve remote divergence without silently
losing local or remote data. M4 may add reviewed remote-to-local reconciliation,
explicit import/adoption, conflict preservation/resolution, richer recovery restore,
reviewed remote deletion handling, and narrowly bounded authority for each local
mutation it introduces.

M4 is not blanket bidirectional last-writer-wins. A remote generation remains
untrusted for local mutation until an explicit, typed policy grants that exact
authority and preserves competing content.

## Inherited M3 invariants

- One designated writer remains the supported M3 baseline; no implicit election,
  lease, or multi-writer expansion.
- Local saved events remain the ordinary outward mutation source. Startup/inventory
  absence never becomes deletion authority.
- V2 conditional generations, receipts, application ETags, v1 mutation retirement,
  tombstones, recovery-first delete, 30-day recovery, and retained purge markers
  remain authoritative.
- Eligible scope remains whole lowercase `.md`, literal safe paths, dot/config
  exclusions, and 1 MiB UTF-8 content. Eligibility remains separate from API client
  authorization.
- Bearer privilege and trusted plaintext boundaries remain explicit until a separately
  accepted M5 permission redesign.
- M3 state/intents must be migrated deliberately. No implementation may clear a
  blocker, refresh to latest, or adopt equal text merely to make M4 progress.
- No note instruction is executable. Remote note content is untrusted data.

## Candidate product capabilities

The implementation-ready M4 design must define, test, and document:

1. **Divergence review:** metadata and content comparison that identifies local,
   acknowledged, and remote generations without promoting a read to mutation
   authority.
2. **Explicit import/adoption:** operator-reviewed adoption of existing remote or
   legacy paths, including collision and tombstone rules. Initial equal content is
   not automatic proof of identity.
3. **Conflict preservation/resolution:** preserve every competing version before any
   local or remote replacement; define whether resolution is choose-local,
   choose-remote, copy-as-new, or a bounded merge workflow.
4. **Richer restoration:** deliberate recovery export/restore into the vault with
   exact destination/collision checks, never an implicit GET-side write.
5. **Remote deletion handling:** reviewed policy for a remote tombstone versus live
   local content, including stale/offline writers and recreation. Absence alone never
   silently deletes a local note.
6. **Bounded local mutation authority:** dedicated ports and user confirmation for
   each permitted local create/write/rename/delete. Do not broaden M3's read-only
   local adapter accidentally.
7. **Restart/interleaving safety:** durable non-content intent/receipt state,
   conservative unknown effects, finite work, and exact conditional predicates across
   process restart and concurrent local/remote changes.

## Decisions required before implementation

These are M4 decisions, not permission to reopen accepted M3 behavior:

- reviewed import only versus bounded bidirectional synchronization;
- the exact operator gesture and authority for each local mutation;
- conflict preservation format, placement, naming, and merge/review UX;
- remote tombstone import and local recreation semantics;
- legacy-object adoption and association proof;
- recovery restore destinations and collision handling;
- whether any writer-model expansion is necessary and, if so, its correctness model;
- state-schema migration/rollback behavior and recovery from M3 blocked histories.

Resolve consequential choices in ADRs before production code. Prefer the existing
Worker/core/plugin boundaries and services. Do not add a coordinator, database, queue,
or new Cloudflare service without a concrete accepted correctness need.

## Architecture constraints

```text
review/settings UI
    ↓ explicit typed operator decision
M4 reconciliation/import/restore application service
    ↓
conditional RemoteBridge + dedicated bounded local-mutation port
    ↓
validated Obsidian adapter / existing Worker v2 application policy
```

UI and event callbacks remain thin. Core remains free of Obsidian, Fetch/HTTP, Hono,
Cloudflare, and filesystem types. A new local mutation port must be narrower than the
host Vault and must encode exact permitted actions and preconditions. Remote DTOs
remain validated at the plugin transport boundary. No controller/settings callback
may call Fetch or mutate Vault files directly.

## Required harmful-interleaving evidence

Before acceptance, deterministic tests must hold the real decision windows open and
assert preserved bytes/revisions and forbidden side effects:

- local edit versus remote edit, including same-text ABA and lost ACK;
- local delete versus remote edit/tombstone/recreation;
- remote tombstone versus unsaved, stale, or recreated local content;
- import/adoption collision with live, legacy, tombstone, and physically missing
  states;
- restore into existing/renamed/excluded/oversized paths;
- rename chains and source/destination changes during review and commit;
- process restart, owner replacement, stale UI decision, cancellation, and failed
  local or remote persistence;
- iCloud event/partial-hydration uncertainty while review evidence is sampled;
- malicious/malformed remote content and path/size/schema failures;
- finite scheduling, no hidden polling/retry loop, and unrelated-path progress.

Tests must prove no silent local overwrite/delete, no silent remote overwrite, no
force-adoption by latest GET, and no loss of a competing version. Real-host/deployed
qualification must be reported truthfully rather than inferred from doubles.

## Documentation and operational gates

M4 completion must update API/OpenAPI if the wire contract changes, architecture,
current state, security/threat boundaries, plugin development, operator conflict/
restore runbooks, rollback/migration procedures, and the canonical roadmap. It must
preserve M3 recovery operations during migration and explain which operations are
manual, automatic, reversible, or irreversible.

Canonical validation remains `mise install`, `mise run install`, `mise run check`,
current runtime qualification tasks, artifact tests, coverage integrity, diagnostic
review, diff/secret review, and independent semantic review. Deployment and personal-
vault installation remain separately authorized.

## Exit criteria draft

M4 may be marked complete only when:

- every required decision has an accepted specification/ADR;
- remote-to-local and adoption authority are explicit and typed;
- all competing versions survive tested conflict/delete/rename/restart races;
- richer restore is exercised without silent destination replacement;
- state migration and downgrade/rollback restrictions are documented and tested;
- generated artifact tests proportionally exercise the new built behavior;
- four-metric coverage and canonical/runtime/diagnostic gates pass;
- operational/security docs match actual behavior and limits;
- an independent semantic review approves the complete implementation;
- no M5 permission redesign, production deployment, or unsupported platform claim is
  smuggled into M4 completion.

## Non-goals

No silent last-writer-wins, blanket remote authority, automatic adoption, arbitrary
history reconstruction, attachments, collaboration, replacement of iCloud/Obsidian
Sync, MCP, search/inference, production certification, or unapproved new
infrastructure. This file contains planning only; M3 Slice 8 adds no M4 production
source or test behavior.
