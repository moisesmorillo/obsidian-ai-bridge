# Remote synthetic lab implementation plan

**Goal:** Deliver REST-capable isolated remote Worker, then its separately built experimental plugin, without operating Cloudflare.
**Architecture:** Reuse the M8 Hono/service/store and durable client; inject an explicitly remote transport profile. Enforce one-use create-only R2 tickets and per-invocation binding ceilings, not a new coordination service.
**Spec:** [Remote contract](../milestones/m8-remote-synthetic-lab.md).
**Execution:** Direct, in this session as requested. No standalone preparatory PR.

## Constraints / review focus

- Exact HTTPS origin; old loopback guards retain default behavior.
- Authentication/permission/identity before ticket storage, including unknown routes.
- Consumed tickets survive lost replies/fresh isolates; no refund/reuse.
- Hard call/write ceilings include preparation/claim and unavailable effects.
- Remote owner/config/ticket keys cannot adopt local experiment state.

## Delivery 1 — REST Worker

Files: new `packages/protocol/src/sync-remote.constants.ts` and export; extend demo app with an injected remote admission capability; export existing marker preparer; new `apps/worker/src/remote/{remote-configuration,remote-budget,index}.ts`; separate Wrangler config and mise build task. No release entrypoint changes.

- [x] RED: configuration expiry/origin/arity tests, concurrent create-only tickets, lost-response no-service, total call/write ceilings; integration request refuses unauthorized/foreign/missing binding before storage.
- [x] GREEN: strict configuration and HTTPS matcher; capped R2 wrapper and one-use claim; Hono admission after existing authentication/schema/permission; standalone composition.
- [x] Verify focused mise tests, canonical check and semantic review (combined candidate; final checkpoint in qualification report).
- [x] Document authorization recipe, ADR exception and corrected M8 completion.
- [x] Commit Worker functionality with its tests/docs only (`5c30843`).

## Delivery 2 — experimental plugin

Files: parameterize `demo-config`, `demo-owner`, `demo-main`, `sync-demo-fetch` with a default local profile; new remote profile/entrypoint and persisted ticket allocator; separate manifest/build task. Local exports/defaults stay loopback-only.

- [x] RED: local rejects HTTPS, remote rejects HTTP/foreign URL; exact remote endpoint Fetch with ticket; read-back failure/exhaustion no Fetch; distinct state and retained owner across replacement.
- [x] GREEN: explicit remote profile, independent configuration key/registry/ledger prefix; verified ticket persistence before dispatch; reuse existing leases and durable coordinator.
- [x] Verify all local five-flow artifact regressions plus remote artifact loading and transport composition without network/cloud.
- [x] Verify canonical check and semantic review; record actual limitations and rollback ([final evidence](../qualification/m8-remote-synthetic-local.md), frozen checkpoint `b9ef76f9d`).
- [x] Commit plugin functionality with tests/docs. No deploy/credential/session lookup.

Both units remain local on `feat/m8-remote-synthetic-lab`; no push, PR, merge or
Cloudflare operation. Integration and remote authorization are separate owner decisions.
