---
id: OAB-27
title: 'Deferred: Show authoritative revoked client state in the owner console'
status: Deferred
assignee: []
created_date: '2026-10-28T16:48:00Z'
updated_date: '2026-10-28T16:49:00Z'
labels:
  - deferred
  - owner-console
dependencies: []
references:
  - OAB-7.8
documentation:
  - docs/spec.md
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-7.8 finding S2 remains open. At 16:46Z on 2026-10-28, revoked probe noscope and probe rw stayed listed, but the revoked MCP Inspector 7.8 client disappeared. Registry grant counts and Revoke actions do not prove active authority.

Trigger: before the owner relies on console listings for client-state decisions, explain retained history and show authoritative revocation and cleanup state. Preserve DO-first denial and assess the different listing outcomes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The console distinguishes active, revoked, and cleanup state from retained grant history with authoritative data.
- [ ] #2 Tests explain retained revoked clients and removed clients, including repeated revocation and provider cleanup outcomes.
- [ ] #3 Revoked grants still fail at the DO before reads or writes, regardless of console or provider cleanup state.
<!-- AC:END -->
