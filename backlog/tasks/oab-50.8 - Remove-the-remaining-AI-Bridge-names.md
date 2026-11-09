---
id: OAB-50.8
title: Remove the remaining AI Bridge names
status: In Progress
assignee: []
created_date: '2026-11-09T21:46:00Z'
updated_date: '2026-11-09T22:28:00Z'
labels: []
dependencies: []
parent_task_id: OAB-50
priority: high
type: chore
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner approved a breaking rename without compatibility or migration code. The supervisor owns release, deployment checks, reconnection, and local folder changes. Item 8 also adds explicit MCP delete consent.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Accept only obsidian://vaultwire/callback across protocol, plugin, Worker, and tests.
- [ ] #2 Use .vaultwire/, Vaultwire settings conflicts/, and vaultwire-sync-status without moving old folders.
- [ ] #3 Use vaultwire: device storage keys without migration. Tests prove hash reconciliation preserves data with stale journal, stale epoch, or missing credentials.
- [ ] #4 Use vaultwire as the production object key. Reject tokens without a grant in the new registry. Record that old history and export lists remain in the old object.
- [ ] #5 Remove legacy plugin migration code, commands, tools, documentation, target keys, and old plugin exclusions. Keep vaultwire and .vaultwire exclusions.
- [ ] #6 Remove the VAULTWIRE_CUTOVER_AUTHORIZED deployment guard and its test expectations.
- [ ] #7 Update current docs, tooling, tests, and development vault names. Rename docs/api/f2.md and fix links if it denotes a legacy phase.
- [ ] #8 Advertise vault:read vault:write vault:delete. Consent keeps read mandatory and grants only checked requested scopes. Devices retain delete. Update spec and tests.
- [ ] #9 Name search returns only permitted history matches. Report every remaining match and reason. bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Plan: docs/superpowers/plans/2026-11-09-remove-legacy-names.md. One implementer owns the breaking rename, stale-state safety tests, MCP scope consent, docs, tooling, and checks. Wait for plan approval. Then use task review, whole-branch review, Plannotator branch review, rebase, checks, and PR.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner decision: no compatibility period or data migration. Production object key vaultwire selects an empty object. The first connected device imports files. Revision history and the old exports list remain in the old object. Item 8 keeps delete separate and lets the owner narrow requested scopes. No live actions are authorized.

Implementation steps 1–3 completed on feature/remove-legacy-names. bun run check passed with exit 0. It passed lint, docs:check, all workspace typechecks, all tests, and dry-run builds. Test totals: tooling 107, protocol 314, plugin 850 passed and 1 skipped, Worker 1055 across its three suites. Biome reported 15 existing non-null-assertion warnings and no errors. Focused Worker consent and OAuth/MCP tests passed 103 tests. Focused plugin session, storage, journal, enrollment, and desktop-acceptance tests passed 258 tests. No live service, vault, deployment, or Cloudflare resource action ran. Remaining current-surface matches: wrangler.production.jsonc and its deployment-preflight/config fixtures retain the released transfer migration source name; docs/spec.md records wiped legacy resources as history; oauth.test.ts rejects the old provider-identity digest; device-storage.test.ts constructs the former local key for its ignored-key test; release-please-config.test.ts, release.test.ts, and release-versions.test.ts preserve legacy tag/plugin-ID rejection cases; deployment-config.test.ts asserts removal of the cutover secret; product-labels.test.ts checks that the former API path is absent. Older Backlog task records and historical plans retain pre-cutover names and remain unchanged. No old local keys, data, or migration code are read or migrated.

Test-first exception: no baseline RED run was retained for each added regression test. Focused tests and bun run check passed after implementation. I do not claim baseline RED evidence. The first full check failure came from a stale tooling assertion for the renamed API guide, not a product regression.
<!-- SECTION:NOTES:END -->
