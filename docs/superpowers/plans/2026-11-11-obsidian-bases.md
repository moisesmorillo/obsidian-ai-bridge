# Native Obsidian Bases implementation plan

> Use subagent-driven-development for approved implementation. Complete each task with one worker and one fresh reviewer.

**Goal:** Sync native `.base` files and expose safe MCP tools for ChatGPT.

**Architecture:** Treat Bases as unindexed text, with the existing blob fallback for large files. Reuse file operations and response ownership. Validate structure without executing expressions.

**Tech stack:** TypeScript, Zod, existing Worker and Obsidian plugin, and the `yaml` package.

**Spec:** `docs/spec.md` sections 5, 7.8, 8, 9, and 10. OAB-57 notes contain the format evaluation.

## Owner decisions

Plan approval approves these proposals and the three subtasks below.

1. Include `list_bases`, `read_base`, `create_base`, `update_base`, `delete_base`, and `validate_base`.
2. Exclude `query_base`. Only Obsidian evaluates filters, formulas, plugin functions, and contextual `this` values.
3. Use raw YAML replacement, not a new structured patch operation. Clients preserve unrelated configuration before an exact-ETag update.
4. Validation checks YAML and known structural fields only. It never claims expression validity or Obsidian runtime compatibility.
5. Add `yaml` version `2.8.1` as a protocol runtime dependency for portable parsing. Bun-only parsing cannot run in Cloudflare Workers.
6. Limit validation and MCP Base writes to 65,536 UTF-8 bytes. Larger files still sync and support bounded reads.
7. Use fixtures only. No personal vault, deployment, Cloudflare resource changes, or security-audit files enter this work.
8. Use one branch and one pull request. The owner merges.

## Approaches

- **Recommended:** Native YAML files with existing conditional file operations. This preserves sync, history, and client authority.
- **Sync only:** Smaller, but it does not supply the requested ChatGPT tools.
- **Worker query engine:** Reject. It duplicates Obsidian semantics and lacks plugin functions and display context.

## Format and compatibility

Official sources: https://help.obsidian.md/bases and https://help.obsidian.md/bases/syntax.
Their official repository sources supplied readable content on 2026-11-11.

A `.base` file contains YAML configuration, not a separate note database.
Known sections include filters, formulas, properties, summaries, and views.
Filters use strings or recursive `and`, `or`, and `not` lists.
Views can contain order, groupBy, filters, summaries, and plugin-specific fields.
Note properties remain in Markdown frontmatter. File properties also describe attachments.

Preserve raw content byte-for-byte for writes. Preserve unknown fields and custom view types.
Do not normalize YAML, rewrite formulas, infer Kanban behavior, or change underlying notes.
For one-view changes, clients read the current file and edit only that view before conditional replacement.
Tests compare other views, unknown fields, global settings, and note revisions after this operation.

## Global constraints

- Exact observed revisions govern update and delete. Create uses an absent-path precondition and explicit epoch.
- Reuse current path identity, exclusions, scope checks, epoch checks, idempotency receipts, and response ownership.
- Every mutation uses the existing feed and history. Never add a parallel database or new storage kind.
- Keep Zod protocol shapes canonical in `packages/protocol` and derive exported types.
- Keep application logic outside transport handlers. Document named semantic declarations with useful TSDoc.
- Preserve note-tool behavior and Markdown-only search.
- Run `bun run docs:check` during corrections and `bun run check` before completion.

## Research and feasibility

Current classifier: `packages/protocol/src/codecs/files.ts` recognizes Markdown and Canvas only.
Plugin admission: `apps/plugin/src/sync/enrollment-scope.ts` admits these as inline text up to 1,000,000 bytes.
Worker storage already uses this classifier and indexes Markdown only.
Protocol blob and manifest validators contain separate Markdown/Canvas suffix checks. Extend those checks too.
MCP listing filters Markdown and Canvas. Keep that existing default and add a Base-only selection.
MCP read and mutation application functions already use generic conditional file operations.
Transport pre-dispatch scope policy and read-slot ownership must include the new tool names.

### Resource bounds

| Operation | Bound and behavior |
| --- | --- |
| Sync | Inline at most 1,000,000 bytes. Blob above that limit through 25,000,000 bytes. Refuse larger files. |
| MCP list | Reuse 256 entries and 65,536 estimated response bytes. Return result_too_large instead of partial success. |
| MCP read | Reuse revision-pinned fragments, blob reads, cancellation, deadlines, and byte reservations. |
| Validation/write | At most 65,536 UTF-8 bytes. Reject aliases, anchors, custom tags, duplicate keys, and multiple documents. |
| Parsed structure | At most depth 32 and 16,384 syntax nodes. Check bounds before composition and recursive structure validation. |
| Parser input | At most 16,384 lexical tokens, parser stack 34, and 32 block indicators per physical line. Stop immediately at a limit. |
| Diagnostics | At most 8 diagnostics, each at most 256 characters. Do not include raw content in diagnostics. |
| Persistence | One existing conditional mutation. No new network service, runtime binding, table, or platform capability. |

Reject unsupported YAML constructs with bounded diagnostics. Never expand aliases or execute tags or expressions.
Use `Lexer.lex` and `Parser.next` incrementally, not unbounded `parseDocument`.
Count lexical tokens and block indicators before `Parser.next`. Reset the indicator counter at each newline.
Check the public parser stack before and after each `next` call. Reject aliases, anchors, and tags before composition.
Walk completed CST iteratively to check depth and node count before `Composer` builds the document.
Compose only one bounded document with strict duplicate-key checks. Disable alias expansion and custom tag construction.
Check syntax-tree limits before conversion to plain data. Parse once per validation and avoid duplicate content output.

Feasibility probe: `yaml@2.8.1` browser exports support `Lexer`, `Parser`, and `CST.tokenType` under Bun.
The normal two-field view consumed 23 tokens. A 20,000-level flow input stopped after 35 tokens.
A 20,000-level block sequence stopped after 66 tokens. Both stopped before composition without stack errors.
The probe used the public package in temporary storage, not product dependencies or vault files.
Source checks: https://github.com/eemeli/yaml/blob/v2.8.1/src/parse/lexer.ts and https://github.com/eemeli/yaml/blob/v2.8.1/src/parse/parser.ts.
Probe date: 2026-11-11. Worker portability still needs the repository build and runtime tests.
Do not count YAML bytes as a new allowance outside existing HTTP envelope and admission budgets.

Old plugins exclude `.base` files. Every device needs the updated plugin to sync them.
No migration rewrites existing rows. Test legacy blob rows and revision history without changing their stored representation.
New Base writes use inline text through 1,000,000 bytes and blobs above that limit.
Base rows always carry `large: false`, including blobs above 1,000,000 bytes. This owner audit correction supersedes the earlier `large: true` proposal.
Existing Base blobs at or below 1,000,000 bytes carry `large: false` and remain blobs until a normal write replaces them.
Existing Base blobs at small sizes must remain readable. Do not claim automatic conversion of existing rows.
Update spec section 5.4 explicitly with these rules, including the existing-blob exception.
Test new inline writes, large blob writes, metadata, manifest, legacy small blob reads, and retained history.

## Review focus

1. Mixed-case `.BASE` suffixes must work without changing path identity. Near suffixes must remain excluded.
2. Large Base files must satisfy manifest and blob metadata validation without entering full-text search.
3. New tool names must receive the same scope, revocation, admission, and cancellation checks as existing tools.
4. Malicious YAML must fail within explicit bounds without alias expansion or expression execution.
5. A stale one-view replacement must fail without changes to the Base or underlying notes.

## Task 1: Native file classification and device sync

**Proposed subtask:** Support native Base files across protocol, storage, and device sync.

**Files:** `packages/protocol/src/codecs/files.ts`, `packages/protocol/src/schemas/reads.ts`, `packages/protocol/src/schemas/blobs.ts`, `apps/plugin/src/sync/enrollment-scope.ts`, relevant protocol, Worker, and plugin tests, and `docs/spec.md`.

**Interfaces:** Extend `classifyFilePath(path)` with `base`. Keep storage kinds `text` and `blob` unchanged.

- [ ] Write failing tests for `.base`, `.BASE`, Unicode paths, near suffixes, exclusions, and size boundaries.
- [ ] Run the focused tests and record the expected failing assertions before implementation.
- [ ] Extend classification, enrollment, manifest validation, and blob metadata policy.
- [ ] Test Worker conditional writes, history, feed, blob fallback, and Markdown-only search with Base files.
- [ ] Test plugin publication and remote application with fixtures, including a visible conflict and notes unchanged.
- [ ] Update spec sections 5, 7.8, and 10 with text/blob thresholds and device upgrade behavior.
- [ ] Run focused tests, `bun run check`, one fresh task review, corrections, and commit.

## Task 2: Bounded structural validation

**Proposed subtask:** Validate native Base YAML without an expression engine.

**Files:** New `packages/protocol/src/schemas/bases.ts`, `packages/protocol/src/codecs/bases.ts`, derived type exports, protocol package dependency and lockfile, and `packages/protocol/test/bases.test.ts`.

**Interfaces:** Export `validateBaseContent(content)` with a bounded result containing validity, diagnostics, and an explicit structural-only validation level.
Zod schemas own its request and result shapes. Validation never returns parsed note data or evaluates expressions.

- [ ] Write failing tests for the official example and a two-view Opportunities fixture.
- [ ] Include global and view filters, formulas, properties, summaries, groupBy, order, and unknown plugin fields.
- [ ] Test invalid YAML, duplicate keys, multiple documents, scalar roots, invalid known field types, and malformed recursive filters.
- [ ] Test byte, depth, node, lexical token, parser stack, per-line indicator, alias, anchor, and tag limits.
- [ ] Test pathological deep flow and block inputs before composition. Check diagnostic count and text bounds.
- [ ] Accept empty mappings as structural configurations.
- [ ] Run tests and record expected failures before implementation.
- [ ] Add `yaml` with a fixed version and the stated portability reason in task notes.
- [ ] Implement syntax-tree bounds before conversion and structural checks after conversion.
- [ ] Accept unknown configuration fields. Treat expression strings as opaque text.
- [ ] Run focused tests, `bun run check`, one fresh task review, corrections, and commit.

## Task 3: MCP Base tools and public contracts

**Proposed subtask:** Expose safe native Base tools through the existing MCP transport.

**Files:** `packages/protocol/src/schemas/mcp.ts`, exports and derived types, `apps/worker/src/application/mcp-notes.ts`, `apps/worker/src/application/mcp-mutations.ts`, a focused Base application module if needed, `apps/worker/src/transport/mcp.ts`, `apps/worker/src/transport/mcp-http.ts`, MCP protocol/application/HTTP tests, `docs/spec.md`, and `docs/api/worker.md`.

**Interfaces:**
- `list_bases(prefix?, include_large?)`: Existing bounded metadata result, filtered to Base files only.
- `read_base(path, etag?, offset?, length?)`: Existing revision-pinned raw content result, limited to Base paths.
- `create_base(path, content, epoch, idempotency_key?)`: Validate before an existing create-only mutation.
- `update_base(path, content, etag, idempotency_key?)`: Validate before an existing exact-revision replacement.
- `delete_base(path, etag)`: Existing exact-revision tombstone with `vault:delete`.
- `validate_base(content)`: Read scope, no persistence, bounded structural result and current epoch.

### Tool authority and response ownership

| Tool | Scope | Admission | Response owner and cancellation |
| --- | --- | --- | --- |
| list_bases | vault:read | Existing MCP read slot and durable manifest admission | Transfer lazy read owner. Cancel source, then settle and complete the lease. |
| read_base | vault:read | Existing MCP read slot and durable text/blob admission | Transfer revision-read owner. Cancel storage source, then settle and complete the lease. |
| create_base | vault:write | Existing mutation envelope reservation and conditional write admission | Transfer mutation owner. Settle response admissions at EOF or cancel. Keep uncertain work until its deadline. |
| update_base | vault:write | Existing mutation envelope reservation and conditional write admission | Same mutation-owner policy as create_base. |
| delete_base | vault:delete | Existing delete mutation admission | Same mutation-owner policy as create_base. |
| validate_base | vault:read | Existing MCP read slot and envelope reservation. No new durable read admission. | No storage owner exists. Hold the Worker lease and envelope reservation through result EOF or cancellation. |

Register all names in the pre-dispatch scope policy before SDK validation.
Validation checks current epoch and revocation through the existing authority before parsing user content.
For validation, check cancellation before parsing and after bounded synchronous parsing, then transfer only the bounded result.
Test each policy by tool name, including early refusal, EOF, cancellation, lease expiry, and exactly-once reservation release.
Do not create dummy durable admissions or silently bypass Worker read slots for validate_base.

All paths use the canonical path schema plus an exact final Base suffix check.
All results contain the current epoch. Failures use bounded errors without content disclosure to unauthorized clients.
Reuse shared helpers without renaming or broadening existing note-tool behavior.

- [ ] Write failing protocol and tool-discovery tests for all six names and canonical schemas.
- [ ] Write failing CRUD tests with stale ETags, old epochs, duplicate and missing paths, idempotency retries, and traversal refusals.
- [ ] Test read-only and write-only scope boundaries, delete consent, revocation, admission, invalid inputs, and cancellation.
- [ ] Test one-view edits that preserve other views, unknown settings, comments, and unrelated note revisions.
- [ ] Use `Freelance/Career Ops/Opportunities/` fixtures with pipeline, status, priority, applied, and archived filters.
- [ ] Test that validation and CRUD never evaluate expressions or change underlying note properties.
- [ ] Run tests and record expected failures before implementation.
- [ ] Implement canonical schemas, Base-only wrappers, registrations, and pre-dispatch policy.
- [ ] Document all six tools, authorization, concurrency, parser limits, examples, and the absence of query_base.
- [ ] Run focused tests, `bun run check`, one fresh task review, corrections, and commit.

## Completion

- [ ] Review the complete branch with the branch-review profile on the session model.
- [ ] Record reviewed revision, documentation scope, structural candidates, validation, limits, and finding closures in task notes.
- [ ] Open one Plannotator branch review against `main` and address annotations.
- [ ] Close OAB-57 and its approved subtasks through the Backlog CLI after acceptance checks.
- [ ] Push the branch and open an English Conventional Commit pull request. Never merge it.
- [ ] Remove the worktree after publication and report design choices, subtask IDs, and the PR link.

## Validation limits

Tests prove repository behavior and native-format fixture preservation, not Obsidian UI execution.
No approved disposable Obsidian runtime appears in the brief.
If the repository cannot prove native UI opening, record that limit and a deferred OAB-57 subtask with a disposable-vault trigger.
Do not claim UI execution from parser tests. This limit does not block the pull request.
