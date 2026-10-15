---
id: OAB-6.1
title: Persist the Vault authority in real SQLite Durable Objects
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-15 00:36'
updated_date: '2026-10-15 00:58'
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
- [ ] #1 A real SQLite-backed Vault initializes the section 5.2 tables and indexes atomically, including the required FTS5 trigram tokenizer and future export-pin seams without implementing deferred features.
- [ ] #2 The persisted epoch is a cryptographically random 128-bit, 32-hex-character generation; epoch, creation time and schema version survive repeated initialization without resetting existing data.
- [ ] #3 Real Workers runtime tests demonstrate transactional rollback, isolated vault identities, supported schema limits and exact trigram/diacritic behavior; unsupported or corrupt schema state fails closed rather than reinitializing data.
- [ ] #4 The Worker keeps its existing default-deny behavior, configured typechecks/runtime isolation and the 49 foundation tests; local binding/migration configuration is tested without contacting or mutating Cloudflare resources.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Owner approved docs/superpowers/plans/2026-10-15-f1-vault-persistence.md in pn-10c0db and explicitly selected subagent-driven execution. Implement only its Task1: real persistent SQLite Vault authority and local configuration/tests, preserving the current default-deny public Worker. The controller owns test execution, semantic review gates, Backlog closure and publication; no later F1 subtask or remote resource action is authorized.
<!-- SECTION:PLAN:END -->
