# M2 implementation plan — read-only local inspection

**Status: ready for sequential implementation.** Created from the approved
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
- Slice 3: pending.
- Slice 4: pending.
- Slice 5 / final acceptance: pending.
