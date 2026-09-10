# M2 — Obsidian read-only local-vault adapter

**Status: COMPLETE — implemented and validated; transition canonical on merge.**

Implementation followed the [sequential M2 plan](../plans/m2-obsidian-read-only-local-adapter.md).
[Completion evidence](#completion-evidence) records checks, review and host-test
limitations. [M3](m3-remote-bridge-client-and-publishing.md) is NEXT for planning
only; no remote publishing implementation is included.

Depends on M1. [Roadmap](../roadmap.md) owns sequence and status;
[AGENTS.md](../../AGENTS.md) owns engineering rules. This specification makes new,
bounded M2 scope decisions; it does not claim that earlier commits implemented or
selected a synchronization policy.

## Purpose

Turn the type-only Obsidian scaffold into a loadable plugin that can inspect
eligible local Markdown notes through official host APIs. Establish a tested
read-only adapter before introducing credentials, remote publishing or sync.
The useful result is a user-invoked local inspection tool, not a working mirror.

## Scope

- A real default-exported Obsidian `Plugin` implementation with host-managed
  command registration and safe unload behavior; retain manifest ID `ai-bridge`.
- A narrow read-only local-vault port and application service in core, implemented
  using official Obsidian APIs in the plugin package.
- Local eligibility validation, deterministic enumeration and a bounded read of
  the active saved note with typed outcomes.
- Two explicit command-palette actions and minimal metadata-only feedback.
- Plugin unit/integration tests, Vitest project registration, and a loadable
  plugin build plus reproducible installation/removal instructions for a disposable
  development vault. Do not assume an existing host installation.

## Non-goals

No HTTP requests, Worker connectivity check, bearer-token entry, settings tab,
settings persistence, remote-client implementation, synchronization, mirror
selection UX, watchers, timers, automatic scans, conflict resolution, note edits,
creation, rename, deletion, local cache/index, offline queue, search or MCP.

Do not implement `VaultRepository` with throwing/no-op mutation methods just to
fit the existing remote port. Do not generalize M1 CRUD into a sync abstraction.
M1 Worker behavior and protocol contracts remain unchanged.

## User-visible behavior

The plugin loads with no scan, note read, network request or state write merely
because it was enabled. Register these commands (IDs stable within this milestone;
Obsidian supplies the plugin prefix):

| Command ID | Label | Behavior |
| --- | --- | --- |
| `inspect-local-notes` | Inspect local Markdown notes | On invocation, enumerate eligible saved files and show a read-only list of exact relative paths and byte-size metadata, sorted lexically, plus counts of eligible and skipped files. Empty vault: explicit empty result. Do not read note bodies during enumeration. |
| `inspect-active-note` | Inspect active Markdown note | Capture the active file when invoked; validate and read its saved text once. Report success with path and UTF-8 byte count, or a sanitized reason it cannot be inspected. Do not show/render the content or copy it to the clipboard. |

Use a host dialog/modal for the list and notices or a similarly small host UI for
operation results. Render paths as text, never as HTML/Markdown. No custom view
framework, selection controls or editable note UI is required. Enumeration is a
best-effort view at invocation, not a transaction over the vault.

No active file, an unsupported active file, or an unavailable file produces a
clear non-success result rather than reading another note. Switching the active
pane while awaiting a read must not redirect the operation to the new file.
The read targets the **saved vault file**, not an editor buffer; tell the user to
save and retry if they need unsaved changes included. Do not force-save editors.

Permit only one inspection at a time; another invocation reports busy rather than
starting overlapping work. Release that state on every outcome. On unload, stop
new work and suppress late UI results from in-flight work; do not promise that a
host read is cancellable when it is not. Host-managed registrations must not leak.

## Architecture

| Boundary | Responsibility |
| --- | --- |
| Plugin entry/commands/UI | Composition, lifecycle, active-file capture, command busy state, text-only results and sanitized notices. Delegate application behavior to the service, not inline vault business logic. |
| Obsidian infrastructure adapter | Official `App`/`Vault` file enumeration, exact file lookup/read and stat capture. Translate host objects/errors into strong local contracts; enforce host configuration-directory exclusion and file identity checks. No Node filesystem access or outside-vault paths. |
| Core/application | Read-only port, platform-independent result/metadata types, inspection use case, shared path/size policy reuse and deterministic result ordering. No `App`, `TFile`, Hono, network or filesystem implementation imports. |
| Protocol | No new wire messages or sync metadata. Existing response schemas and reserved envelope stay unchanged. Local inspection outcomes are core types, not HTTP error envelopes. |
| Worker/R2 | No changes or calls. Preserve M1 API, authentication, namespace and payload invariants. |

Put plugin-specific declarations in cohesive modules, not all in `main.ts`.
Use public workspace exports for cross-package imports and existing internal
aliases. Reuse `NotePath`, `isNormalizedNotePath` and `MAX_NOTE_SIZE_BYTES` from
core; add exports for new core contracts rather than reaching into private modules.
Do not make core depend on the plugin or import the Worker's logging adapter.

## Interfaces / contracts

Names below describe responsibilities; exact exported symbol names may follow
repository naming conventions without changing behavior.

### Read-only local-vault port

Provide only enumeration and read capabilities. An implementation must not expose
create/update/delete/rename methods to this application service.

- **Enumerate:** return eligible entries containing a validated `NotePath` and
  size in bytes, plus skipped-file counts grouped by a closed, documented reason
  set (unsupported file, excluded location, invalid path, oversized file). Give
  each file one deterministic reason, in that order. Do not return skipped paths
  or bodies. A host enumeration failure is a typed failure, not an empty success.
- **Read:** accept a validated literal `NotePath`; resolve the exact saved file,
  recheck eligibility and size, capture file identity/path/mtime/size before and
  after the asynchronous host read, and return either text plus byte length or
  a typed failure. Never select an alternate file or normalize into another name.
- Metadata is ephemeral read evidence, not a durable version or sync revision.
  Keep host `TFile`/stat objects private to the adapter; use only the small primitive
  fields required by the contract. A detected identity/path/mtime/size change means
  `changed_during_read`; do not return content as a successful result in that case.
- A metadata check is best-effort: same-size edits with indistinguishable timestamp
  granularity may evade it. M2 is read-only and promises no atomic snapshot. M3/M4
  must not treat this evidence as concurrency protection for writes.

### Application service and outcomes

Expose list inspection and active-path inspection use cases. The latter receives
a captured literal path (or a no-active-file input), not an Obsidian object or an
HTTP/base64 identifier. Validate untrusted input before invoking a port read.
Application sorting and reusable path/size rules must have one source of truth.
Adapter validation is still required for host data and for files changed since
listing; avoid duplicating the underlying policy.

Use closed typed results for success and expected failures. Cover at least:
no active file, unsupported file, excluded location, invalid path, missing file,
oversized content, changed during read, and unavailable/runtime failure. Keep
plugin busy/unloaded lifecycle states in the plugin, separate from domain errors.
Runtime error strings must not become control-flow codes. Constants/types and
useful TSDoc follow `AGENTS.md`; no weak generic records or casts to bypass typing.

The UI result for a read contains metadata only. Do not retain the port's content
in long-lived plugin fields or return it to notices/logging. The small core read
contract can carry content for future reuse, but this milestone does not expose
it beyond the inspection operation.

### Settings, commands and API interactions

Commands above are the entire plugin feature surface. No connection, token or sync
settings exist in M2. There are **zero** API interactions, including public health
checks. Inspection eligibility is not a future upload permission.

## Data safety

### Eligible files

Only saved, vault-relative Markdown files returned/resolved through the official
Obsidian vault APIs may be inspected. Require lowercase `.md`, the current core
path invariant, and size no greater than the shared 1 MiB limit. Do not extend the
Worker's accepted path set or silently rename unsupported local names.

Additionally exclude any file with a path segment beginning with `.`, and the
host's configured configuration-directory subtree (even if configured to a
non-dot-prefixed name). Compare directory boundaries, not string prefixes:
excluding `config/` must not exclude `configuration/`. This M2 privacy rule is
local inspection policy, not a retroactive change to M1 path validity.

Unsupported/non-Markdown files (including attachments) are skipped without
reading their bodies. Excluded locations and invalid/oversized Markdown files
also remain unread. The active-note command reports the relevant reason.
No filesystem traversal, OS home directory access, following arbitrary filesystem
links through Node APIs, or inspection of plugin configuration/secrets.

### Literal path validation

An Obsidian path is already a literal vault-relative path: use the current core
normalized-path predicate, **not** URI decoding via `normalizeNotePath`.
For example, a literal `100%.md` must not be rejected just because it is not a URI;
`a%20b.md` must not turn into `a b.md`. Encoded dangerous separators/dot traversal
are rejected by the existing predicate. Test exact-name preservation, spaces,
Unicode and percent signs. Absolute/drive paths, backslashes, NUL and empty/dot
segments are never repaired into valid paths. No unchecked branding/casting.

### Payload and concurrent changes

Check host metadata before reading to avoid knowingly buffering an oversized
note. After reading, measure actual UTF-8 bytes with the shared byte limit; do not
use JavaScript character length. Exactly 1 MiB and empty text are valid; larger
content returns a typed failure without truncation. The host returns strings;
M2 does not claim raw-byte UTF-8 validation that the host read API cannot provide.

Recheck file identity/path and metadata after read; disappearance or rename/edit
must not be reported as a successful stable read when observed. Reject an
oversized post-read value even if initial metadata was small. All failure paths
leave vault contents untouched. No automatic retry; the user may invoke again.

### Mutation prohibition

No vault files can be written, created, renamed or deleted by M2. Do not repair
paths, rewrite Markdown/frontmatter, create conflict copies, persist inspection
reports, auto-save editor buffers or propagate absence. No automatic reads,
uploads or operations on enable/unload. Even manual inspection is not consent to
future bulk mirroring. Installing the plugin artifact into a disposable vault is
an explicit developer action, not product behavior.

## Security

No secrets are needed, requested or stored. A local vault is sensitive input;
plugin permissions do not justify broader access than this spec. File paths may
be shown only in the deliberate local result UI; never include paths, text,
credentials or raw exceptions in diagnostic logs. Treat note content and file
names as untrusted data, not instructions or markup.

Prefer no new application logging for M2. If diagnostics are technically needed,
use an established structured LogTape integration local to the plugin with only
sanitized operation/outcome fields; do not import Worker infrastructure or build
a custom logging framework. Unexpected failures produce a generic retryable user
notice, not a stack trace. Do not promise encrypted settings/storage: M2 persists
neither. Worker single-token limitations do not apply to a local-only command.

## Failure modes

| Condition | Required behavior |
| --- | --- |
| No active file / non-Markdown active file | Specific typed non-success and useful notice; no content read |
| Excluded or invalid path | Refuse before content access; no normalization into another file |
| Oversized metadata/content | Skip in listing or fail the read; no pre-read buffering when known oversized, no truncation |
| Missing/renamed/changed file during operation | Fail safely with missing/changed outcome as observed; do not retarget or silently retry |
| Host read/enumeration rejects unexpectedly | Sanitized unavailable/runtime result; no raw exception, no empty-success masquerade |
| Another command is running | Busy feedback, no overlapping read/list operation |
| Plugin unload during an await | Discard result, suppress late UI, release ephemeral state |

Network unavailable, Worker unavailable, remote authentication failure and malformed
HTTP responses are deliberately **not applicable**: there is no network code to
fail in M2. Offline execution must behave identically. Those cases require tests
when M3 introduces the remote adapter.

## Persistence

None. Do not call plugin `loadData`/`saveData` to reserve future settings, create
`data.json`, write a scan cache, persist paths/content/revisions, or introduce a
settings migration. Keep operation state in memory only and release it on finish/
unload. The existing optional `PluginScaffold` fields are placeholders, not a
persisted contract that must be kept or migrated.

## Testing strategy

Use Vitest and the current dedicated test layout, with TDD for new behavior.
No real credentials, user vault or network in automated tests. Unit/integration
tests isolate host filesystem access with fakes; the artifact smoke check may
load the generated local bundle with a host double, without accessing a vault.

### Required unit tests

- Core service: deterministic list order, empty list, skipped counts/reasons,
  no-active input, expected failures and port failure translation as appropriate.
- Eligibility: lowercase `.md`, unsupported extensions, dot-prefixed segments,
  custom configuration-directory boundary, traversal/absolute/backslash/NUL/empty
  segments, dangerous encodings, spaces/Unicode and literal percent paths.
- Obsidian adapter with a strongly typed minimal host fake: exact lookup,
  enumeration without body reads, exclusion before read, empty content, exact
  byte limit and over-limit ASCII/multibyte content, misleading size metadata,
  disappeared/renamed/edited file during await and rejected host operations.
- Plugin commands/UI/lifecycle using a mocked `obsidian` module: registration,
  captured active path, no-active and busy results, release after errors, unload
  during await, text-only path rendering and no note-content output.
- Negative assertions: no vault mutation, settings persistence, HTTP request,
  automatic scan/read on load, sensitive log output or late UI after unload.

### Required focused integration tests

Under `apps/obsidian-plugin/tests/integration/`, compose command/application
service/Obsidian adapter with an in-memory fake host. Exercise list → active-note
inspection, invalid/excluded/oversized files, file changes while reading and
runtime failure recovery. Assert that vault content and persisted state remain
unchanged. These compose layers but do not cross a real platform boundary: call
them integration tests, not E2E.

Use `apps/obsidian-plugin/tests/unit/` and `packages/core/tests/unit/` for isolated
behavior; production `src/` stays test-free. Mock the Obsidian runtime explicitly;
its types alone cannot supply a runtime in Vitest. Add the plugin project to root
Vitest discovery and verify new tests actually execute through mise tasks.

### Coverage/build/host checks

- Keep root V8 inclusion of all production source, including unimported plugin
  behavior. Do not exclude new UI/lifecycle code just to meet coverage.
- Preserve global thresholds: lines 95%, statements 95%, functions 94%, branches
  90%. Add meaningful tests rather than lowering thresholds. Coverage remains a
  regression signal; unchanged M1 behavioral tests must stay green.
- Update `plugin:build` only as necessary to produce a host-loadable plugin entry
  (Obsidian-compatible CommonJS default plugin export, `obsidian` external) and
  stage/copy the manifest reproducibly. Keep `mise run build`/`check` canonical and
  non-deploying; do not add package-script orchestration.
- Add a focused artifact smoke check using an Obsidian host double that loads the
  bundle and verifies the default plugin class/commands. Document disposable-vault
  install/enable/command/unload/removal steps and expected UI results.
- Real-host testing is optional supplementary evidence if Obsidian is available;
  never claim it occurred without evidence. If unavailable, record that limitation
  and rely on automated host-double/artifact checks, not an invented installation.
  Do not add automated E2E infrastructure for these read-only operations.
- Honor the manifest's minimum version and non-desktop-only declaration: use
  compatible official APIs and no Node-only runtime access. Verify compatibility
  against installed types/API documentation; document any required manifest change
  rather than silently raising the minimum or claiming tested mobile support.

## Acceptance criteria / Definition of Done

- [x] Default plugin class replaces the type-only scaffold; manifest identity is
  preserved; no new network, settings, sync or vault mutation feature exists.
- [x] Both commands implement the exact observable behavior above, including empty,
  no-active, busy, failure and unload cases; enabling alone performs no inspection.
- [x] Core read-only contract/service and Obsidian adapter have the prescribed
  separation, strong types, useful TSDoc and alias/public-package imports.
- [x] Eligibility and literal path handling use shared invariants without widening
  M1 behavior; exclusions are applied before reads and covered by tests.
- [x] Pre/post size checks and changed-file handling are tested; no truncation,
  implicit save, alternate-file read or automatic retry occurs.
- [x] Note bodies never appear in UI/logs/persisted state; paths render as text
  only in explicit local results; unexpected errors are sanitized.
- [x] Plugin unit and integration tests execute in the canonical Vitest projects;
  coverage thresholds remain enforced with all relevant production source included.
- [x] Reproducible host-loadable artifacts pass the focused artifact smoke check;
  disposable-vault installation instructions and host-test limitations are recorded.
- [x] `mise install`, `mise run install` and `mise run check` pass, editor diagnostics
  are clean, and post-validation semantic/security review is recorded in the PR.
- [x] README, current-state and architecture docs describe the actual plugin;
  this spec records completion evidence; roadmap marks M2 complete only when all
  criteria pass, then promotes M3 and links its spec (or clearly requires its
  planning before code). No M3 production implementation is included.

## Completion evidence

- Sequential implementation commits: core `7225d93`, adapter `388d2f2`, commands
  `44ecada`, packaging/docs `2e74b23`; the [plan ledger](../plans/m2-obsidian-read-only-local-adapter.md#evidence-ledger)
  records TDD and per-slice validation. No Worker, protocol or existing core
  path/vault implementation was changed.
- `mise install`, `mise run install`, `mise run test`, `mise run coverage`,
  `mise run typecheck`, `mise run lint`, `mise run biome:check`, `mise run build`,
  `mise run plugin:smoke` and `mise run check` passed. Source tests: **21 files /
  250 tests**; generated artifact: **1 file / 3 tests**. Global coverage:
  statements **96.74%**, branches **93.75%**, functions **95.96%**, lines **97.04%**;
  new M2 behavior is 100% across all four. Thresholds/source inclusion are unchanged.
- The packaged browser/CommonJS entry exposes `module.exports.default` and requires
  only `obsidian`; its unchanged manifest is staged alongside it. The artifact
  suite loads these generated files, not the source entry. Official minimum-API
  and export-shape evidence plus disposable-vault instructions are in
  [plugin development](../plugin-development.md).
- After passing checks, independent read-only semantic/security review of
  `635d24a..2e74b23` found no defects (verdict: OK with verification-limit notes).
  Parent review agreed on responsibilities, inward dependencies, strong types,
  non-deprecated APIs, useful TSDoc, shared policy/semantic values, bounded control
  flow, privacy, race checks, absence of mutation/network/persistence, lifecycle
  and artifact tests. No concrete review findings were deferred.
- Compiler, type-aware lint, Biome formatting/lint/assists and production-only
  plugin typechecking are clean. The unchanged manifest was inspected against
  the configured editor JSON schema. No separate editor session or real Obsidian
  desktop/mobile runtime was exercised; these are verification limits, not claims
  of tested host integration. No deployment or vault installation occurred.
- The roadmap promotes M3 to NEXT with a planning-only handoff. Selection/consent,
  settings/credentials, remote association and server-enforced safe publishing
  remain unresolved; M2 eligibility and stat evidence authorize none of them.

## Final deliverable

A documentation-backed, tested, loadable **read-only local inspection plugin**, a
platform-independent local read port/service, an Obsidian adapter, dedicated
plugin tests and build/installation instructions. M1 remains unchanged. The
completion PR includes test/build/coverage evidence and an explicit list of any
host environments not tested. It hands off to M3 planning with mirror selection,
remote settings and safe publishing still visibly undecided.
