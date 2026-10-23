---
id: OAB-6.9
title: Verify F1 server acceptance without claiming client qualification
status: In Progress
assignee:
  - '@pi'
created_date: 2026-10-15 00:38
updated_date: '2026-10-23T23:22:00Z'
labels:
  - F1
dependencies:
  - OAB-6.8
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: task
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The section 14 F1 exit list includes scenarios with both server and plugin assertions. The phase needs traceable tests against actual Worker/DO behavior, not synthetic client implementations that accidentally qualify offline apply or conflict copies before F3.

Contract corrections from the 2026-10-23 F1 audit are part of this task (criteria 5 to 12). Limits: do not change the admission model or the slot model. Do not add platform probe tests or evidence documents. Run every feasibility probe during planning. Put all open decisions in one ask_user_question with the plan. After plan approval, ask the owner only if bun run check fails or the spec must change.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Every named F1 acceptance case maps to executable real Worker/DO assertions and an explicit statement of the portion actually proven; omissions block phase closure.
- [ ] #2 Client-only portions such as base advancement, stale-feed no-ops and local conflict copies remain visibly unqualified until real plugin tests; any required section 14 gate interpretation is explicitly approved before OAB6 is closed.
- [ ] #3 Default-deny authentication boundaries, canonical protocol contracts, all existing tests, full bun run check and actual remote CI pass on the reviewed final head.
- [ ] #4 OAB6 closes only with objective exit evidence and applicable explicit owner authorizations; no document or passing foundation test substitutes for product acceptance.
- [ ] #5 AC-06 has an HTTP test: DELETE with a stale If-Match returns 412.
- [ ] #6 precondition_failed includes renamed_to when the file was renamed (spec.md:253).
- [ ] #7 DELETE accepts X-Vault-Epoch like every mutation (spec.md:241). It no longer returns 400 for that header.
- [ ] #8 GET with rev and without X-Vault-Epoch returns 410 revision_pruned (spec.md:240), not 409.
- [ ] #9 The protocol error union includes importing and vault_retired (spec.md:253).
- [ ] #10 Text, FTS and large classification of .md and .canvas use one case rule (spec.md:221).
- [ ] #11 README.md reflects the F1 state. The sentence 'F1 has not started' is gone.
- [ ] #12 Vault.reserveAdmission RPC and the unused collectors readManifest, readHistory, readChanges in application/reads.ts are removed with their tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan for owner review: docs/superpowers/plans/2026-10-23-f1-server-acceptance.md. Implementation waits for approval. One implementer owns three sequential slices: protocol and HTTP corrections with durable rename hints, one extension case policy, then executable F1 acceptance coverage and unused API removal. Preserve native and HTTP coverage while removing obsolete collector wrappers. Each slice includes RED/GREEN, docs checks, full checks, and a commit. Independent task review, session-model branch review, human branch review, and actual remote CI precede closure. Owner choices: server-only F1 exit, case-insensitive Markdown/Canvas extensions, and rename hints for the source tombstone lifetime. The plan includes a fresh schema version without migration. OAB-6.8.2 stays Deferred. No admission or slot model change, deployment, personal-vault access, platform probe tests, or evidence documents.

The owner approved the complete plan in Plannotator pn-a27c0b. Execute all three slices with one implementer. Keep the task and parent gate open until independent reviews, human branch review, and actual remote CI support closure. No deployment applies.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Planning starts from main at 9233c22 after merged PR #18. OAB-6.8 is Done. OAB-6.8.2 stays Deferred. No deployment or personal-vault access applies. Implementation waits for owner plan approval.

Planning baseline at 9233c22 passed frozen installation and bun run check: 1052 tests, documentation, formatting, types, schema drift checks, and local dry-run builds. Native suites passed 621 tests. HTTP suites passed 108 tests. Tooling, protocol, and plugin passed 52, 269, and 2 tests. These results do not prove deployed runtime headroom. The owner chose the three contract decisions through one structured question batch.

Partial implementation only. Added HTTP coverage and behavior for DELETE X-Vault-Epoch acceptance, stale-epoch rejection without publication changes, and historical GET without epoch returning 410 revision_pruned. Added protocol classifyFilePath and used it for Worker storage, FTS, and large-file classification. Test-first evidence: RED bun run --cwd apps/worker test -- test/http/files.test.ts -t accepts-a-current-DELETE-epoch failed with 400 instead of 409. GREEN same focused command passed. Protocol RED bun run --cwd packages/protocol test -- test/files.test.ts -t extension-classification failed because classifyFilePath was absent. GREEN same command passed. First full check failed because an existing historical-read assertion expected 409. Updated it to the approved 410 contract. Final bun run check passed: 52 tooling, 2 plugin, 270 protocol, 621 native Worker, 110 HTTP tests; lint, docs, typecheck, and builds passed. Remaining approved slices are incomplete: durable renamed_to schema v6 and failure contracts, full extension parity matrix, acceptance mapping and coverage expansion, collector and reserveAdmission removal, README/spec amendments, three required commits, complete manual self-review, and remote CI. Acceptance criteria remain unchecked. No Cloudflare actions or personal-vault access occurred.

Slice 1 implementation completed. Fresh schema version 6 stores nullable renamed_to on current source tombstones. Failure DTOs now cover renamed_to, importing with bounded Retry-After, and vault_retired with a bounded VaultId. DELETE and historical GET HTTP contracts match the approved plan. Atomic rename, retention, restart, scope redaction, rollback, recreation, deletion, restore, and later rename tests pass.

Focused results: protocol file tests passed (120); storage, admission, publication-budget, and mutation-claim tests passed (156); HTTP file, history, and blob tests passed (74). Full bun run check passed: 52 tooling, 2 plugin, 277 protocol, 622 native Worker, and 111 HTTP tests. Lint, docs, typecheck, and dry-run builds passed.

Test-first exception: several characterization assertions for already-applied HTTP behavior and the rename transition sequence passed on first run. Existing tests now assert enriched live and tombstone failure details. The full check first found stale native assertions that expected only the failure kind; those assertions now verify canonical current metadata.

The pre-existing extension classifier edits remain in shared protocol and Worker source files. This Slice 1 commit includes them because those source and test files overlap with the failure and rename changes. README changes remain outside this commit. Slice 2 parity tests and Slice 3 coverage mapping, unused API removal, and README amendments remain incomplete. Task status and acceptance criteria remain open.

Slice 2 implementation completed. Reused the existing canonical classifier and added exhaustive case-matrix coverage. The matrix tests all four Markdown and all 64 Canvas ASCII case combinations. HTTP tests write 1,000,000-byte and 1,000,001-byte files for every extension case. They verify hashes, manifest kind and large fields, representative exact GET and ranges, FTS membership, and search coverage counts. Native mutations cover create, update, append, rename, delete, recreate, and restore across all 68 cases. The HTTP near-match test confirms `.md.backup` remains a blob and stays outside search coverage.

Found one remaining case mismatch in `usesBlobStorage` and three case-sensitive Markdown suffix predicates in SQLite search. RED for the extension policy test showed 66 failures across uppercase and mixed-case suffixes. RED for native search showed only one of four Markdown variants in search results and `indexed_files`. RED for HTTP showed an uppercase `.Md` inline write returned 400. Updated the application to use the protocol classifier. Updated SQLite suffix predicates to fold ASCII case.

Test-first exceptions: the exhaustive protocol classifier test and the 68-case lifecycle test characterize the pre-existing classifier and mutation policy, so they passed on first run after implementation began. The HTTP matrix first exceeded Vitest’s 5-second default; it then exceeded 60 seconds because it repeated full GETs for every path. The test now checks authoritative hashes and metadata for every case and exact body and range reads for six representative cases. It passes in about 12 seconds. Full `bun run check` first exposed the native lifecycle test’s 5-second default timeout. The test now uses 30 seconds, and the full check passes.

Final validation: `bun run docs:check` passed. `bun run check` passed with 52 tooling, 2 plugin, 277 protocol, 761 native Worker, and 112 HTTP tests, 1,204 total. Slice 3 remains incomplete. OAB-6.9 status stays In Progress and acceptance criteria stay unchecked. The pre-existing README change stays uncommitted.

Slice 3 implementation completed at 945b2241e4a3f3d41a053c992deba04e0098fc7e. Removed the Vault reserveAdmission RPC and the three eager application collectors with collectRead. Kept SqliteAdmissionAuthority.reserve and the native history gateway. Updated tests to use beginMutation and lazy reads while preserving interleavings, caps, expiry, authorization, and response ownership. Added named server acceptance cases across the required F1 IDs. Added concurrent write, delete, and rename assertions against one observed ETag. Added equal-hash, distinct-revision coverage. Updated section 14 with the approved server-only gate and retained later plugin, MCP, deployment, and device limits. README now states production identity resolution denies access by default. The pre-existing README edit remains unstaged. OAB-6.9 and OAB-6 remain In Progress. Acceptance criteria remain unchecked. OAB-6.8.2 remains Deferred.

Test-first exception: the new concurrent mutation and identical-byte assertions passed against the existing implementation before the API cleanup. They characterize existing CAS behavior. One strengthened SQL-row assertion first expected Boolean deletion values, but native SQLite returns 0 or 1. The focused test failed, then passed after the assertion matched the persisted integer form. Focused HTTP files tests passed 25. Focused native tests passed 89. Full bun run check passed with 52 tooling, 2 plugin, 277 protocol, 761 native Worker, and 114 HTTP tests. Lint, docs, typecheck, and dry-run builds passed. Expected injected network and SQLite errors appeared in test logs. No deployment or personal-vault access occurred.

Remaining duties: independent task review, full branch review, human review, remote CI, and publication. Do not close this task or its parent gate before those duties pass.

Correction: Slice 3 uses the final branch commit titled `test(worker): complete F1 server acceptance`. The earlier hash in this note preceded inclusion of the Backlog CLI note and is not the final commit. Read the current branch log for the final hash.

Read API adaptation exception: the real interleaving test first kept the old eager RPC expectation. It failed because opening a session reads metadata only. Updated the test to assert zero batch calls before demand and four bounded batches after reading the page. The later full check passed.

README delivery correction: the tested README content is now committed with `docs: update README for F1 server status`. The earlier note that README remains unstaged described the prior Slice 3 handoff. This follow-up commits the required README change. No source changes or acceptance-criterion updates were made.

Scoped correction for review findings TR-1 and TR-2. TR-1: added real Worker/DO HTTP coverage for UUIDv7 keys 26 days old and 10 minutes in the future. Each rejection returns operation_expired and leaves files, revisions, changes, and receipts unchanged. A four-minute-future key commits once, and a same-key retry returns the same response with one file, revision, change, and receipt. TR-2: validate historical revision, offset, and length selectors before returning revision_pruned when the epoch is absent. A canonical placeholder is used only for schema validation and never reaches the gateway. Valid historical selectors without an epoch still return revision_pruned. RED: focused HTTP tests first showed all three unsafe selectors returned 410 instead of 400. Characterization: the AC-17 mutation test passed on its first run against existing behavior. Focused files suite passed 29 tests. bun run docs:check passed. bun run check passed lint, docs, typecheck, tests, and dry-run builds. Test totals: 52 tooling, 2 plugin, 277 protocol, 761 native Worker, 118 HTTP. Total: 1,210. Existing injected network and SQLite failure logs came from test fault cases. OAB-6.9 remains In Progress and acceptance criteria remain unchecked. The scoped correction is committed.

WB-1 correction: added deterministic real HTTP/DO cases for AC-06 stale DELETE and AC-18 stale rename after a newer live PUT. Each test saves the create ETag, commits revision 2, sends the stale mutation with the original ETag, and expects 412 precondition_failed. Full files, revisions, changes, and receipts snapshots remain equal after each rejected request. The rename test also checks that its destination never exists. The concurrent PUT/DELETE/rename test remains as a separate race assertion and no longer claims deterministic AC-06 coverage. Test-first exception: both new deterministic cases passed on their first run because production behavior was correct. The focused race and new-case run passed 3 tests. The full files suite passed 31 tests. bun run docs:check passed. bun run check passed lint, docs, typecheck, tests, and dry-run builds. Full-check totals: 52 tooling, 2 plugin, 277 protocol, 761 native Worker, and 120 HTTP tests. Total: 1,212. Existing injected network and SQLite errors came from fault tests. OAB-6.9 remains In Progress and acceptance criteria remain unchecked.
<!-- SECTION:NOTES:END -->
