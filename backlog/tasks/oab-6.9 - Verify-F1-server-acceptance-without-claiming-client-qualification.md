---
id: OAB-6.9
title: Verify F1 server acceptance without claiming client qualification
status: To Do
assignee: []
created_date: '2026-10-15 00:38'
updated_date: '2026-10-23T02:05:00Z'
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
