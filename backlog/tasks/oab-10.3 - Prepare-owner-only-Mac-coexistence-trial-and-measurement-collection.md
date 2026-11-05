---
id: OAB-10.3
title: Prepare owner-only Mac coexistence trial and measurement collection
status: In Progress
assignee:
  - '@pi'
created_date: '2026-11-05T12:48:00Z'
updated_date: '2026-11-05T15:44:00Z'
labels: []
dependencies:
  - OAB-10.2
documentation:
  - docs/spec.md
parent_task_id: OAB-10
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The supervisor performs real-vault steps for the owner. Agents and subagents never access the real vault. This task ships supervisor instructions and service-only measurement collection tooling for the bounded F4 trial. Scope: spec §7.10, §11.5, §12, and §14. Read OAB-10 standing authorizations and the relayed dated-copy confirmation before work. Trial observations belong in OAB-10 notes, not evidence documents.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Instructions record supervisor-relayed confirmation of a dated local copy outside iCloud before any real-vault step. The supervisor performs these steps for the owner. Agents never access the real vault.
- [ ] #2 Instructions cover supervisor installation for the owner, coexistence mode, Mac-only operation, and a trial duration of at most two weeks.
- [ ] #3 Collection tooling uses service data only and cannot inspect or change the personal vault. Tests cover this boundary and secret-safe output.
- [ ] #4 Instructions explain attention review, measurements, Pause, empty-queue exit, and supervisor disable or cutover for the owner without cloud resource changes.
- [ ] #5 The deliverables do not claim completion of the owner trial. OAB-10 retains trial dates, results, attention explanations, and evidence limits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Approved plan: /tmp/oab-10-3/2026-11-05-f4-trial-tooling.md, Plannotator pn-2392a5. Build the service-only boundary and tests, then the supervisor procedure. Integrate the published measurement export only after the supervisor reports the OAB-10.2 merge. Run full checks, task review, branch review, human review, and publish one PR. Do not claim trial completion.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Authorization update, 2026-11-05: The supervisor performs the real-vault steps for the owner, including installation and enablement when this task is ready. The supervisor relayed dated-copy confirmation. Read OAB-10 Standing authorizations for F4 before work. Owner-manual wording in this task includes this authorized supervisor. Agents and subagents still never access the real vault.

The supervisor authorized parallel execution despite dependency order. The owner approved the plan through pn-2392a5. PR #56 merged at 7abee2c and this branch contains origin/main. The supervisor-relayed backup confirmation and F4 access limits remain binding. Agents never access the personal vault or its backup. The supervisor authorized steps 2 and 3 before the decomposition merge. Published-contract integration waits for the OAB-10.2 merge report.

Bounded steps 2 and 3: worker commit a08a264 adds the local safe measurement projection, credential-file boundary, synthetic tests, and supervisor procedure. Expected RED recorded test exit 1 before implementation. Final bun run check passed lint, docs, types, 1558 tests with 1 skipped, and builds. Worker report: /tmp/oab-10-3/worker-result.md. No live service, vault, backup, browser, install, or cloud action ran. Published protocol integration waits for the supervisor OAB-10.2 merge report. Independent task review and whole-branch review remain pending. No acceptance criterion is closed by this intermediate result.

Published integration uses the public MeasurementResponseSchema and MEASUREMENT_LIMITS after PR #57. The CLI reads GET /owner/measurements at the fixed HTTPS service origin, rejects redirects, bounds response and credential bytes, and emits static errors and allowlisted output. It preserves observed lower bounds, UTC windows, unknown and stale states, sample evidence, and distinct storage meanings. The existing workspace protocol dependency explains the tooling package and lockfile change. No external dependency was added.

Review chain: task review 07777125 examined 72b76d4 with the code-review skill and TypeScript profile. Four minor findings closed at 54c1bc9: optional sample times, shared protocol caps, separate unknown/stale output, and credential permissions. Full branch review eba0a2b4 examined 54c1bc9 against 3bd801b and closed all four. It found B1 feed-only snapshot rejection and N1 missing sample counts for unknown p95. Corrective review 9ce59d8b approves final 317b470 and closes both through the exact mapper, validator, formatter, and regression tests. Structural review found cohesive transport, projection, and credential boundaries. It audited named declarations, useful TSDoc, tests, configuration, and the supervisor guide. The request-availability/coverage matrix and percentile/sample-evidence matrix now retain each distinct state.

Final worker validation after scope cleanup: bun run check exited 0 with 1845 passing tests and 1 skipped, plus lint, docs, type checks, and builds. B1/N1 RED recorded 2 failed and 20 passed before correction. Focused GREEN passed 23 tests. An added Worker test exceeded the assigned scope and the worker restored it exactly to origin/main at 317b470. The final branch has no Worker source or test delta. No live service, vault, backup, browser, install, or Cloudflare action ran. The guide keeps OAB-10.1 controls provisional. The credential reader cannot pin parent directories against replacement, so the procedure limits use to an owner-controlled credential tree. Human branch review remains pending. OAB-10 retains the actual trial and its evidence limits.
<!-- SECTION:NOTES:END -->
