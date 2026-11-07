---
id: OAB-43
title: >-
  Remove the F2 prefix from Cloudflare resource names and migrate the blob
  bucket
status: To Do
assignee: []
created_date: '2026-11-07T13:40:00Z'
labels:
  - infra
  - F6
  - cleanup
dependencies: []
priority: low
ordinal: 79000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner order 2026-11-07: remove the historical F2 phase prefix from the Cloudflare resources and leave the naming clean. Two parts. Part A (labels and internal names, no risk): rename the KV namespace title oab-f2-oauth, the Access application and IdP names, and the OpenTofu resource and output names with moved blocks, in cloudflare-infra. Part B (bucket migration, production blobs): R2 cannot rename a bucket. Create oab-blobs in OpenTofu, copy every object from oab-f2-immutable-blobs, switch the production binding, verify, then delete the old bucket. The copy needs an R2-scoped token created through OpenTofu, or a temporary owner-only Worker route that copies between bindings. Pause sync on Mac, iPhone and iPad during the binding switch. Take a packed export before the switch. Order: after OAB-42 merges, because both touch wrangler.production.jsonc. Every Cloudflare change goes through a cloudflare-infra PR that the owner merges.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Part A: KV title, Access application name, IdP name, and OpenTofu resource and output names carry no F2 prefix. The plan shows 0 to create, 0 to delete, only in-place updates and moves.
- [ ] #2 Part B: a packed export completes before the switch and its download is verified.
- [ ] #3 Part B: oab-blobs holds the same object count and the same hashes as oab-f2-immutable-blobs before the binding switch. A listing comparison is recorded in the task notes without secrets.
- [ ] #4 Part B: sync is paused on the three devices during the switch. After deploy, a blob read and a blob publish succeed from the Mac vault, then sync resumes on every device without attention items.
- [ ] #5 Part B: the old bucket is deleted only after one full day of clean use on the new bucket, through a cloudflare-infra PR with the owner's explicit order.
- [ ] #6 docs/spec.md, docs/api and wrangler.production.jsonc name the final bucket. No tracked file holds a token value or the owner subject.
<!-- AC:END -->
