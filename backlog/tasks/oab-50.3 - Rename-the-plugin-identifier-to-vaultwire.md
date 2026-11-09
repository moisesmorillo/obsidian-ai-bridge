---
id: OAB-50.3
title: Rename the plugin identifier to vaultwire
status: In Progress
assignee: []
created_date: '2026-11-09T15:37:00Z'
updated_date: '2026-11-09T15:58:00Z'
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
- [ ] #1 A build produces a plugin with id `vaultwire` that installs next to an old ai-bridge folder without reading or deleting it by accident.
- [ ] #2 A documented and tested procedure moves a device from ai-bridge to vaultwire without loss of vault content or unsynced local edits.
- [ ] #3 bun run check passes.
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
Implemented Vaultwire manifest metadata, release tag validation, compatibility checks, and plugin ID use in install/dev-vault tooling. Added an offline migration command that backs up and copies data.json without changing the old folder. Preserved the existing device journal, credential, and settings-consent local-storage keys. Added migration instructions that explain the localStorage boundary. RED tests reproduced the old release prefix, new plugin settings path, compatibility identifier guard, and migration behavior before implementation. Kept the existing Obsidian callback URI unchanged because its registration belongs to the existing authentication contract and Worker changes are outside this task. Full checks passed: 31 plugin test files, 850 passed and 1 skipped; root check passed.
<!-- SECTION:NOTES:END -->
