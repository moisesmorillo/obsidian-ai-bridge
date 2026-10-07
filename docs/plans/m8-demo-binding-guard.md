# M8 local demo identity expectation guard

## Decision and scope

Author review of delivery 2 reproduced two incorrect ACK bindings against the
actual local HTTP composition: a client configured for a different vault or
participant received `committed` under the authenticated server's identity.
The corrected request fixture used only the valid original mutation tuple;
the earlier extra-field fixture failure was not evidence of this defect.

Add denial-only paired expected-vault/origin headers. Authenticate and select the
participant exactly as before, then validate expectations before service/storage
resolution. Expectations never select authority or grant permissions. Omission
of both remains compatible with the merged REST interface; the durable client
must send both on every request. A separate preflight is insufficient because
its secret/participant can change before dispatch.

This small prerequisite is independent of the durable ledger/client and can be
reverted independently. It changes four production files, no dependencies,
release composition, deployment, host artifact or G1–G6 acceptance. The client
follows as a separate functional PR so neither exceeds ten production files.

## Work unit and verification

- [x] Preserve uncommitted client work in the named Git stash; use a branch from
  merged #111 in the existing checkout. No worktree or machine configuration.
- [x] Add valid identity/partial/malformed/permission regression cases.
- [x] Observe assertion RED, then implement strict shared schemas, guard, CORS
  and schema-derived OpenAPI parameters/error representation.
- [x] Run focused tests, `mise install` and canonical `mise run check`.
- [x] Review authority, input/response privacy, permission independence and
  unchanged runtime composition; document evidence.
- [ ] Publish the guard PR for manual owner merge.
- [ ] Restore client work on the guard commit, send both expectations, translate
  only the strict known binding refusal, rerun actual-HTTP identity regressions
  and the complete canonical gate; publish the functional client PR separately.

## Evidence and semantic closure

Five assertions observed RED (expected 400, received 200); 14 focused API tests,
typecheck and lint then passed. Final gate `bbe15bab2` passed after schema/OpenAPI/
CORS cases: 2,112 fast, 53 native and 12 artifact tests; coverage statements/
branches/functions/lines 95.02/91.48/98.62/96.83%, unchanged thresholds. Build,
Biome assists, type-aware lint and TSDoc checks passed. No deployment occurred.

Post-gate author semantic review confirms selected authenticated authority never
comes from expectations; malformed/mismatched pairs precede service resolution;
matching claims cannot grant write; omission is compatible. Schemas do not repair
or infer authority. Errors omit identity values, content, secrets and stack traces.
No new dependency, weak application typing, deprecated API or unbounded work.
Four production files and under 400 total changed lines, with tests/docs attached.
This is author review, not independent review or desktop/tier qualification.

## Delivery chain

Merged #111 API → **identity guard (this PR)** → durable client → official
experimental plugin/two-vault artifact demonstration.

Owner merges manually. Synthetic Markdown, loopback and disposable namespaces
only; no productive/personal-vault scope, deletion, rename, migration or new MCP.
