---
id: OAB-26
title: 'Deferred: Use an opaque OAuth provider identity'
status: Deferred
assignee: []
created_date: '2026-10-28T16:48:00Z'
updated_date: '2026-10-28T16:49:00Z'
labels:
  - deferred
  - privacy
dependencies: []
references:
  - OAB-7.8
documentation:
  - docs/spec.md
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAB-7.8 finding S1 remains open. The provider authorization code exposes the owner subject as its user-id prefix in browser history and client logs. This is a privacy concern, not proof of an Access bypass.

Trigger: before broader third-party client use, select and test a safe identity transition. Preserve durable authority and existing grants. Do not record actual subjects, codes, or tokens.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New authorization codes and tokens do not expose the owner subject as the provider identity.
- [ ] #2 Tests cover stable owner mapping, token callback matching, provider cleanup, and the documented treatment of existing grants.
<!-- AC:END -->
