---
id: OAB-50.3
title: Rename the plugin identifier to vaultwire
status: Done
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T16:46:00Z'
labels:
  - rename
  - plugin
dependencies: []
parent_task_id: OAB-50
type: chore
ordinal: 88000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Repository obsidian-ai-bridge, apps/plugin and plugin tooling. The manifest id becomes `vaultwire` and the name "Vaultwire". Obsidian keys plugin data by id, so local state lives under `.obsidian/plugins/ai-bridge` today. The owner accepts a full reconnect after the cutover. Local edits made before the cutover must not be lost. Install and release tooling, compatibility files and the dev-vault scripts use the new id.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A build produces a plugin with id `vaultwire` that installs next to an old ai-bridge folder without reading or deleting it by accident.
- [x] #2 A documented and tested procedure moves a device from ai-bridge to vaultwire without loss of vault content or unsynced local edits.
- [x] #3 bun run check passes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal
Rename the plugin identifier and preserve device state through an explicit offline migration.

## Architecture and scope
Change manifest metadata, plugin storage and plugin tooling with their tests. Keep package names, other visible text, protocol shapes and Worker files outside this branch. Add the migration guide under apps/plugin/tools to respect ownership.

## Owner decisions
The brief authorizes unattended execution without Plannotator. Stop every client before migration. Reconnect after cutover. Do not create a dual-name runtime. Preserve old files and unsynced edits. Use temporary vault fixtures only. Add no dependency.

## Steps
- [ ] Inspect storage keys, payload paths, release tooling, install tooling and device reconnect behavior.
- [ ] Add failing tests for the new manifest, isolated installation and safe device migration. Cover existing targets, interrupted migration, invalid input and preservation of unsynced state.
- [ ] Change owned tooling and storage. Add an explicit offline migration command. Preserve original state and refuse destructive conflicts. Preserve device-only journal and payload authority rather than resetting it on reconnect.
- [ ] Document desktop and iOS steps, backups, stopped clients, journal handling and reconnect checks. Do not claim a directory copy transfers app localStorage.
- [ ] Run targeted tests, docs checks and bun run check. Commit the task implementation.
- [ ] Run independent task review, address findings, then review the complete branch against main.
- [ ] Rebase on origin/main, verify, close the task, push, create the named PR and remove the worktree.

## Review focus
Journal storage can live outside the plugin folder. Never discard pending operations or payload files. Existing target files must not be overwritten. Migration failure must leave recoverable originals. Settings sync must not publish plugin secrets. iOS instructions must preserve device-local state.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented Vaultwire manifest metadata, release validation, compatibility checks, install/dev-vault tooling, and migration protection. Existing journal, credential, and settings-consent storage keys stay unchanged. RED tests showed failures for the release prefix, activation-state guard, first-copy cleanup, and missing migration command. GREEN targeted tests passed 73 tests across migration and lifecycle files.

Review finding closures: MAJOR startup-order risk closed. The desktop procedure disables AI Bridge before restart. The offline command refuses when community-plugins.json enables either plugin ID. Vaultwire blocks credential restore and hides its settings page until its explicit migration action completes. That action refuses an enabled old plugin, connected or active Vaultwire, and existing Vaultwire data. MINOR iOS access gap closed. The guide uses BRAT and the explicit in-plugin migration command, not Files access to hidden folders. MINOR first-copy retry gap closed. Failed backup copy cleanup preserves old settings and allows retry.

`bun run docs:check` and `bun run check` passed. The full plugin suite passed 32 files with 861 tests passed and 1 skipped. No real device, real vault, or production service was used. Device verification remains for OAB-50.6.

Branch review corrections: F1 closed. The in-plugin migration now replaces and closes the startup session with one built from the imported service address. A lifecycle test starts Connect without editing that address and checks discovery and registration request origins. F2 closed. A device-local approval gate blocks restore, sync, event listeners, and publication while copied settings await a successful OAuth reconnect. The gate preserves stored credentials until that reconnect. A lifecycle test starts with valid old credentials and pending journal work, proves no network or effects before Connect, then proves journal history and payload bytes survive OAuth. F3 closed. Enrollment classification and settings traversal exclude the exact migration backup directory with every settings category enabled. `bun run docs:check` and `bun run check` passed. Plugin tests passed 864 with 1 skipped. No real device, real vault, or production service was used. OAB-50.3 remains In Progress. No push or task closure occurred.

Final acceptance: independent task review and whole-branch review found six issues. Corrections closed each issue. Corrective review approved rebased revision 90dae70ca70e24d96798e5c1fc5a0a0b1cd742fc. Documentation scope: migration guide, affected TypeScript declarations, release and install contracts. Structural candidates: main.ts, plugin-settings-migration.ts, migrate-plugin.ts and desktop-acceptance.ts. The reviewer found clear state ownership after correction. Parent ran bun run check on the rebased tree with exit 0. Artifact, install-isolation, migration failure, pending payload and journal preservation, imported origin, and reconnect admission tests support all acceptance criteria. Physical devices and BRAT ID replacement remain outside this task. OAB-50.6 owns those checks. Earlier In Progress notes describe the state before acceptance.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Changed the plugin ID to vaultwire and updated release, compatibility and install tooling. Added tested desktop and in-plugin migration procedures that preserve device-local state and pending edits. Explicit reconnect approval prevents automatic sync to the old service. Task and branch reviews closed all findings. Final bun run check passed on the rebased branch. OAB-50.6 owns real-device cutover verification.
<!-- SECTION:FINAL_SUMMARY:END -->
