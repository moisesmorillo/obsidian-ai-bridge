# M2 implementation plan — read-only local inspection

**Status: COMPLETE — implemented in sequential slices and semantically reviewed.**
Publication and the canonical milestone transition occur through the completion PR.
Created from the approved
[M2 specification](../milestones/m2-obsidian-read-only-local-adapter.md).
The [roadmap](../roadmap.md) owns scope/status; [AGENTS.md](../../AGENTS.md)
owns engineering rules. This plan was absent in the M1 checkout and is added
with maintainer authorization before production changes.

## Invariants and implementation decisions

- Implement M2 only. Preserve M1 Worker/R2 behavior, wire contracts, manifest
  identity, minimum Obsidian version and non-desktop-only declaration.
- No network, settings/persistence, automatic inspection, local mutation or sync.
- Reuse core's literal `isNormalizedNotePath` predicate and 1 MiB byte limit.
  Never URI-decode or repair an Obsidian path.
- Centralize local eligibility in core: unsupported extension, excluded location,
  invalid path, oversized metadata, in that precedence order. The adapter supplies
  the host configuration-directory boundary; dot-prefixed segments are excluded.
  Invalid host size/stat metadata must fail closed, not become an eligible entry.
- Core owns a narrow enumerate/read port, closed outcomes, metadata-only inspection
  service and deterministic lexical sorting. The port may transiently return text;
  the service strips it before returning a read result to the plugin.
- The Obsidian adapter alone owns host lookup, saved-file read and identity/stat
  evidence. Capture primitive path/mtime/size values before awaiting, then compare
  exact object identity and fresh lookup/stat values afterward. Observed changes
  fail safely; this is not an atomic snapshot or a write revision.
- Commands capture the active path at invocation, serialize work with an ephemeral
  busy state, and suppress results after unload. Render only metadata as text.
- Use official compatible Obsidian APIs and a small strongly typed host fake.
  Do not introduce a UI framework or a runtime dependency to simplify tests.

## Sequential slices

Complete and validate each slice before starting the next. Record actual evidence
below; do not mark the milestone complete based on an intermediate slice.

### 1. Core local inspection policy and contracts

- Add cohesive `packages/core/src/local-vault/` modules for typed outcomes,
  constants, eligibility, read-only port and application service; expose through
  the public core index. Keep platform/HTTP objects out of core.
- Add core unit tests first for policy precedence, exact literal names, unsafe
  paths/encodings, size policy, sorted/empty lists, no-active input, port failures,
  and content-free application results.
- Validate: `mise run test`, `mise run typecheck`, `mise run lint`,
  `mise run biome:check`. Fix introduced diagnostics before handoff.

### 2. Official Obsidian read-only adapter

- Add the minimal host boundary and adapter under the plugin infrastructure seam.
  Register the plugin Vitest project and a test-only alias for shared host fakes.
- Enumerate metadata without body reads and provide closed skipped counts.
  Resolve exactly the validated saved file, enforce exclusions and pre-read size,
  read once, measure actual UTF-8 bytes and compare identity/path/mtime/size.
- Test custom configuration boundaries, exact lookup, inaccessible host APIs,
  empty/exact/oversized/multibyte content, misleading stats, disappearance,
  replacement, rename and edit races. Assert no alternative reads or mutation.
- Validate: `mise run test`, `mise run typecheck`, `mise run lint`,
  `mise run biome:check`, `mise run coverage` (unchanged global thresholds).

### 3. Commands, lifecycle and metadata-only UI

- Replace the scaffold with a default Plugin subclass and thin composition root.
  Register only `inspect-local-notes` and `inspect-active-note`.
- Add a list modal with exact text paths/bytes and eligible/skipped counts,
  including an explicit empty result. Active results contain path/UTF-8 byte count
  and saved-file guidance; all expected failures have sanitized notices.
- Busy/unloaded state stays in the plugin. No host scan/read on load, no settings,
  late result UI, content rendering, logging, automatic retry or editor saving.
- Test registration, capture, busy/release, failures, unload, text-only rendering,
  and negative side effects. Add focused integration tests composing commands,
  core service and adapter over an in-memory host; verify unchanged vault/state.
- Validate: `mise run test`, `mise run coverage`, `mise run typecheck`,
  `mise run lint`, `mise run biome:check`.

### 4. Loadable artifact and development instructions

- Update mise plugin packaging to Obsidian-compatible CommonJS with the default
  class exposed in the host-expected export shape, `obsidian` external, manifest
  staged alongside `main.js`. Keep Node access in build/tests only.
- Add a focused artifact smoke task loading the actual bundle with a host double;
  verify class/commands, inert load, lifecycle and staged manifest. Include it in
  canonical build/check without a deploy or installed vault dependency.
- Document build, deliberate disposable-vault install/enable/commands/unload/
  removal, saved-file semantics, expected UI and host-test limitations. Verify
  used APIs against installed types and official compatibility evidence; do not
  claim desktop/mobile runtime tests unless actually performed.
- Validate: `mise run build`, `mise run plugin:smoke`, `mise run check`.

### 5. Semantic review, completion evidence and PR

- After automated checks pass, review the actual diff for responsibility and
  package boundaries, unsafe typing, deprecations, TSDoc quality, semantic values,
  duplicated policy, unnecessary dependencies/control flow, privacy, mutation,
  host packaging and configured editor diagnostics. Resolve every concrete finding
  or document a justified deferral; green tests alone do not satisfy this slice.
- Synchronize README, architecture, current-state and security/development docs.
  Record final test counts, coverage, artifact results and untested host limitations
  in M2 and this plan. No new ADR is needed unless a consequential decision beyond
  the already approved M2 architecture is discovered (escalate before coding it).
- Only when all M2 criteria pass, mark M2 COMPLETE and M3 NEXT, update active links,
  and add a planning-only M3 handoff spec listing unresolved selection/settings/
  safe conditional-publishing decisions. No M3 production implementation.
- Run `mise install`, `mise run install`, `mise run check` on the final changes;
  inspect final diff and clean git state after focused commits. Open a focused PR
  against `main`, reporting local validation, review and limitations. Never deploy.

## Evidence ledger

Entries below describe each slice at its own handoff; later entries supersede
its pending work/review notes. Slice 5 records final acceptance.

- Planning baseline: clean `main` at `635d24a`; active M2 spec exists, but
  `docs/plans/` did not. Work branch: `feat/m2-local-inspection`.
- Bootstrap: `mise install` and `mise run install` passed. Initial `mise run
  check` failed because Biome scanned gitignored Pi runtime JSON (six formatting
  diagnostics), not application source. Enable Biome Git ignore integration and
  ignore subagent runtime artifacts before rerunning; keep project configuration
  trackable. This prerequisite keeps local and CI source checks aligned.
- Baseline validation after tooling correction: `mise run check` passed;
  15 files / 105 tests, statements 95.16%, branches 90.29%, functions 94.31%,
  lines 95.69%. Worker dry-run and existing plugin scaffold bundle passed.
- Slice 1: implemented core-only local eligibility, closed outcomes, the
  `ReadOnlyLocalVault` port and metadata-only `LocalInspectionService`, with public
  exports and two new unit suites (59 new cases; 17 files / 164 tests total).
  Literal names are preserved; unsupported/excluded/invalid path checks precede
  size policy. Supervisor-confirmed clarification: negative, fractional,
  non-finite or unsafe-integer size metadata on otherwise eligible files yields
  `unavailable`; enumeration must fail unavailable, not invent a skip category.
  Earlier path-policy skip reasons still win. The adapter receives this policy
  through core exports and supplies the exact configuration-directory input.
  TDD red run failed on absent exports as expected; final `mise run test`,
  `mise run typecheck`, `mise run lint` and `mise run biome:check` passed after
  resolving new TSDoc/format/import-order diagnostics. `mise install` and the
  additional complete `mise run check` passed (including both non-deploying
  bundles and coverage). Global coverage: statements 95.73%, branches 92.12%,
  functions 94.73%, lines 96.14%; new local behavior has 100% across all four.
  Post-check writer semantic review found no blockers: core imports stay inward,
  no unchecked casts/weak typing, no new dependencies or host/HTTP objects,
  unchanged M1 policy, closed failures, no content in service outputs, no runtime
  logging/network/persistence/mutation, and bounded straightforward control flow.
  Configured diagnostics are clean; no separate editor or real-host session was
  exercised. Independent reviewer gate remains required. Adapter/commands and
  host race/UTF-8 measurement enforcement remain for later slices, not claimed
  by this core-only completion.
- Slice 2: implemented the narrowly typed saved-file host boundary, official
  Obsidian API bridge and `ObsidianLocalVault` adapter. Metadata enumeration
  reads no bodies and preserves core skip precedence; exact reads enforce local
  exclusions, pre-read size/finite timestamp validation, one saved-file read,
  measured UTF-8 size and post-read object/path/size/mtime equality. Observed
  changes return `changed_during_read` before post-read payload classification;
  equality preserves the prevalidated path/size policy. Failures expose no content,
  path or raw exception. The adapter's `policy` is shared with the service during
  future command composition. No commands/runtime UI, mutation, network,
  persistence, dependencies, Worker or protocol changes were introduced.
  Registered the plugin Vitest project and named test-support alias; added a
  strongly typed mutable host fake and two unit suites (51 new cases; 19 files /
  215 tests total). Cases cover metadata-only enumeration/skip counts, custom
  directory boundaries, exact percent/space/Unicode identities, missing/folder
  paths, empty/exact/oversized ASCII and multibyte bodies, misleading/invalid
  metadata, deferred disappearance/replacement/rename/edit/size races, host
  exceptions, sanitized results, unchanged saved files and no alternative reads.
  Initial discovery needed the core alias in the plugin project; the subsequent
  TDD red run failed on the absent adapter as expected. Final `mise run test`,
  `mise run typecheck`, `mise run lint`, `mise run biome:check` and `mise run
  coverage` passed after resolving introduced type, documentation and formatting
  diagnostics. Additional `mise install` and complete `mise run check` passed,
  including unchanged non-deploying bundles. Coverage: statements 96.20%, branches
  93.15%, functions 95.19%, lines 96.56%; both new production implementation
  modules have 100% across all four metrics, with unchanged global thresholds.
  Post-check writer semantic/security review found no blockers: public core
  imports only, no weak typing/casts, shared policy rather than duplicate rules,
  primitive pre-await evidence, typed sanitized failures, no sensitive logging,
  no runtime filesystem/network/settings/mutation capability and no new dependency.
  Installed official types confirm `getFiles`/`read`/`TFile` since 0.9.7,
  `configDir` since 0.11.1 and `getAbstractFileByPath` since 0.11.11; the latter
  avoids `getFileByPath` (1.5.7), preserving the manifest's 1.5.0 minimum.
  Configured diagnostics are clean; no separate editor, desktop/mobile host or
  installed-vault test was exercised. Metadata remains best-effort, not atomic
  read/write concurrency evidence. Independent reviewer gate remains required;
  command/lifecycle integration and loadable artifact checks remain later slices.
- Slice 3: replaced the scaffold with the default `AiBridgePlugin` class and
  thin read-only composition. Exactly two host-owned command definitions are
  copied before registration (Obsidian qualifies their IDs). Active inspection
  captures the literal path synchronously at invocation; both commands share one
  busy state, release it in `finally`, and suppress late success/failure UI by
  enable-lifetime identity after unload or re-enable. Unload releases session/UI
  references and closes owned notices/modals without promising read cancellation.
  The list modal shows sorted exact text paths, byte metadata, eligible/skipped
  totals and every skip category, including explicit empty results. Active notices
  show only path/measured UTF-8 bytes and saved-file guidance; all closed failures
  and unexpected exceptions have sanitized text. Closing a modal clears its
  metadata and rendered text. No core/adapter, Worker/protocol, dependency,
  configuration, packaging, network, settings, persistence or mutation change.
  Added mocked-host unit and focused command/service/official-adapter integration
  suites (35 new cases; 21 files / 250 tests total). Tests cover registration,
  inert load/unload, every result, captured identity, both overlap directions,
  recovery, changed-file races, oversized actual UTF-8 text, exact untrusted text
  rendering, metadata disposal and late success/rejection suppression. Negative
  assertions cover host/global network APIs, direct logging, settings, saved-file
  mutation, raw-adapter access, editor saves, cached reads, timers and watchers;
  integration snapshots preserve saved files/content apart from explicit simulated
  external races. The host fake models `load`/`unload` hooks, ID qualification and
  `addCommand`-registered disposers rather than clearing all commands on unload;
  unrelated registrations survive, and UI clearing is the product's responsibility.
  The TDD red run failed on the absent default class as expected. Final `mise run
  test`, `mise run coverage`, `mise run typecheck`, `mise run lint` and `mise run
  biome:check` passed after correcting introduced TSDoc/import/format diagnostics.
  Additional `mise install` and complete `mise run check` passed, including the
  existing non-deploying bundles. Global coverage: statements 96.74%, branches
  93.75%, functions 95.96%, lines 97.04%; all new plugin production behavior has
  100% across the four metrics, with unchanged thresholds/source inclusion.
  Post-check writer semantic/security review found no blockers: platform APIs
  remain in the plugin, public core imports/internal aliases and strong types
  are preserved, eligibility/sorting stay in existing core/adapter policy, no raw
  bodies/errors reach UI, and no new logging, network, persistence or mutation
  exists. Configured diagnostics are clean; no separate editor or real Obsidian
  desktop/mobile session was exercised. Independent reviewer gate remains required.
  Host-loadable CommonJS packaging/artifact smoke and final current-state docs
  remain slices 4/5; the current bundle check is not a real-host compatibility claim.
- Slice 4: implemented browser-target CommonJS packaging with unchanged manifest
  staging alongside `main.js`. Supervisor-approved export convention follows the
  official sample: `module.exports.default` is the Plugin subclass, not a custom
  bare-constructor footer. Only `obsidian` remains external; the generated 19-module
  bundle is 15,193 bytes (Bun reports 15.19 KB), and staged manifest is 261 bytes.
  Source manifest identity/minimum/non-desktop declaration are unchanged.
  Added a dedicated Vitest artifact suite (1 file / 3 tests) loading the actual
  generated CommonJS bundle in an isolated VM realm with no Node globals and only
  host-double `obsidian` resolution. It verifies exact manifest staging, external
  dependencies/default class, inert load, both metadata commands, saved UTF-8 read,
  unload/re-enable cleanup and suppression of late in-flight results. The artifact
  suite imports no source entry; source tests/coverage remain independent.
  `plugin:smoke` rebuilds first; canonical `build`/`check` include it without deploy.
  Supervisor approved dev-only `@types/node` major 24 (locked 24.13.4, plus its
  `undici-types` dependency) so the fs/VM test boundary is strictly typechecked.
  Dynamic VM exports are immediately narrowed/validated, never unchecked-cast.
  A dedicated artifact tsconfig is included in canonical typecheck; production
  plugin typechecking also runs separately with only Obsidian ambient types.
  `tsc --listFiles` confirmed that production plugin check includes no Node types.
  No production source, Worker/protocol behavior, runtime dependency, network,
  settings/persistence, local mutation or M3 implementation was added.
  Added disposable-vault build/install/enable/commands/unload/update/removal
  instructions and synchronized README, architecture, current-state and SECURITY
  to actual local-only M2 behavior. Official public API declarations at revision
  `83ce5767ab107e888079e9a673ce4c3153db1ff2` (package 1.4.11) establish availability
  of all used host surfaces before minimum 1.5.0; installed official 1.13.1 types
  confirm signatures and non-deprecation. Official sample CommonJS configuration
  and installation tutorial are linked in `docs/plugin-development.md`.
  TDD red smoke failed on absent staged manifest as expected. Final `mise install`,
  `mise run install`, `mise run build`, `mise run plugin:smoke` and `mise run check`
  passed after fixing introduced formatting and restricted-name diagnostics.
  Additional `mise run typecheck`, `mise run lint` and `git diff --check` passed.
  Source validation: 21 files / 250 tests; artifact validation: 1 file / 3 tests.
  Global coverage unchanged: statements 96.74% (476/492), branches 93.75% (195/208),
  functions 95.96% (119/124), lines 97.04% (459/473); all plugin production behavior
  remains 100%, with unchanged thresholds and source inclusion. Worker dry-run
  remains 1029.93 KiB / gzip 174.88 KiB; Wrangler's available-update notice is not
  a compiler/linter/deprecation diagnostic and no version upgrade was in scope.
  Post-validation writer semantic/security review found no blockers: no runtime
  source changes, Node imports confined to artifact tests, typed external boundary,
  explicit task ordering, public host APIs, no private cross-package imports,
  no added content/logging/mutation/persistence behavior and no unnecessary runtime
  dependency. Configured diagnostics are clean; no separate editor, real desktop/
  mobile host, installed vault or deployment was exercised. Automated host-double
  checks are not real-host compatibility evidence; best-effort race limitations
  remain documented. Independent semantic review and M2 completion/roadmap/spec
  transition remain slice 5; M2 is intentionally still active/uncompleted.
- Slice 5 / final acceptance: completed independent semantic/security review of
  `635d24a..2e74b23` after the automated gate. No defects found; verdict OK with
  notes limited to untested real desktop/mobile/editor environments and the
  documented best-effort/non-cancellable host boundary. Parent review inspected
  production policy/service/adapter/lifecycle/UI, integration negative assertions,
  generated-artifact harness, task/type boundaries, configured manifest schema and
  exact diff; agreed with the review. No concrete findings were deferred.
  Verified no changes under `apps/worker`, `packages/protocol`, or existing core
  `note-path`/`vault` modules. No new ADR is required: the implementation preserves
  the approved read-only M2 architecture and existing decisions.
  Updated M2 acceptance/evidence, README, current-state, architecture and plugin
  development status. The roadmap marks M2 COMPLETE and M3 NEXT, with a detailed
  planning-only handoff that requires unresolved product/concurrency decisions
  and a new implementation plan before M3 production code. Transition is canonical
  on merge; no M3 production implementation, deployment or vault install occurred.
  Final `mise install`, `mise run install`, `mise run check` and `git diff --check`
  passed on the completion changes: 250 source tests plus 3 artifact tests,
  statements 96.74%, branches 93.75%, functions 95.96%, lines 97.04%. Both bundles
  passed; Worker execution was dry-run only. All local documentation file links
  resolve. Final command outcomes and review limitations are reported in the
  completion PR.
