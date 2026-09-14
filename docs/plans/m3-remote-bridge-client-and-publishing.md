# M3 implementation plan — remote bridge client and explicit publishing

**Status: PROPOSED / BLOCKED on maintainer approval; no implementation begun.**

Baseline: M2 merged at `b300726` (PR #7). M3 remains NEXT, planning only.
This is the sequential execution companion to the
[M3 specification](../milestones/m3-remote-bridge-client-and-publishing.md).
The [decision brief](m3-design-decisions.md) is the approval agenda, not a record
of consent. [ADR 0002](../decisions/0002-conditional-remote-note-mutation.md) and
[ADR 0003](../decisions/0003-publishing-association-and-local-state.md) are Proposed.
No production slice may start while D1–D6 are unresolved. Rework affected slices
if the maintainer chooses different options; do not let implementers silently
select a product policy by which test they write first.

## Execution rules and dependencies

Follow numbered order, one coherent green slice/commit at a time. Existing M2
inspection remains read-only and independent; only explicitly approved M3 changes
may alter its no-persistence/no-network composition context. Commands remain thin;
core does not import protocol/platform APIs; protocol may depend on public core
path contracts; remote adapter has no local mutation capability.

A1–A11 below refer to the specification's implementation acceptance checklist.
Every slice must run `mise run test`, `mise run typecheck`, `mise run lint` and
`mise run biome:check` after its focused tests. Use canonical `mise run check` at
slice handoffs; never rely on a direct package-tool command as the workflow.
Keep all production source in V8 inclusion; do not lower thresholds or add empty
assertions to preserve them. Record actual evidence in this plan during future
execution, not anticipated pass counts. No deployment, vault installation or
production credential is needed for any automated step.

### 0. Approval and platform qualification gate

- **Objective:** close D1–D6 and verify that the selected mechanism can actually be
  implemented with the supported host/storage APIs before application behavior.
- **Relevant existing files:** M3 spec/decision brief/ADRs, M2 spec/plan,
  `apps/obsidian-plugin/manifest.json`, plugin `tests/artifact/main.test.ts`,
  Worker `wrangler.jsonc`, `r2.types.ts`, `.mise.toml`, `bun.lock`.
- **Expected changes:** accepted/refined docs; narrowly scoped Worker runtime
  conditional test under `tests/integration/`; direct locked dev test dependency
  only if necessary; a canonical `worker:storage-test` task/config if runtime
  tests need a separate runner. Wire into check/CI through mise, not YAML duplication.
- **Contracts/types:** actual R2 onlyIf Headers wildcard/ETag/null semantics;
  Fetch redirect/error/abort/stream API availability; supported host minimum and
  CORS policy. Do not claim runtime support from a TypeScript signature alone.
- **Tests first:** local R2 absent create, refused duplicate create, matching/stale
  ETag update, same-text envelope bytes getting a new validator; no remote account.
  Establish contract tests for Fetch/CORS over a disposable local HTTP boundary
  where practical. Host qualification checklist covers supported desktop/mobile
  versions; record actual evidence or explicitly leave support unqualified.
- **Steps:** record maintainer choices; verify runtime dependency alignment with
  locked Wrangler/workerd rather than import transitive internals; implement only
  test harness for storage capabilities; revise design if predicates fail. Preserve
  minimum manifest unless a specific approved choice changes it. If real hosts
  are unavailable, do not claim that compatibility gate has passed.
- **Failure cases:** unsupported wildcard, ETag equality assumptions, incompatible
  runtime dependency, missing browser capabilities, no demonstrated redirect control.
  These block affected implementation, not invite a requestUrl/DB fallback.
- **Boundaries:** test-only platform experiment, no publishing service/commands;
  no deployment or production token. Official documentation plus local R2 evidence
  does not become a live Cloudflare test claim.
- **Validation:** `mise install`, `mise run install`, named new runtime task,
  `mise run check`; inspect artifact and production type boundary.
- **Acceptance:** planning readiness gate; prerequisites for A4/A8/A10.
- **Non-goals:** product implementation, data migration, compatibility claims for
  untested hosts, infrastructure deployment.

### 1. Shared remote and conditional contracts

- **Objective:** make domain/wire states authoritative and validate real path
  contracts without disturbing the currently assembled M1/M2 behavior.
- **Relevant existing files:** `packages/core/src/index.ts`, `note-path/`,
  `vault/{note-service.types.ts,vault-repository.port.ts,vault.types.ts}`;
  `packages/protocol/src/{api.schemas.ts,api.types.ts,protocol.constants.ts,index.ts}`;
  protocol/core `tests/unit/`, workspace package/tsconfig/Vitest alias configuration.
- **Expected changes:** cohesive core `remote-bridge/`, conditional storage contracts
  and publishing-state type modules; protocol v2 schemas/constants; explicit public
  core dependency in protocol and public exports. Keep legacy DTO exports until
  Worker slice migrates callers. No circular core→protocol dependency.
- **Contracts/types:** branded validated revision, absence/matching requirement,
  conditional storage/read results, RemoteBridge port, cancellation/settlement
  contract, failure/effect discriminants; shared NotePath schema from real predicate.
- **Tests first:** valid/invalid literal paths (including unsafe encodings and
  percent preservation); UUID/strong validator contract; malformed list/write/read
  metadata; impossible precondition/status combinations and full discriminant
  exhaustiveness in consumers. Runtime constants stay out of *.types.ts.
- **Steps:** introduce minimal public types; derive DTOs from schemas; name semantic
  routes/headers/status-independent states once; document contracts/TSDoc; update
  legacy response path schema to actual validity without changing valid payloads.
- **Failure cases:** invalid/weak/multiple validators, invalid returned path,
  schema-only string acceptance, duplicate semantic policy, unchecked JSON casting.
- **Boundaries:** no HTTP/Cloudflare/Obsidian imports in core; schemas use public
  core exports; no local write or remote delete in RemoteBridge.
- **Validation:** common focused tasks, `mise run coverage`, `mise run check`;
  verify package dependency/alias resolution in both existing bundles.
- **Acceptance:** A3/A5/A6 contract groundwork, not yet operational publishing.
- **Non-goals:** no enabled v2 route, storage rewrite, UI, token handling or adoption.

### 2. Conditional Worker/R2 path and coherent API transition

- **Objective:** deliver the complete safe remote primitive before any plugin can
  publish. Keep each note's content/revision atomic and remove unsafe API bypass.
- **Relevant existing files:** Worker `app.ts`, `app.types.ts`, `index.ts`, HTTP
  handlers/OpenAPI/authentication/dependency middleware/responses/constants;
  `infrastructure/{r2.types.ts,r2-vault.repository.ts,r2.constants.ts}`; core vault
  service/port; Worker/core unit and integration tests and runtime harness from 0.
- **Expected changes:** R2 envelope codec module, conditional repository adapter,
  core conditional service, v2 handlers/routes, v1 retirement handler, shared
  raw-note read/list decoding, v2 CORS, error mappings; `docs/api.md`, current-state
  and architecture reflecting Worker change while plugin is still M2-only.
- **Contracts/types:** ADR 0002 exact envelope/marker/revision bound, legacy-read
  result; constructed R2 conditions; 200/201/412/428/410 contracts, no arbitrary
  user headers passed to R2. V2 uses same namespace, not a second mirror.
- **Tests first:** spec D1–D10 conditional scenarios, specifically barrier between
  adapter read and conditional put with editor still competing. Retain winner's
  full object bytes and metadata assertions. Legacy content that looks like JSON
  must remain raw; malformed/oversized marked envelope fails, never absent.
  Add v1 PUT retirement, old Worker v2 refusal, v2 auth/unknown-prefix, CORS,
  optional-zero-body/required-media, strict preconditions, schema and OpenAPI tests.
- **Steps:** implement storage codec and CAS; remove service exists→write algorithm
  from active mutation path; support raw legacy reads and envelope-aware lists;
  expose v2 while disabling all v1 PUT mutations in the **same slice**; generate
  updated OpenAPI/Scalar; document writer upgrade and unsupported old-code rollback.
  Report success revision from stored result, never subsequent HEAD.
- **Failure cases:** null conditional result, read/put exceptions, legacy/unknown
  format, oversized escaped envelope, missing target, stale same-content revision,
  malformed body/precondition, post-write transport failure and unauthorized calls.
- **Boundaries:** handlers→service→conditional port→R2; storage JSON private to
  adapter; CORS isn't auth; logging uses existing sanitized LogTape integration.
- **Validation:** common focused tasks, `mise run worker:storage-test` if added,
  `mise run coverage`, `mise run build`, `mise run check`; inspect generated OpenAPI
  semantics, not only a route-name substring assertion.
- **Acceptance:** A4/A5 and server portion of A3/A6/A9. This larger atomic slice is
  necessary: deploying partial envelope writers without compatible readers or
  leaving unconditional writers reachable would not be a coherent safe state.
- **Non-goals:** no automatic raw-object migration/adoption, v2 DELETE, tombstones,
  history, database, plugin publishing or actual deployment.

### 3. Validated local publishing state and session configuration

- **Objective:** add non-content metadata persistence and session credential/config
  boundaries without triggering publishing or changing local files.
- **Relevant existing files:** core local eligibility/index; plugin main and
  infrastructure host bridge, unit/support host double; plugin manifest and types;
  Obsidian loadData/saveData official declarations.
- **Expected changes:** core publishing state port/types/policy; plugin
  `settings/` state codec/store and origin/session-credential adapters; host fake
  load/save/deferred persistence support and unit tests. Composition can remain
  unused until UI slice; don't introduce enable-time network calls for testing.
- **Contracts/types:** schemaVersion=1, origin/dev flag, individual selections,
  acknowledged revisions and single unresolved-attempt union. Token never in
  DTO. Missing-state versus malformed/unknown-version outcomes are distinct.
- **Tests first:** spec A/B consent/configuration/persistence cases; serialized
  competing saves, load/save rejection, malformed fields and future schema,
  token absence in serialized bytes, origin reset and revocation failure. Test
  original host weak data narrowed immediately before it enters application code.
- **Steps:** pure selection policy over exact paths; explicit URL parsing including
  pre-canonical loopback checks; implement one state owner serializing entire
  read-current/apply/persist transitions, not stale snapshots queued for disk writes;
  isolate loadData/saveData and token lifetime; no generic unsafe settings merge; define
  reset behavior that waits for outstanding work rather than overwriting its state.
- **Failure cases:** invalid endpoint/selection/revision, save failure before or
  after write acknowledgment, stale save overwriting revocation, credential removal.
- **Boundaries:** no settings JSON/platform objects or token in core; no storage of
  local note content; no new local mutation method; no settings-tab deprecation.
- **Validation:** common focused tasks, `mise run coverage`, `mise run check`.
- **Acceptance:** A1/A2/A7 foundations; actual UX integration remains slice 6.
- **Non-goals:** no plaintext/native persisted token unless D2 was explicitly
  changed; no selection folders, watchers, background configuration checks or UI.

### 4. Typed bounded HTTP remote adapter

- **Objective:** implement RemoteBridge over approved v2 without letting transport
  concerns or unsafe fallback reach publishing logic.
- **Relevant existing files:** new core/protocol contracts, plugin package exports/
  dependencies and Vitest configuration, Worker contract fixtures from slice 2.
- **Expected changes:** plugin `infrastructure/remote-bridge/` HTTP adapter,
  transport/media/body/response validation modules as cohesive responsibilities;
  deterministic Fetch transport doubles and adapter unit tests.
- **Contracts/types:** list/read/conditional publish outcomes, separate effect
  certainty, URL/token binding and per-request cancellation/deadline settlement;
  exact response path/revision/status equality; bounded response streams.
- **Tests first:** spec C status/media/schema/UTF-8/path matrix, 1 MiB note / 2 MiB
  JSON response limits, hanging stream, wrong content length, redirect denial,
  token removal, malformed errors, abort and non-cooperative underlying transport;
  assert no v1 fallback and no local host access. Use synthetic tokens and bodies.
- **Steps:** inject a narrow HTTP execution seam for tests; construct canonical v2
  addresses using shared encoder; attach bearer only in adapter; disable cookies/
  redirects; validate streamed bytes then schemas/metadata; map failures to closed
  outcomes without raw response or exception text; expose actual settlement.
- **Failure cases:** 401/403/404 by method/412/428/429/5xx, unavailable network,
  timeout/cancel before/after dispatch, malformed success and old protocol server.
- **Boundaries:** adapter imports public core/protocol; commands never fetch or
  construct Worker DTOs; remote adapter never obtains a mutable vault capability.
- **Validation:** common focused tasks, `mise run coverage`, `mise run build`,
  `mise run check`; no real endpoint/token.
- **Acceptance:** A5/A6/A9 transport; no claim of real-host qualification from fakes.
- **Non-goals:** automatic retry, transport fallback, remote DELETE, queue, UI or
  direct R2 access.

### 5. Core explicit publishing and remote inspection services

- **Objective:** implement the single-note workflow, consent checks, baseline
  authority and conservative ambiguous/partial-failure behavior over ports.
- **Relevant existing files:** core read-only local port, eligibility service,
  new RemoteBridge/PublishingStateStore contracts, core unit tests; M2 adapter
  returns transient saved content already bounded with best-effort change checks.
- **Expected changes:** core `publishing/` and remote inspection application
  modules/constants/types; unit tests with deferred local/remote/store ports.
- **Contracts/types:** not-selected/local-refused/preparing/sending/recording/
  terminal effects; original condition from acknowledged state only; single
  unresolved attempt; one explicit in-memory known-update replay budget (no ambiguous
  create replay); awaiting-retry-decision versus terminal snapshot disposal;
  content-free UI result.
- **Tests first:** spec A, B and D7–D9 port-level workflows: no publish for eligible
  unselected paths; pending read revoked before send; existing baseline stale/missing;
  pre-send save refusal; ACK save failure; dropped ACK followed by 412; no GET-based
  baseline promotion; original update content/precondition replay, create→lost ACK→
  external delete without replay, and unload/terminal snapshot loss.
- **Steps:** guard consent/local eligibility before read; capture/read saved snapshot;
  persist unresolved metadata before dispatch; recheck consent/cancel after awaits;
  send absent or last-ACK matching condition; record validated result before success;
  keep ambiguous state blocked. Remote inspection strips bodies and never changes
  consent/baselines. Separate operations/state policy from presentation handling.
- **Failure cases:** local changed/missing/oversized, state failures, unknown effect,
  lost snapshot, selection/token/destination generation changes, definite rejection
  after earlier ambiguous request, remote missing with known baseline.
- **Boundaries:** no Fetch/AbortController/Obsidian/Hono/R2 APIs in services, no local
  mutation or HTTP status codes; no duplicate M2 eligibility/path policy.
- **Validation:** common focused tasks, `mise run coverage`, `mise run check`;
  inspect test awaits to ensure revocation and persistence races remain pending.
- **Acceptance:** A1/A3/A6/A7/A9 application behavior.
- **Non-goals:** batches, importing/merging/adopting existing data, durable body
  persistence, automatic retry/replay, deletion or rename handling.

### 6. Commands, text-only configuration/selection UI and lifecycle integration

- **Objective:** expose the approved manual workflow while retaining M2 and truthful
  operation versus presentation lifetimes.
- **Relevant existing files:** plugin `main.ts`, `inspection/`, infrastructure
  composition, unit `main.test.ts`, integration `local-inspection-commands.test.ts`,
  support host runtime/plugin fixture and negative side-effect assertions.
- **Expected changes:** small publishing/configuration/selection modal/UI modules,
  command constants, lifecycle/coordinator modules where conceptually needed;
  main composition and integration tests. Update M2-only guards narrowly: settings
  load now permitted, network only after explicit remote commands/confirmation.
- **Contracts/types:** spec command IDs, result rendering, cancellation intent,
  plugin-instance operation guard distinct from enable-session UI identity;
  no late completion rebinding to a new origin/credential/selection snapshot.
- **Tests first:** keep read/network/save pending across unload/re-enable before
  resolution; busy/no-start assertions, stale UI suppression and later recovery.
  Test real adapter/service composition, active-file capture during pane changes,
  one-note confirmation only, remove-all-selection not select-all, token removal
  during read, modal close/cancel, no enable-time scan/network, sanitized errors.
  Recreated-instance pending metadata case must not silently send after restart.
- **Steps:** load validated state without network; compose ports/services; register
  approved commands; implement explicit config modal with masked non-refilled input;
  implement selected-path management/confirmation/progress; retain guard through
  actual settlement and serialize state loading; unload suppresses UI and future
  dispatch, not claimed host/remote rollback. Document hot reload/host limits.
- **Failure cases:** settings loading unavailable, busy/cancel, discarded modal,
  pending network after abort, post-unload save, reset during work, wrong protocol.
- **Boundaries:** UI invokes services, never fetch/repository; captured path is
  literal; text rendering only; existing local-inspection command results unchanged.
- **Validation:** common focused tasks, `mise run coverage`, `mise run check`.
- **Acceptance:** A1/A2/A6/A7/A8/A9 complete observable behavior.
- **Non-goals:** batch progress, scheduler, settings-tab version creep, HTML/body
  previews, M4 UX or automatic recovery of unresolved state.

### 7. Generated artifact and operational contract validation

- **Objective:** verify that bundling/host adaptation preserves security-sensitive
  remote/settings behavior and document actual installation/upgrade limitations.
- **Relevant existing files:** `.mise.toml`, plugin build/smoke configs and artifact
  `main.test.ts`/tsconfig, plugin manifest, root coverage, Worker OpenAPI/runtime
  tests, `README.md`, `SECURITY.md`, `docs/plugin-development.md`, `docs/api.md`.
- **Expected changes:** proportional extension of generated bundle host double with
  web transport/settings APIs; updated operational instructions and task descriptions.
  No generated files committed and no runtime Node dependencies.
- **Contracts/types:** actual CommonJS default export and externals; approved minimum
  manifest; v2 request shape and no token serialization after runtime transformation.
- **Tests first:** actual generated bundle inert enable (except metadata load),
  configure/select/confirm one publish, token absent from stored/UI output, correct
  conditional request through injected Fetch, unload/re-enable pending operation.
  Do not import source entry or replace behavioral tests with an artifact snapshot.
- **Steps:** extend only transformation-sensitive cases, run dry-run Worker bundle,
  inspect generated OpenAPI, preserve source coverage separately, document disposable
  local setup and loopback/TLS caveats, token rotation/removal and legacy writer
  retirement/old-code rollback risks. Record host tests actually performed; an
  unavailable real host stays an explicit qualification limitation.
- **Failure cases:** accidental Node global, missing browser API, bundled schema
  drift, unmasked token/settings leak, wrong export, misleading cancellation claim.
- **Boundaries:** build tooling may use Node; production plugin may not; no deployment
  or installation into a real vault as part of canonical validation.
- **Validation:** `mise run build`, `mise run plugin:smoke`, runtime storage task,
  `mise run coverage`, `mise run typecheck`, `mise run check`.
- **Acceptance:** A8/A9/A10 generated/runtime/operational evidence.
- **Non-goals:** mechanically duplicating all unit cases, new E2E infrastructure,
  live-cloud tests or unsupported desktop/mobile claims.

### 8. Full validation, semantic/security review, documentation and PR

- **Objective:** finish only M3 with independently inspectable evidence, not just
  green tests. A failed/unqualified safety gate keeps M3 active.
- **Relevant existing files:** all changed production/tests/docs, AGENTS,
  CONTRIBUTING, CI, coverage/editor configuration; complete M3 checklist/ADRs/plan.
- **Expected changes:** fixes to concrete findings, synchronized README/current-state/
  architecture/API/SECURITY/plugin operations, evidence ledger and completion status;
  M4 planning-only handoff when and only when every M3 acceptance criterion is met.
- **Contracts/types:** final API/schema/behavior alignment, inward boundaries,
  supported versions, exact lifecycle/secret/conditional safety invariants.
- **Tests first:** turn any concrete review defect into the exact failing regression
  before repair; preserve competing operations inside the original harmful window.
- **Steps:** run `mise install`, `mise run install`, `mise run check`; inspect all
  four coverage metrics and unimported-source inclusion; check lint/types/Biome
  assists/deprecations and configured editor diagnostics. Review generated/runtime
  evidence. Load and use the **code-review skill** after checks pass: inspect
  responsibility boundaries, typing/TSDoc, semantic policy duplication, harmful
  interleavings, secrets, stale saves, API downgrade, rollback, M4 scope leakage
  and every negative capability. Resolve every concrete finding or explicitly
  document a technically justified permitted deferral; no manufactured findings.
  Synchronize docs to actual implementation, not the originally proposed design.
  Record exact tested commits and limitations. Create focused commit(s), push branch
  and open implementation PR against main; **do not deploy or merge**.
- **Failure cases:** any acceptance gap, unexplained diagnostic, unproven storage
  predicate, misleading host compatibility, stale docs, token/content exposure or
  incomplete review. Keep M3 NEXT until complete; do not begin M4 production code.
- **Boundaries:** review does not silently approve a new product/security choice;
  changed consequential decisions require ADR update/maintainer review.
- **Validation:** full canonical commands above, `git diff --check`, local document
  link check, final diff/secret review and CI results for the actual PR head.
- **Acceptance:** A1–A11 final check; only completion evidence authorizes M3 COMPLETE
  and M4 NEXT in a completion PR, canonical when merged.
- **Non-goals:** deployment, real vault mutation, merging own PR or any M4 code.

## Planning-session evidence

- Baseline verified in ordered documentation/source/test/tooling reads: M2 COMPLETE,
  M3 only NEXT and initially planning-only. Work branch `plan/m3-remote-publishing`.
- Added this gated plan, a detailed conditional specification, decision brief and
  two Proposed ADRs. No production/tests/configuration/lockfile change is authorized
  or included by planning. Recommendations await maintainer decisions D1–D6.
- `mise install`, `mise run install` and `mise run check` passed on the planning
  working tree: 21 source files / 250 tests and 1 artifact file / 3 tests; coverage
  statements 96.75%, branches 93.75%, functions 95.96%, lines 97.04%. Biome formatting/
  lint/assists, type-aware lint, all typechecks and both non-deploying builds passed.
  Source/coverage/threshold/configuration files are unchanged. These checks validate
  the current M1/M2 baseline, not a nonexistent M3 implementation.
- Initial check failure: Biome encountered JSON generated by an optional Fusion
  reasoning run. That auxiliary run failed before evaluation with a prompt-budget
  error and produced no verified synthesis; it is not review evidence. Its artifacts
  were preserved under the existing ignored local task directory, and the canonical
  check passed on rerun. No committed ignore/tooling change was made.
- Post-green manual review used the `code-review` skill, PR/semantic checklists and
  TypeScript profile against the actual docs and relevant source/tests/configuration.
  Reviewed boundaries, consent/credentials, state ownership, same-text ABA, old-server
  downgrade, cancellation/late commit, stale saves, exact race tests, migration and
  M4 non-goals. Draft refinements explicitly prohibit ambiguous-create replay after
  create→delete, serialize entire state transitions rather than stale snapshot
  saves, separate retry-decision from terminal content disposal, and require old
  writers to drain before a future storage-format rollout. No concrete finding is
  left unresolved in the **blocked proposal**.
- Skill verdict: **APPROVE WITH NOTES for the documentation-only proposal**, not
  approval to implement. D1–D6 remain unapproved; spec is NOT implementation-ready.
  Host transport qualification and local R2 runtime tests remain future slice 0
  gates. No separate editor, desktop/mobile host, deployed Cloudflare or real-vault
  session was exercised. Configured editor manifest schema is unchanged/inspected.
- `git diff --check` and local Markdown file-link validation passed. Final publication
  must re-run the canonical gate on the committed docs, push the planning branch
  and open a **draft** PR against main; no merge or deployment.
