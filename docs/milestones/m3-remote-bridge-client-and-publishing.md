# M3 — Remote bridge client and explicit publishing

**Status: NEXT — planning only; not implementation-ready.**

Depends on completed [M2](m2-obsidian-read-only-local-adapter.md). This handoff
records the next authorized planning work, not an approved publishing design.
The [roadmap](../roadmap.md) owns scope and unresolved decisions;
[AGENTS.md](../../AGENTS.md) owns engineering rules. Refine this specification
and create its corresponding implementation plan under `docs/plans/` before
writing M3 production code. The transition becomes canonical when M2 is merged.

## Intended outcome and boundaries

A user explicitly selects local notes, publishes them to a configured bridge,
and inspects remote state with clear outcomes. Publishing must not silently
lose existing or concurrent remote edits. No local writes/deletes, automatic
bidirectional sync, background queues, delete propagation, MCP or new
infrastructure are authorized by this handoff.

Preserve M2's independent local-only commands and read-only port. Its eligibility
is not upload permission, and path/mtime/size evidence is not a remote revision
or an atomic snapshot. The current M1 API remains experimental, single-token,
unconditional remote CRUD; GET followed by PUT is not a safe publishing protocol.

## Decisions required before implementation

Resolve these with the maintainer rather than inferring policy from M2 or the
current API. Record consequential choices using [ADRs](../decisions/README.md).

| Decision | Required specification evidence |
| --- | --- |
| Selection/default exclusions | Explicit opt-in workflow, persistence (if any), revocation and rules preventing implicit bulk upload |
| Connection and credentials | Worker URL validation, HTTPS/local-development exceptions, token entry/storage/removal, trust and sanitized diagnostics |
| Initial mirror association | Namespace/vault association and handling of already-present remote notes without implied overwrite permission |
| Safe mutation contract | Server-enforced conditional create/update (or another demonstrated safe approach), revision/precondition semantics and race tests for absent and existing notes |
| Trigger and operation bounds | Explicit user triggering, cancellation, bounded timeouts/retries, partial-failure visibility and safe retry behavior |
| Typed remote boundary | DTO/path validation, authentication/network/malformed-response outcomes, and resolution of the M1 runtime/OpenAPI PUT permissiveness gap |

A conditional mutation design must address create-vs-create and edit-vs-publish
races at the server/storage boundary, not only compare client reads. If the
required protocol change materially expands M3, revise the roadmap/spec before
implementation. Do not postpone this prerequisite safety work to M4.

## Planning exit checklist

- [ ] Resolve the decisions above and record any required accepted proposals.
- [ ] Specify user-visible commands/settings, selection/consent, secret handling
  and error/retry/cancellation behavior without ambiguous defaults.
- [ ] Specify request/response and server-enforced concurrency contracts, API
  compatibility and migration behavior; synchronize planned OpenAPI changes.
- [ ] Define application ports and adapter boundaries without coupling core to
  Obsidian, Hono, Cloudflare bindings or persistence implementations.
- [ ] Define deterministic unit/integration cases for absent/existing/concurrent
  content, auth/network failures, malformed responses, cancellation, retries and
  partial completion; retain no-local-mutation and no-secret-output assertions.
- [ ] Replace this handoff with a detailed implementation-ready acceptance
  checklist and write sequential slices/validation tasks under `docs/plans/`.

## Implementation exit criteria to refine

- Explicitly selected notes can be published and remote state inspected.
- Existing/concurrent remote content cannot be silently overwritten or lost.
- No local notes are written, deleted, renamed or force-saved.
- Failures are typed, sanitized, visible, bounded and behaviorally tested.
- Protocol/OpenAPI, security/operational documentation and coverage remain aligned.
- Canonical `mise install`, `mise run install` and `mise run check` pass, followed
  by semantic/security review; no deployment is performed merely for validation.

Full reconciliation history, imports, conflicts/merge resolution, rename/deletion
semantics and durable offline work remain M4. This M2 completion PR includes no
M3 production implementation and selects none of the unresolved policies above.
