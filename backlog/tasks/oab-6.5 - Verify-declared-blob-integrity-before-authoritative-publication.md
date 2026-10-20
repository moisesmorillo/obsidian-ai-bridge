---
id: OAB-6.5
title: Verify declared blob integrity before authoritative publication
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:38'
updated_date: '2026-10-20 23:30'
labels:
  - F1
dependencies:
  - OAB-6.3
references:
  - OAB-6.8.2
documentation:
  - docs/spec.md
parent_task_id: OAB-6
type: feature
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner explicitly selected declared SHA-256 and byte size for blob PUT during F1 research. This is the approved bounded amendment against spec5.3/6.1/6.3: R2 needs the content-addressed key before consuming the upload, while 16 buffered 25 MB requests already exceed the 128 MB shared isolate limit. Keep authentication-before-storage and immutable blob references; do not introduce staging keys or GC.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Canonical protocol schemas and useful API documentation define the approved declared SHA-256/byte-size requirements and errors; the affected spec contract is amended through this task rather than a new spec-only review round.
- [ ] #2 Actual size and digest are verified with bounded backpressure before any DO reference is committed; forged hashes, declared-length mismatch, unknown transport length, cancellation and R2 failure cannot corrupt an existing content-addressed object.
- [ ] #3 Binaries and oversized Markdown/canvas obey the 25 MB blob and 1 MB inline rules; exact bytes, large markers, range reads and search exclusion satisfy AC-16, while revoked uploads satisfy AC-28.
- [ ] #4 Aggregate application-retained upload data stays within 32 MiB across clients in one isolate, including Worker buffers, strings, validation copies, and active authority values. Native workerd buffers, transport-retained RPC results, and native-layer fragments remain outside this limit. Retry after R2 success or an uncertain response stays safe and leaves at most authorized unreferenced blobs.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved Plannotator pn-be5940. Plan: docs/superpowers/plans/2026-10-19-f1-blob-integrity.md. Task 1 defines canonical blob contracts and the shared four-slot body budget. Task 2 adds immutable storage evidence and atomic native blob publication. Task 3 adds bounded streaming, HTTP integration, and cross-client upload evidence. Each worker owns RED, implementation, full checks, formatting, and commits. Independent task reviews, whole-branch review, and human branch review precede closure and publication. Blob PUT alone needs X-Content-SHA256 and X-Content-Size. No staging keys, GC, dependencies, deployments, or personal-vault access.

Task 3 execution uses two serial delivery units after the first worker stopped without a product change. Unit 3A completes the immutable streaming adapter and native stream tests. Unit 3B completes application orchestration, HTTP paths, shared body-slot lifetime, and aggregate upload evidence. Each unit owns full checks, its commit, and independent review. Scope, contracts, memory targets, and owner gates remain unchanged.

Owner approved the single compatibility flag unhandled_rejection_after_microtask_checkpoint in apps/worker/wrangler.jsonc after a controlled external comparison. Keep compatibility date 2025-07-12 and all dependencies unchanged. The flag corrects rejection-report timing, not cancellation semantics. Resume original native probes, adapter tests, full bun run check, and independent review. Do not deploy or change Cloudflare resources.

Owner approves Sol medium for all remaining Task 3B implementation after two incomplete Luna runs. Preserve partial working code, complete the original scope and aggregate proof, and retain all test, check, commit, and independent review gates. Keep the 90-minute worker bound. No deployment or dependency change follows from this approval.

Owner approves design work only for an authority payload-and-result capacity contract. Compare credit and demand-gated streaming approaches. Keep the 32 MiB target, authority copies, four frontend slots, CAS, receipt recovery, and deployment restrictions. Review the concrete design before any policy implementation.

Owner agrees to restore the original retention boundary and validate the real HTTP path. Keep 32 MiB for application-created or retained payload data, including authority copies, rooted RPC values, and error/response preparation. Report opaque transport, SDK, and GC costs separately without claiming platform headroom. Preserve four frontend slots and all spec limits. Do not continue the stopped stream design or add admission policy without approval.

Final owner decision on criterion 4, 2026-10-20, replaces the earlier native-retention scope. Count only application-created and retained Worker buffers, strings, validation copies, response preparation, and authority values during active operations within 32 MiB. Exclude native workerd buffers, transport-retained RPC results, and native-layer fragments. R1 is intentionally deferred to OAB-6.8.2. Complete branch review, human Plannotator review, and PR. No further criterion proposal or criterion review. Ask only if bun run check fails or the spec must change.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved implementation plan pn-be5940. Task 1 source commit 6f407b2 passed bun run check: 669 tests, zero failures. Initial RED reached only a missing-module setup failure, not a functional assertion. Retain working code and record this exception honestly. Independent task review remains pending. No acceptance criterion is complete yet.

Task 1 correction commit 3404689 adds canonical paired wire headers, blob failure codecs, bounded storage retry delays, and an exact duplicate-release regression. Worker full check passed 674 tests, exit 0. The worker changed implementation before its first correction test run, so this correction also lacks functional RED. Preserve the working code and this process exception. Corrective independent review now uses local copies of the full code-review skill and TypeScript profile. Acceptance remains pending.

Task 1 passed independent review at 9d0522d. F1 paired headers, F2 failure codecs, F3 duplicate-release coverage, and P2 admission retry compatibility are fixed with direct evidence. The final retry correction captured functional RED before code changes. Earlier Task 1 retained-code exceptions remain recorded. Full check passed 675 tests. Continue approved Task 2 only. Native blob publication, streaming, aggregate proof, and acceptance criteria remain pending.

Task 2 implementation reached 55c8080. The worker captured functional RED against a typed unimplemented metadata adapter after the file gate rejected an unresolved import. Full check passed 692 tests, exit 0. Native publication used 29 application SQL dispatches, at most 12 bindings. Record encodings measured files 199, revisions 182, blob_refs 74 bytes. These exclude B-tree/page overhead. Independent review remains pending. Task 3 and all acceptance criteria remain pending.

Task 2 passed independent review at e2ff053. The direct missing-object boundary test closes its only finding. Full check passed 693 tests, exit 0. Native authority now checks stored checksum evidence and preserves atomic references and history. Continue approved Task 3 for bounded streaming, HTTP paths, and cross-client memory evidence. All task acceptance criteria remain pending until complete branch review and human review.

Task 3A stopped incomplete. The partial adapter remains uncommitted and has known early-null producer blocking and cancellation gaps. One controlled-fixture test passes, but native R2 integrity, aggregate bounds, and the failure matrix remain unproven. docs:check failed on missing constant contracts. The full check failed before formatting correction and did not run again. Preserve the partial source and genuine RED. Do not treat this as an accepted implementation or start HTTP integration. Parent asks the owner about model escalation after repeated incomplete implementation results.

Task 3A remains blocked after Sol implementation and independent runtime review. The minimal native BYOB cancellation probe contains no adapter or R2 call, observes exposed promises, and still causes an unhandled cancellation rejection. A bounded promise-identity trace matched no exposed promise and proved no exact internal owner. Final focused output has 66 successful assertion cases, two unhandled errors, and exit 1. Final full check passes lint/docs/types but exits 1 in native Worker tests. HTTP tests and builds do not run after that failure. No source commit or runtime/dependency/configuration change occurred. The test stack uses workerd 1.20261006.1 and MINIFLARE_WORKERD_PATH is unset. Preserve all evidence and uncommitted adapter/tests. Owner runtime decision remains pending. No acceptance criteria close and no publication starts.

The owner-approved isolated comparison found no working candidate. Baseline official plugin 1.4.0/workerd 1.20261006.1/Vitest 5.0.4 and three alternatives all reproduce the native cancellation error. Alternatives compare workerd 1.20261019.1 alone, official plugin 1.4.5 with matching Miniflare/workerd, and supported Vitest 4.1.0. All start successfully. Sink-stop controls exit 0. All pending-BYOB-cancellation probes exit 1 with one unhandled rejection. Repository source/configuration/dependency hashes remain unchanged. No candidate integration or dependency update follows. The bounded comparison is complete. Report: task-3a-runtime-comparison-report.md in private task artifacts.

External flag-only evidence: same workerd binary/date/probe sequence fails without the flag and passes with it. A separate deliberate genuine-unhandled control still reports its error with the flag. This validates a configuration candidate only. Owner approved single-flag integration and complete adapter validation. Task 3A, aggregate acceptance, branch review, and human review remain incomplete.

Task 3A accepted after independent Luna high review at 9f0ae1db3fb5034f2e7d2d691046909b93f56a75. Review verdict APPROVE. The reviewer inspected source, test semantics, stored evidence, reporting-flag controls, and final logs. No independent test rerun or Git comparison occurred. Parent verified the exact three-file source commit. Full checks pass 759 tests on committed bytes, including 66 adapter cases. The review closes null-sink deadlock, false null evidence, early prefix publication, fake/native proof confusion, and pending-BYOB reporting failures. Task 3B HTTP integration, shared slot ownership, and aggregate retention proof remain incomplete. Acceptance criteria remain unchecked.

The first Task 3B worker read the scope and reported incomplete work without source changes, tests, or a concrete blocker. No Task 3B acceptance follows from that report. Parent resumes the same worker once with the approved implementation scope and unchanged model. All original safety and acceptance gates remain in force.

The corrective Task 3B run adds inline PUT and command slot wiring plus one HTTP saturation test. No commit exists. The worker reports passing local checks but leaves blob orchestration, raw reads/ranges, remaining HTTP cases, direct admission-row refusal proof, aggregate retention proof, and full review incomplete. Initial test runs timed out, so they do not establish clean assertion-based RED. Preserve the partial code and record this exception. Parent stops further execution changes and requests owner approval for a model escalation or smaller serial units. Full acceptance remains unchanged.

Sol commits 4f15203 and 437e584 implement functional Task 3B and state-based blob append failures. The worker reports 840 passing tests and full checks. Task 3B remains incomplete. The 32 MiB upload-owned retention proof does not bound authority-side work from multiple frontend isolates. Caller demand observations do not resolve authority fan-in, argument materialization, or combined ownership. No new authority policy, target change, or exclusion follows from this report. Parent requests independent code and design-feasibility review before an owner decision. Preserve both commits and all RED evidence. Acceptance criteria remain open.

Independent Sol code and design review covers the complete 29-file Task 3B unit through 437e584. It finds no separate functional defect and closes the named functional findings. Governing verdict remains not ready because R1 lacks an authority-inclusive 32 MiB proof. The review rejects the 34-input crypto-overlap argument: pinned workerd digest runs synchronously. The remaining evidence gap concerns native RPC plain-result retention and release, not a proved heap breach. Parent resumes the same Sol implementation owner for one focused native result-lifetime investigation and complete inventory. No new capacity policy follows without owner approval.

Native test commit 512b54a adds three result-ownership cases. The worker reports 843 passing tests. The unprobed 34-result case holds caller deserialization through native actor input gates and observes later authority progress. This is logical ownership evidence, not a heap breach measurement or deployed multi-frontend trace. R1 remains open. Native temporary formatting/docs/type errors ended in passing final checks. Parent requests independent review of the new test and bounded design comparison. No new capacity policy follows from the owner design-only approval.

Independent corrective review accepts the test-only patch 512b54a without a new test defect. It validates local blocked-actor result ownership and rejects transfer to a deployed ordinary-frontend heap breach. R1 stays open. Proposal A uses pre-materialization weighted credit and protected result/response release. Proposal B uses demand-gated delivery. Neither proposal has a complete passing budget or proved release mechanism yet. The owner approves a concrete design only, not implementation. Parent assigns a bounded design author to produce the phase ledger, release contract, recovery rules, exact RPC counts, and explicit owner decisions before human review.

The design author selects demand-gated input/result streams as a candidate and rejects acknowledgement-only full-value release. No policy enters product code. The written proposal is docs/superpowers/specs/2026-10-20-authority-payload-capacity-design.md. Conditional payload arithmetic is 27,145,728 bytes, not a complete passing budget. Native queue/terminal release, pre-arrival credit, malformed normalization, and control storage remain open. The proposed weighted refusal and longer response lifetime need explicit owner approval. Parent requests a fresh builder check before the owner decision batch. R1 and task acceptance stay open.

Fresh builder review keeps R1 and implementation approval blocked. It identifies safe native release and admission before payload arrival as the first two feasibility questions. Continue source-only work within the existing design approval. Do not ask the owner to approve unproved 12M/5M/8B constants. No native probe, policy implementation, public behavior change, or acceptance follows. A later bounded probe needs separate approval and exact observable events.

Source-only feasibility stops the selected four-call stream sequence. Pinned workerd exposes external-stream admission before application token validation, without a reservation hook. Platform HTTP/deferred-proxy and outstanding streaming owners lack a complete application terminal/recovery accounting contract. Capn Proto streaming send provides flow-control readiness, not complete delivery. These are scoped negative findings, not a proof that every stream architecture fails or a measured heap breach. The design now says Do not implement. A local timing probe cannot close the hidden-owner guarantees. Parent asks the owner whether to pause with preserved work or approve a broader architecture design scope. No implementation, native probe, target relaxation, task closure, push, PR, or deployment follows.

The owner asks why 32 MiB applies when vault assets are small. This is an aggregate planning ceiling, not a file size or measured personal-vault usage. Personal-vault access remains forbidden. The next unit validates ordinary HTTP production paths and actual application ownership. Actor-gate characterization does not prove ordinary frontend accumulation. No acceptance gap closes solely from tests or from excluding authority data.

Ordinary HTTP validation commits test-only change 0a05329 and reports 846 passing tests. Four small and four maximum-inline PUTs pass. Existing four streamed 25 MB uploads pass. A real HTTP case receives two waves of four content-bearing 412 responses while first-wave bodies remain unread. Each completed body has 6,000,237 bytes due to JSON escaping. This does not prove eight full bodies coexist in the serving isolate or a heap breach. Source shows slot release before Response.json. R1 remains open for ordinary response lifetime and aggregate ownership. Parent asks about a limited response-lifetime correction, not the stopped stream architecture. No product change or acceptance follows from the characterization tests.

Owner approves the limited response-lifetime correction, including possibly longer 429 refusals. Keep four slots, API meanings, file limits, and the original retention target. New corrective plan: docs/superpowers/plans/2026-10-20-mutation-response-lifetime.md. The plan covers joint operation/response completion, bounded failure JSON, cancellation settlement, tests, and explicit remaining R1 disposition. Human plan review precedes code. The stopped stream architecture stays stopped.

Approved response-lifetime correction commits 55e3d65e84e00bd4d168c9f3919e418ba42eeb9d. The author reports 864 tests across 42 files, docs:check and check exit 0. Slots now join operation completion with owned response production. Canonical failure JSON uses bounded windows. Native HTTP second-wave failures now return four 429 responses. R1 remains open for the complete authority-inclusive aggregate bound. Independent corrective review is next. Supplementary source-error, no-body, backpressure, delayed-preparation, mixed application/HTTP, and HTTP correctness tests followed retained working code. Earlier budget, transport, and codec assertion RED remains preserved. No source rebuild or false RED claim. Evidence and full report: ~/.pi/agent/artifacts/obsidian-ai-bridge/oab-6.5/response-lifetime.MmyYFT/. No push, PR, task closure, or deployment.

Independent Luna high review of 0a05329..55e3d65 finds no new code defect. The local response-lifetime corrective unit is OK. Reviewed scope includes complete corrective source/tests, canonical schema, route callers, and spec section 6.5. The reviewer inspected actual final check/docs/focused/RED logs, without repeating full checks. Closure: early response slot release, whole escaped JSON, owned read/cancel cleanup, discarded test responses, and exact-read-size assumption are resolved. Structural ownership is cohesive across budget, application, transport, and protocol. R1 remains P1/MAJOR and blocks overall acceptance. Missing terms are native-rooted authority results and earlier emitted application backing after producer EOF. This is a missing bound, not a proved heap breach. Independent-isolate totals and total deployment RSS stay outside scope. Report: ~/.pi/agent/artifacts/obsidian-ai-bridge/oab-6.5/response-lifetime.MmyYFT/independent-review.md. No new architecture, source change, whole-branch review, push, PR, deployment, or task closure follows without resolution of the acceptance boundary.

R1 closure: intentionally deferred by the final owner decision on criterion 4, 2026-10-20. Owner decision, English translation: "The 32 MiB limit covers only data our application creates and retains: Worker buffers, strings, validation copies, and authority application values while an operation is active. Native workerd buffers, transport-retained RPC results, and fragments retained by native layers remain outside the limit. Close R1 as intentionally deferred." This replaces the earlier expanded native-retention acceptance scope. It does not prove native safety, last-owner release, or platform headroom. Deferred task OAB-6.8.2 triggers real-deployment native-retention measurement during OAB-6.8 runtime-envelope work. Deployment still needs explicit authorization. Plans now state this scope. No spec change is needed: section 6.5 already limits response ownership to application preparation and production. Proceed to final branch code review and human diff review, then PR.
<!-- SECTION:NOTES:END -->
