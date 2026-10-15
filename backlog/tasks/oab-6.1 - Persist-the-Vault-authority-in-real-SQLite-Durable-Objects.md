---
id: OAB-6.1
title: Persist the Vault authority in real SQLite Durable Objects
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:36'
updated_date: '2026-10-15 02:24'
labels:
  - F1
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
F0 has no Durable Object or authoritative storage. Establish the real persistent authority before adding operations, using the frozen section 5 schema and section 14 F1 entry boundary. This is local implementation only after the human-reviewed plan; no public routes or remote resource changes are part of this slice.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A real SQLite-backed Vault initializes the section 5.2 tables and indexes atomically, including the required FTS5 trigram tokenizer and future export-pin seams without implementing deferred features.
- [x] #2 The persisted epoch is a cryptographically random 128-bit, 32-hex-character generation; epoch, creation time and schema version survive repeated initialization without resetting existing data.
- [x] #3 Real Workers runtime tests demonstrate transactional rollback, isolated vault identities, supported schema limits and exact trigram/diacritic behavior; unsupported or corrupt schema state fails closed rather than reinitializing data.
- [x] #4 The Worker keeps its existing default-deny behavior, configured typechecks/runtime isolation and the 49 foundation tests; local binding/migration configuration is tested without contacting or mutating Cloudflare resources.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved docs/superpowers/plans/2026-10-15-f1-vault-persistence.md in pn-10c0db and explicitly selected subagent-driven execution. Implement only its Task1: real persistent SQLite Vault authority and local configuration/tests, preserving the current default-deny public Worker. The controller owns test execution, semantic review gates, Backlog closure and publication; no later F1 subtask or remote resource action is authorized.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation finding against the approved plan: parent run b20281074 collected0tests because @obsidian-ai-bridge/protocol cannot resolve from the Worker. The Worker manifest currently declares only Hono, so the planned public cross-workspace import lacks its required dependency edge. Ruling: add only @obsidian-ai-bridge/protocol: workspace:* to Worker dependencies and refresh the existing Bun lockfile via parent-run install. This consumes the existing canonical in-repository public package; no new external package/version/toolchain is authorized. The plan assertion that no manifest change was needed was incorrect. Reason: preserve AGENTS public-export boundaries instead of private alias imports or undeclared hoisting. Cost if wrong: reversible manifest/lock metadata change. Package-loader failure is harness RED, not feature RED; real missing-binding/schema assertions must still be observed before storage implementation.

Concrete validation/configuration finding: parent active LSP probe finds18errors in vault-storage.test.ts because cloudflare:workers and cloudflare:test are not acquired by its current inferred project; src/env.ts is clean. Runtime imports are verified but do not repair editor/compiler type acquisition. Ruling: add a separate apps/worker/test/tsconfig.json extending the existing Worker config, explicitly acquiring @cloudflare/workers-types and the official @cloudflare/vitest-plugin/types declaration export, and including tests plus Worker source for its native Env augmentation. Keep production tsconfig.json includes/types unchanged, preserve one-way inheritance, and append a native test-project check after the existing source check in the Worker typecheck script. No package addition/version update, fabricated SDK declaration or diagnostic suppression. Reason: satisfy actual test typing guard while strengthening executable compiler coverage rather than widening production ambient scope. Cost if wrong: a small reversible test-validation configuration/script change. Validate with native source+test compiler commands and active LSP before resuming bootstrap.

Observed full GREEN b10116ff6: Biome42files, all configured native source/tooling compilers including the separate Worker test project, 57 tests (41 protocol + 2 plugin + 14 Worker = unchanged49foundation + 8persistence), all local builds. Wrangler4.45 dry-run reports493.38KiB/gzip77.10KiB and VAULTS(Vault), then exits dry-run without deployment. Backlog doctor clean; git diff --check exit0. Earlier focused b2266593f passed8/8 then stopped at two safe organizeImports findings; full success is credited only to b10116ff6 after those fixes. Independent task/whole-branch reviews and human diff gate remain pending; no acceptance closure or whole-F1 qualification claimed.

Pre-commit self-review found a real malformed-metadata gap after historical full GREEN b10116ff6: arbitrary-length head_seq/live_file_count decimals pass regex and created_at exponent form 1e3 passes Number conversion. Parent authorizes a bounded fix under the existing fail-closed requirement, but requires test-only regressions and actual parent-observed RED before changing source. Canonical count fields must be nonnegative safe integers; created_at canonical signed safe-integer milliseconds preserves existing signed support without inventing a nonnegative spec restriction. Rejection must preserve corrupted metadata/fixture/epoch and never mint replacement identity. No commit, independent review or acceptance closure until refreshed GREEN and review package.

Numeric metadata regression actual RED b2c7e990d:9tests8pass1fail at expected initializer throw; product fix followed the observed failure. Refreshed full GREEN bc5826186: focused9/9, Biome42clean, all native workspace/source/tooling/test compiler commands,58tests(41protocol+2plugin+15Worker),alllocalbuilds; Wrangler4.45dryrun493.66KiB/gzip77.17KiB VAULTS(Vault) exits without deploy. Doctor clean and diff-check0. FreshLSP on changed2paths:0findings but1clean/1inconclusive, not a blanket confirmed-clean claim. Independent reviews/human gate and final-head checks remain pending; source task not closed.

Independent task compliance/quality reviewer5fce36c8 returned CHANGES against dbbd5b3; conditional workflow5dfe6419 stopped before whole-branch Sol review. Finding1: table/index name-only validation accepts incompatible same-named definitions (columns/constraints/live-index predicate/FTS tokenizer); parent verified source initializeVaultStorage81-157. Finding2: missing useful TSDoc for frozen schema/version/entropy/no-repair initialization contract. Both accepted for bounded correction, not deferred. Resume original writer: test-only same-name corruption regressions and actual native RED before product fix; preserve schema inventory/data/epoch and never repair or mint identity. Then minimal authoritative-definition validation plus concise semantic TSDoc, full refreshed checks and explicit finding closure re-review. No new dependency, protocol shape, migration framework or later F1 work.

Review correction pass1: actual b1dcfa6e2 assertion RED12tests9pass3fail for same-named wrong live-index predicate, renamed required column and wrong FTS tokenizer. Definition verification now derives expected SQLite objects from the single frozen SCHEMA source and checks type/definition without repair; useful persistence/entropy/version TSDoc added. Focused bd1388ff5 PASS12/12. Full b35fa8128 GREEN:Biome42,allconfigurednativeTSC,61tests(41protocol+2plugin+18Worker),alllocalbuilds;Wrangler4.45dryrun494.23KiB/gzip77.42KiB VAULTS(Vault),doctorclean,diffcheck0. Fresh LSP2changedfiles confirmedclean. Findings1/2 implemented but not independently closed yet; scoped correction commit/report and re-review pending before whole-branch Sol/human gates.

Independent corrective review4eeacd47 closed Finding1(schema definitions) and Finding2(contract TSDoc) as Fixed against1081656; complete resulting original c526..108 implementation, stateful/cohesion matrix and controlled normalization inspected. Verdict OK, no actionable findings. Conditional workflow48787992 stopped only because bold Markdown **TASK_REVIEW_STATUS=PASS** did not match bare-line regex; parent read full report and accepted actual approval without rerunning review. Whole-branch Sol audit remains pending; no task closure or publication yet.

Final whole-branch Sol3f522143 reviewed exact20file base43fc..108 plus execution-note overlay, code APPROVE WITH NOTES/design ready with bounded follow-ups; no functional/platform blocker, previous Findings1/2 independently Fixed. One non-blocking MINOR FINAL-DOC-1 remains: document adapter-local descriptor kinds, controlled semicolon/header DDL assumptions, whitespace normalization including literals and canonical-integer sign policy beside private declarations. Parent elects a documentation-only correction now; no SQL/behavior/parser/dependency change. Source still requires final scoped documentation closure, exact-head checks and human diff approval before task closure/publication. Full review includes primary platform verification and aggregate first-slice budgets; no whole-F1/client or remote-runtime qualification claimed.

Final source head2e77a291 independently approved by Sol closure4a1bf865: code APPROVE, design ready, no actionable findings; FINAL-DOC-1 and original Findings1/2 Fixed. Fresh exact-source-head verification bae583ef6 passed with HEAD unchanged before/after: frozen install124/274 unchanged, Biome42, all native configured compilers,61tests(49foundation+12persistence),alllocalbuilds,Wranglerdryrun494.23KiB/gzip77.42KiB VAULTS(Vault),doctor and diff-check clean. AC1: native schema/index/tokenizer bootstrap and rollback tests. AC2: native CSPRNG/canonical epoch plus repeat/eviction identity/time/version/data preservation. AC3: native isolation, rollback,1MBrow,literaltrigram/diacritics,unknown/newer/numeric/same-name corruption fail-closed tests. AC4: all49foundation cases,source/test isolation/native typechecks and local binding/migration dry-run without deployment. Four AC checked on observed evidence; status remains In Progress pending human branch-diff approval. No full-F1/client/remote-runtime qualification or later-slice execution.
<!-- SECTION:NOTES:END -->
