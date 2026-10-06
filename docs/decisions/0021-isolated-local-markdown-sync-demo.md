# ADR 0021 — Isolated local Markdown sync demonstration

## Status

**Accepted by the owner; canonical on the specification PR's merge.** This adds
only a synthetic local-development exception to ADR 0020's exposure gate. It does
not supersede M7 storage authority or accept the complete ADR 0016 product target.

## Context

Merged #109 (`e1297d6`) extends isolated store tests but does not connect Worker,
plugin and API clients. The owner requests a useful Friday 9 October demonstration
without Cloudflare access, deployment, personal-vault use or more test-only PRs.
No milestone followed M7 private delivery. Local composition needs explicit
permission rather than silently treating outstanding qualification as passed.

## Decision

Make [M8](../milestones/m8-local-markdown-sync-demo.md) NEXT on merge: three
functional deliveries connect the existing SyncStore to a separate local Worker
and experimental plugin artifact. Use synthetic Markdown, at most three admitted
paths, independent lab credentials, explicit Sync now and REST first. Preserve
both concurrent versions and show conflict attention. No deletes, renames,
migration or new MCP capability.

The exception permits loopback-only synthetic exposure and explicitly armed
local effects in disposable vaults, or two isolated simulated plugin instances
when suitable disposable desktop hosts are unavailable. The existing release
Worker routes, deploy configuration, plugin entrypoint and writer remain unchanged.
Experimental entrypoints must not be imported or bundled into release artifacts;
focused checks must demonstrate this isolation. No stable release or deployment
is authorized from the demo branch.

G1–G6 remain OPEN for public/productive exposure and real data. Applicable safety
defects in the exercised local path block the demo. Local evidence cannot close
real R2, Workers Free, mobile, backup or cutover requirements. Acceptance authorizes
implementation only after this specification PR merges; routine implementation
choices within the scope need no renewed owner approval.

## Consequences

M8 can demonstrate a connected revision domain and exact-base conflict behavior
without claiming operational qualification. Report actual host/artifact identity
and distinguish simulated integration from a real desktop-vault demonstration.
Full-vault recovery/enrollment and production activation remain separately gated.
Rollback removes only the experimental composition; no legacy state or namespace
is adopted or rewritten.

## Alternatives

- Complete every remote G1–G6 experiment first: outside the authorized local demo
  scope and impossible without separate resource approval.
- Reuse v2/M4 manual reconciliation as the demo: does not demonstrate the requested
  automatic exact-base application in the SyncStore revision domain.
- Expose sync through current release routes/settings: rejected; it risks accidental
  activation and changes supported behavior before qualification.

## Evidence / related documents

- [M8 specification and work units](../milestones/m8-local-markdown-sync-demo.md)
- [Roadmap](../roadmap.md)
- [ADR 0020](0020-private-sync-store-delivery-and-activation-gate.md)
- [Open activation gates](../qualification/m7-delivery-and-activation-gate.md)
