---
id: OAB-8.6
title: Synchronize blobs with guarded apply and recovery copies
status: To Do
assignee: []
created_date: '2026-10-28T19:31:00Z'
labels: []
dependencies:
  - OAB-8.5
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 44000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Complete attachment and oversized text handling through the existing blob protocol. One focused PR. Preserve the approved binary residual window and use no Node or Electron APIs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 AC-31 changes mtime between hash verification and writing. Apply stops and preserves the current bytes as a conflict copy.
- [ ] #2 Binary apply uses double stat, durable pre-apply bytes, read-back verification, and seven-day recovery retention. Base advances only after confirmed bytes.
- [ ] #3 Scope matches section 7.8, including 25 MB limits and all exclusions. Binary and oversized text publication uses immutable journal payloads and the authorize/commit protocol.
<!-- AC:END -->
