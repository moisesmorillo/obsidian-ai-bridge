# M8 successor — remote synthetic lab

**COMPLETE after merged #116/#117 and authorized lab F.** M8 local completed at
#114 (`eef552a`). This successor changes only the experimental transport
boundary, not the store, local safety, release or G1–G6 status.

The combined local implementation is verified in the
[delivery evidence](../qualification/m8-remote-synthetic-local.md). The
[F report](../qualification/m8-remote-synthetic-f.md) records real disposable
Desktop/R2 A→B, B→A and stale-CAS results plus verified lab teardown. The
[next bounded increment](m9-disposable-auto-markdown-sync.md) is separate.

## Contract

- Separate Worker/configuration/bucket and separately built plugin. No production configuration inheritance, routes, secrets, state, credentials or vaults.
- One configured canonical HTTPS origin, at most three ASCII Markdown paths, 16 KiB per note, exactly three independent registry participants. No OAuth, MCP, inventory, deletes, renames, migration, timers or real data.
- Strict remote configuration: original local authority plus exact HTTPS endpoint, experiment UUID, enabled flag, start/end epoch milliseconds, maximum one-hour lifetime. Missing/invalid/expired/stopped configuration denies before storage.
- Authentication, participant/permission and paired identity expectations precede storage admission. Remote requests require both identity expectations and a participant-local integer ticket 0–99. Each participant has 100 slots; create-only R2 claims consume slots permanently, even on failed or unknown effects. No refunds, clock extensions, repair or ticket reuse.
- Slot claims are private to the experiment/vault/origin and receive no note content. Every claim attempt costs at most one R2 PUT. A refused, unavailable or ambiguous claim never dispatches a service. Replay of an uncertain *store operation* uses its original tuple with a NEW transport ticket; transport tickets are not operation IDs.
- Count every binding attempt before dispatch, including claims, marker preparation and read-back. Hard ceiling 512 calls and 1 MiB submitted PUT bytes per accepted request. Exhaustion throws into existing conservative unavailable/unknown policy, never acknowledges an incomplete effect.
- Accepted workload <=300 requests. Client persists its next ticket before Fetch with exact read-back; unavailable/corrupt/exhausted state fences transport. Local and remote config, ledger and owner registry namespaces are separate. No bearer in state.
- Original-parent CAS, immutable versions, pending/floor recovery, listener leases, prepared local postconditions, conflict preservation and checkpoint fences remain unchanged.

## Budget and limits

A feed conservative upper bound is `2*(64 lane reads + 64 expiry reads + 100 event reads)=456` R2 calls. The 512 aggregate ceiling leaves 56 for claim/guards; mutation has its existing 64-call inner budget plus preparation. No external service fetch, KV or DO is added. Independent lane-head reads run in ordered batches of four, below [Workers' six simultaneous outgoing connections](https://developers.cloudflare.com/workers/platform/limits/); other feed reads and same-key writes remain sequential. This changes wall time, not the call ceiling or page authority. 300 admitted requests reserve <=153,600 binding attempts and <=300 MiB PUT bytes, including unknown attempts and repeated writes conservatively.

**Not a hard HTTP or billing cap:** rejected authenticated claims still cost one PUT each, and unauthenticated HTTP requests still consume Worker quota. The authorization recipe assumes Workers Free's hard account daily request ceiling and <=1 hour spanning at most two UTC days: <=200,000 total requests in the denial flood case. Thus conservatively <=353,600 binding attempts including admitted worst cases, plus explicitly reserved provisioning/teardown allowance. Account-wide contention matters on a shared account; a separate account is optional, not assumed. Paid tier or changes to request quotas require a new budget calculation. No sustainable service or adversarial availability claim.

The F lab exercised real R2 only for its bounded synthetic flow; it did not
qualify CPU/heap, account headroom or costs as a product envelope. Small note
size does not prove 10 ms CPU/128 MB isolate feasibility. Budget enforcement
does not close G4/G5.

## Two functional deliveries

1. Worker HTTPS admission, one-use R2 tickets, capped binding, stop/expiry and separate build/config, with focused unit/integration tests and ADR/roadmap/runbook. Expected <=10 production/config files, <=700 new production lines (including the shared remote header schema). Independently useful to REST; rollback removes remote composition only.
2. Experimental plugin remote profile, exact endpoint, separate config/state/owner/secret references and verified ticket persistence, separate artifact, with transport/host artifact checks. Expected <=8 production/config files, <=500 new production lines. Depends on delivery 1's ticket header; rollback removes remote artifact without altering local demo or release.

No preparatory or tests-only PRs. Documentation and tests travel with functionality. Stop and split if either exceeds repository limits.

## Acceptance

- Local loopback still rejects remote URLs; remote rejects HTTP, foreign origins, missing expectations, missing registry, stopped/expired config, invalid/reused tickets and permission mismatch before service effects.
- Concurrent and fresh-instance same-ticket requests permit at most one service; lost claim response consumes authority without false success. Binding exhaustion and write-byte exhaustion dispatch no excess call.
- New plugin cannot read local-demo configuration/ledger or borrow its owner; exact endpoint and native-reference stability fence work. Persistent ticket advances before dispatch and survives reload. Redirects fail closed.
- Existing five-flow local artifact demonstration remains green; remote-profile
  transport composes the same durable coordinator. Real Desktop/cloud F evidence
  is recorded separately and only for its synthetic path.
- `mise install`, `mise run check`, semantic review and a concrete authorization
  recipe accompanied implementation. The later, separately authorized F run
  provisioned and removed only temporary synthetic resources; it did not touch
  a personal vault or production sync.
