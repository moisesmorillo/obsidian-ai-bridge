---
id: OAB-10
title: F4 Mac real-vault coexistence delivery gate
status: In Progress
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-05T18:38:00Z'
labels:
  - phase-gate
  - F4
dependencies:
  - OAB-8
documentation:
  - docs/spec.md
type: task
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Track F4 against docs/spec.md §14. Intent-only; research/decompose when selected; no implementation plan authorized now. Requires F3, one dated local copy of the real vault outside iCloud (spec §11.5), plus separate explicit owner authorization before personal-vault use. Coexistence on Mac only, plugin only on Mac, at most two weeks; exit AC-19, polling/storage measured, no unexplained attention item.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 F3 is complete, one dated local copy of the real vault outside iCloud exists, and explicit owner authorization to access the personal vault is recorded before access.
- [ ] #2 Coexistence is Mac-only, plugin runs only on Mac, and duration does not exceed two weeks.
- [ ] #3 AC-19 and polling/storage measurement pass; no attention item is unexplained.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Complete OAB-10.1, then OAB-10.2, then OAB-10.3 through separate reviewed branches. The parent gate retains the real-vault trial, two-week maximum, measurement review, attention explanations, and evidence limits. The supervisor performs authorized real-vault steps. Agents never access the real vault.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Reconciled after merged F0: this is a committed section14 phase entry/exit gate, not a trigger-based deferred feature or an implementation task. Its original acceptance cases and dependency edges are unchanged. Dependency readiness only permits selection for research and decomposition; it does not authorize implementation, deployment or personal-vault access.

Owner decision 2026-11-05: F4 no longer requires F3b or a service-side backup. A dated local copy of the real vault outside iCloud replaces the restore demonstration (spec §11.5).

Standing authorizations for F4

The owner authorized F4 on 2026-11-05 with "arranca F4", after PR #55 merged as main dbb0481.

The personal vault is owner-manual only. No agent, script, test, or tool can read, write, list, open, or copy it. Before any real-vault step, the supervisor must relay owner confirmation of one dated local copy outside iCloud. No confirmation exists in this session.

Automated vault actions use only ~/vaults/obsidian-ai-bridge-dev and ~/vaults/obsidian-ai-bridge-dev-2, with https://obsidian-bridge.mmorillo.dev. Preserve all oab-7.8/, oab-8.8/, and oab-37/ service evidence. Live device names use oab-10.<n> dev-1 and oab-10.<n> dev-2. Record only client ids, times, and results. Never print tokens, cookies, or the owner subject. Never store them in tracked files.

A merge that touches apps/worker, packages, bun.lock, package.json, mise.toml, or deploy.yml deploys the Worker. Never run wrangler deploy. Cloudflare resources belong to OpenTofu in cloudflare-infra. No Cloudflare resource changes are authorized.

The owner completes Access PIN login, every ChatGPT account action, and every real-vault action. Automate other approved steps. Send routine questions to the supervisor in this terminal.

The obsolete OAB-9 dependency was removed. The owner decision and spec §11.5 replace F3b with a dated local copy. F3 evidence retains its recorded limits and Deferred tasks.

Standing authorizations for F4 — supervisor update, 2026-11-05

The owner said "hazlo tu, no me pidas tantos pasos manuales". The supervisor now acts for the owner on real-vault manual steps. The supervisor reports a dated local copy at ~/vaults/backups/Vault-2026-11-05T124852Z.zip, with a sha256 manifest beside it and verification by extraction. This relay satisfies the dated-copy confirmation condition. No agent verified or accessed the copy or the personal vault.

When OAB-10.3 is ready, the supervisor will install and enable the built plugin in the real vault. This replaces the earlier owner-only actor for these manual steps. Agents and subagents still never read, write, list, open, copy, or inspect the real vault. All other F4 limits remain unchanged.

Bounded dev-2 fixture cleanup, 2026-11-05 UTC. Source main: 91aa62fb1e5e7b82f455c8bfa3422cdf5ac0ccf7. Built and installed plugin 0.1.0 only in dev-2. Client id: j-jAYgxDZ6cyAPVM. Time window: 2026-11-05T18:15:51Z to 2026-11-05T18:34:07Z. Baseline scoped manifest: 58 rows total. OAB-8.8 had 50 live and 4 tombstones. OAB-37 had 1 live and 0 tombstones. OAB-10.1 had 3 live and 0 tombstones. Two folders were moved to Obsidian trash through the Vault API. Fresh scoped observations confirmed 55 tombstones across OAB-8.8 and OAB-37. The last known OAB-10.1 observation showed 3 live rows. No service row was absent as deletion evidence.
Final device state: connected, paused, coexistence off, 0 pending operations, 0 pending applies, 0 confirmations, and 4 unchanged historical attention items. A private fingerprint matched the baseline. No 412 or new attention item was observed.
The final scoped manifest read stopped. Two earlier HTTP 200 response texts of 493 and 101 characters failed JSON parsing inside the guarded host. Later sequential diagnostics found an HTTP 200 JSON/object response of 966 bytes that failed JSON parsing, then an HTTP 429 JSON response of 88 bytes that parsed. Content-Length was absent on the HTTP 200 responses, so completeness is unknown. The supported session request failed with its safe generic error. The canonical SyncTransport manifest read failed with SyncTransportError. The failure occurred before helper projection or stdout capture. No raw body was retained. The underlying response cause remains unknown. No full-prefix final proof exists, and no complete cleanup is claimed. OAB-10.1 was not trashed.

Installer state check: after the guarded install, dev-2 was connected and unpaused while coexistence remained on. We paused it before disabling coexistence. The queue, apply, confirmation, and attention counts did not change. We then disabled coexistence and resumed for the authorized cleanup.

Read-only diagnosis stopped at 2026-11-05T18:36:00Z. Dev-2 stayed paused with coexistence off.

The initial vault-operation window ended at 2026-11-05T18:34:07Z. The full read-only diagnosis ended at 2026-11-05T18:36:00Z.

Installer restart limit: while dev-2 was briefly unpaused with coexistence on, its normal cycle could run before the manual pause. The guarded check then showed 0 queues, 0 confirmations, and 4 unchanged attention items. I did not inspect unrelated local content, so any unrelated local changes in that interval remain unverified.
<!-- SECTION:NOTES:END -->
