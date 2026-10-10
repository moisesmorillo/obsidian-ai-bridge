# M9 — Bounded automatic Markdown sync in disposable vaults

**COMPLETE as a disposable synthetic Desktop demonstration.** M9 delivers an automatic sync loop
in the *separately built experimental plugin*, using the existing remote
synthetic Worker and durable exact-base client. This increment is for disposable
Desktop vaults and approved synthetic endpoints only; it does not alter the
release plugin, production Worker, writer designation or G1–G6.

## Scope and boundaries

- Keep the current exact HTTPS endpoint, participant, ticket, path and 16 KiB
  admission boundaries. Only configured, explicitly enabled synthetic Markdown
  paths participate. Never scan or attach an existing/personal vault by default.
- Replace repeated manual `Sync now` commands with a bounded owner-controlled
  schedule while the disposable Obsidian host is open. Observe official saved-file
  events and poll remote revisions at a fixed, documented interval so REST/other
  device edits can arrive without a local event. Keep manual `Sync now` for recovery.
- A single owner and generation/lease guard serialize each path. Persist prepared
  effects and exact-base acknowledgements before advancing a checkpoint; after
  unload/reload, recover the original operation tuple. One pending path must not
  block bounded progress for another admitted path.
- Coalesce bursts, respect server retry floors and exponential backoff, cap work
  and transport tickets per wake, and stop scheduling on expiry, disabled config,
  changed endpoint/identity, exhausted tickets or persistence uncertainty. Never
  busy-loop a `pending` result or treat an HTTP failure as an empty feed.
- Preserve concurrent local and remote versions under the existing excluded-copy
  and attention policy. A stale local base must not overwrite remote content;
  uncertain effects retain their original tuple. No automatic conflict winner.
- No deletes, renames, arbitrary vault traversal, attachments, Canvas, OAuth,
  MCP changes, migration, production route, iCloud replacement or mobile claim.

## Functional delivery

1. Implement one owner-scoped timer/event scheduler and its strict configuration
   in the experimental plugin. Reuse the durable client, fetch guard and secret
   reference; do not implement another sync engine or introduce DO/KV. Include
   focused unit and generated-artifact checks with the behavior.
2. Demonstrate automatic A→B, B→A and REST→device on two disposable Desktop
   vaults or clearly labeled isolated host instances, with no `Sync now` between
   create/edit and observed settled content. Verify exact bytes, revision, hash
   and persisted checkpoint after a targeted reload. Exercise a concurrent edit:
   both versions survive, attention is visible and no stale ACK advances.
3. Prove timer cancellation and lease fencing on disable/unload, configuration
   change, expiry and failed persistence; prove bounded attempts and retry floors
   under `pending`, 429/unavailable and lost reply. Verify release artifacts and
   production routes are unchanged, then record measured request counts and
   any unresolved host limits.

## Completion criteria

- Automated checks and one disposable-host demonstration pass. A test double alone
  is labeled as such and cannot close the Desktop criterion.
- No false deletion/absence authority, ticket reuse, retry spin or overwrite under
  stale base; old manual workflow remains usable and its ledgers remain readable.
- `mise run check`, independent semantic/security review and a source-bound report
  are recorded before marking M9 complete. G1–G6 remain separate blockers before
  real-data or production use.
- Development and local disposable-host checks need no Cloudflare operation. Any
  new remote lab requires separate authorization of its exact destination,
  operations and credential/session; the completed F authorization cannot be reused.

## Desktop qualification progress

The [disposable Desktop report](../qualification/m9-disposable-desktop.md)
records automatic REST→A/B, A→B and B→A delivery, targeted host reload,
conflict preservation, and teardown of the separately authorized temporary
Worker and private bucket. This closes the real Desktop demonstration criterion
within its one-path synthetic scope. The report records admission objects,
not a complete HTTP request count. It directly verifies one persisted
`vault-A` checkpoint across a second targeted Force Reload after the lab
Worker was removed, while the source-bound [host-instance report](../qualification/m9-automatic-host-instance.md)
contains the broader scheduler and checkpoint assertions. Neither source
proves a full Obsidian process restart or production readiness. G1–G6 remain
independent production blockers.
