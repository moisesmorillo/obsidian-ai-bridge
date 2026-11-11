---
id: OAB-65
title: Start plugin publication only from the Release Please call
status: Done
assignee: []
created_date: '2026-11-11T15:12:00Z'
updated_date: '2026-11-11T15:13:00Z'
labels: []
dependencies: []
priority: low
type: bug
ordinal: 108000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Security audit lead workflow.release.tag-trigger-publish-authority (2026-11-11). A push of a vaultwire-v* tag starts .github/workflows/release.yml with contents: write and pull-requests: write. Release Please already calls the workflow through workflow_call, and a tag created with GITHUB_TOKEN never starts a workflow, so the tag trigger is unused. Owner approved removing it on 2026-11-11.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 release.yml has no push trigger and takes the tag only from the required workflow_call input
- [x] #2 A tooling test fails if a push or tag trigger returns
- [x] #3 docs/plugin-release.md describes recovery by rerunning the Release Please run instead of a manual tag push
- [x] #4 bun run check passes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RED: new tooling test failed on the push trigger before the workflow change. GREEN: removed push.tags, every tag reference now uses the required workflow_call input, concurrency group keys on inputs.tag. Local check green (tooling 108, protocol 343, plugin 909+1 skipped, worker 883/138/162). Inline review: no findings. Recovery path is a rerun of the failed Release Please jobs, proven on run 43012203948.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Removed the vaultwire-v* tag trigger from the plugin release workflow. Only the Release Please call can publish.
<!-- SECTION:FINAL_SUMMARY:END -->
