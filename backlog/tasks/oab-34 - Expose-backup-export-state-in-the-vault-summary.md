---
id: OAB-34
title: Expose backup export state in the vault summary
status: Deferred
assignee: []
created_date: '2026-11-02T23:31:00Z'
labels:
  - deferred
dependencies: []
references:
  - packages/protocol/src/schemas/reads.ts
documentation:
  - docs/spec.md
type: enhancement
ordinal: 54000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The public vault summary has no backup export result. The plugin cannot distinguish backup failure from absent telemetry. Owner approved this deferral during OAB-8.7 plan review pn-b379a1. Trigger: F3b export delivery. Keep backup status unknown until this contract exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GET /v1/vault exposes validated backup export state through canonical protocol schemas without secrets.
- [ ] #2 The plugin shows backup failed for a confirmed failed export and unknown when telemetry is absent.
- [ ] #3 Tests cover successful, failed, absent, and stale export observations without false settled or healthy claims.
<!-- AC:END -->
