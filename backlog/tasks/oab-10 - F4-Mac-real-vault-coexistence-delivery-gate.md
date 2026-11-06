---
id: OAB-10
title: F4 Mac real-vault coexistence delivery gate
status: Done
assignee: []
created_date: 2026-10-12 15:13
updated_date: '2026-11-06T16:56:00Z'
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
- [x] #1 F3 is complete, one dated local copy of the real vault outside iCloud exists, and explicit owner authorization to access the personal vault is recorded before access.
- [x] #2 Coexistence is Mac-only, plugin runs only on Mac, and duration does not exceed two weeks.
- [x] #3 AC-19 and polling/storage measurement pass; no attention item is unexplained.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
F4C closure: read the owner HTML measurements, retain supervisor evidence and limits, close the F4 gate, and promote five unchanged F5 drafts under OAB-11. Review the plan before task changes. Run bun run check, semantic branch review, human branch review, and publish one PR. No product code or vault access.
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

Cleanup authorization: after PR #59 merged, the supervisor explicitly authorized Obsidian trash and conditional publication for only oab-8.8/, oab-37/, and oab-10.1/ in dev-2. This replaces the earlier preservation rule for these three prefixes only. The authorization does not include dev-1, the real vault, backups, oab-7.8/, unrelated content, direct service deletes, or Cloudflare changes.

Exact-prefix evidence: oab-8.8/ has 54 confirmed tombstones, including 4 that existed before cleanup. oab-37/ has 1 confirmed tombstone. Confirmed total: 55. The last complete observation of oab-10.1/ has 3 live rows and 0 tombstones. No trash call ran for that folder. The observations occurred at different times. A fresh complete final manifest for all three prefixes remains unavailable, so this is a partial cleanup record only. The real-vault trial must not use this record as proof of fixture-free enrollment.

F4 trial start, 2026-11-05 about 19:30 UTC, by the supervisor under the owner delegation of 2026-11-05. Build: main 91aa62fb1e5e7b82f455c8bfa3422cdf5ac0ccf7, main.js sha256 prefix b579c10e740c6b81. Installed in the real vault at .obsidian/plugins/ai-bridge with data.json {serverUrl, deviceName Mac Vault, coexistenceMode true, syncPaused true} and enabled in community-plugins.json (backup copy kept outside the vault). Deviation: the installed manifest sets isDesktopOnly true so iCloud cannot load the plugin on mobile devices during F4. Device client id: e12MCRtYZ0t4tb0v. Consent ran in the Orca browser with the owner Access session after the authorize URL was captured inside Obsidian. The obsidian:// callback reached Obsidian. No PIN step was needed.

Hydration result: 47 live files equal to the local vault, 0 conflict copies, 0 attention items, 0 local-only uploads. The three remaining oab-10.1/ fixtures hydrated, were trashed in Obsidian, entered the coexistence confirmation queue (3 delete items, nothing published), were confirmed by the supervisor and published as tombstones. Service after start: 47 live, 58 tombstones, head_seq 178, epoch 634b3987. The real vault is settled at cursor 178. Dated local copy before any real-vault step: Vault-2026-11-05T124852Z.zip with sha256 manifest, verified by extraction (85 files).

Observation: during the hydration burst GET /v1/changes returned 429 admission_limited with Retry-After 1 for about one minute (Durable Object per-client live admission limit of 16 while content reads settled). The plugin reported the generic sync failure and recovered on the next cycle. Manifest and file reads kept returning 200. Limits: one device, one Mac, trial window of at most fourteen days from 2026-11-05. OAB-10.1.1 (dev-2 AC-19 service proof) stays open. Dev-2 reported disconnected after the cleanup install and needs a fresh enrollment before OAB-10.1.1.

P1 AC-19 update, 2026-11-05: scoped dev-2 manifest confirms the new fixture remains live at revision 1 with no placeholder service row. Dev-2 remains in Pause, coexistence on, 0 operations, 0 applies, 4 historical attention items, and unchanged attention identities after the authorized preparation. The one service case hit the 60-second CLI timeout, so its durable-confirmation result remains unknown. No repeat ran. OAB-10.1 criterion 6 and OAB-10.1.1 remain incomplete. No personal-vault, other-window, enrollment, journal clearing, or Cloudflare action ran in P1. The F4 gate remains open.

P1 shared-service limit, 2026-11-05: the real vault and dev-2 share one service vault. Normal hydration carried the synthetic P1 fixture into the real vault. The supervisor blocks further dev-2 service creates, changes, and renames during F4. Live cases need a second isolated service vault or the end of the trial. The authorized exact-fixture cleanup published a tombstone at revision 2, verified by scoped manifest at 21:53:04.368Z. Dev-2 remains in Pause with coexistence off, empty queues, no confirmations, and four unchanged attention items. OAB-10.1.1 remains Deferred and AC-19 remains incomplete. No direct personal-vault access ran.

Owner exception 2026-11-06: one bounded dev-2 service case under oab-10.1/ is authorized during F4. The fixture hydrates into the real vault and is removed by a conditional delete after the proof. The supervisor observes the real vault.

P6 bounded service result, 2026-11-06: under the recorded owner exception, client j-jAYgxDZ6cyAPVM completed one dev-2 case from 12:23:48.115Z to 12:26:41.406Z. It proved one durable confirmation, placeholder exclusion, unchanged live authority during simulated eviction, exact-byte restoration, and keepServerState resolution. Conditional cleanup produced a verified fixture tombstone. Final dev-2 state: Pause, coexistence off, 0 operations, 0 applies, 4 unchanged attention items, 0 confirmations. The placeholder has no service row. No second case or direct personal-vault action ran. AC-19 retains the dev-1 capture/reload-only limit and does not prove real iCloud eviction. The F4 gate stays In Progress.

Supervisor observation relay, supplied 2026-11-06: after P6 cleanup, one real-vault replay for client e12MCRtYZ0t4tb0v moved cursor 180 to 182. The supervisor reports the time as about 2026-11-06T07:28Z. Result: 47 files, no oab-10.1/ file present, 0 confirmations, 0 attention items, and 0 pending applies. The fixture create and tombstone applied in one pass. The OAB-10.6 echo fix held: the plugin-applied delete entered no confirmation queue. This is supervisor evidence only. No agent read or inspected the personal vault. The reported time differs from the P6 host UTC times above. Preserve both observations without an inferred clock conversion.

F4C closure record, 2026-11-06. The owner supplied this brief through the supervisor. Plan pn-edcc39 received approval. Owner merge of the closure PR is the F4 closure decision and approval of the five draft promotions. Closure date: the actual owner merge date of this PR, not this preparation date. That future date is not yet known. Trial window: 2026-11-05 about 19:30 UTC through owner merge. The observed trial through this record lasted less than two days, below the two-week maximum. No future duration or merge date is claimed. The fourteen-day limit remains binding through merge.

Supervisor observations, not independently verified by this agent: before enrollment, the supervisor made the dated local copy already named in these notes. The owner declined service-side and GitHub backup on 2026-11-05. Owner authorization was "arranca F4" on 2026-11-05 after PR #55 merged as dbb0481. Real-vault steps went to the supervisor that day. Agents never touched the vault or its copy.

Enrollment: 2026-11-05 about 19:30 UTC, client e12MCRtYZ0t4tb0v, main 91aa62f, isDesktopOnly true, coexistence on, Mac only. iCloud stayed the vault owner. The supervisor reinstalled and reloaded bd3fc7a at 2026-11-05 22:25 UTC, 54ad88e at 23:35 UTC, and e7bb31b at 2026-11-06 03:10 UTC. The real vault still runs e7bb31b. The supervisor checked every 20 to 30 minutes on both days through read-only evaluations, without vault writes during those checks.

Supervisor counts: cursor 179 at 2026-11-05 21:50 UTC, 180 after the OAB-10.6 reinstall, and 182 after the bounded replay. Every check showed 47 files, zero attention items, zero pending confirmations, zero pending operations, zero applies, and zero unavailable paths. Short hydration bursts returned 429 admission_limited and cleared in under one minute. OAB-10.4 fixed the service read-slot leak. Every supervisor check after 2026-11-06 03:10 UTC showed connected status and syncFailure null.

Shared-service finding: the P1 dev-2 fixture reached the real vault at cursor 179 on 2026-11-05 about 21:50 UTC. Test-vault trash published its tombstone and removed the copy. This explains the general shared-service restriction and the one later owner exception. The owner authorized one bounded dev-2 case on 2026-11-06, PR #72, OAB-10.1.1. The supervisor reports one real-vault replay from cursor 180 to 182, with the create and tombstone in one pass. It left zero confirmations and attention items. The plugin-applied delete did not enter confirmation, which confirms the OAB-10.6 echo correction in that observation.

Time limit: the supervisor reports that replay at about 2026-11-06 07:28 UTC. OAB-10.1.1 records the P6 host case at 12:23:48.115Z to 12:26:41.406Z. These times disagree. Retain both sources without an inferred clock conversion or causal timing claim.

AC-19 evidence: OAB-10.1.1 records one completed bounded dev-2 case, client j-jAYgxDZ6cyAPVM. Durable capture proved one confirmation, source unavailability, placeholder exclusion, unchanged service authority, and no fixture delete or rename publication during eviction. Exact-byte restoration and keepServerState preserved authority. Conditional cleanup produced the fixture tombstone. Final dev-2 state was Pause, coexistence off, zero operations, zero applies, four unchanged attention identities, and zero confirmations. Dev-1 proves capture and reload only, not resumed service behavior. Closure accepts this split evidence. No complete two-vault service pass or real iCloud eviction proof follows.

Attention evidence and limits: the supervisor reports no real-vault attention item at any check. OAB-10.1.1 states: "Four attention identities and all unrelated base, queue, apply, and confirmation identities matched the private baseline." It also states: "Limits: attention did not change, but these counts do not prove the exact local disposition of each old fixture." OAB-10.3 states: "OAB-10 retains trial dates, measured results, attention explanations, and limits." That task contains no individual historical attention cause. OAB-10.1 records dev-1 with two historical attention items and unchanged fingerprints during capture and reload. These are preserved test baselines, not new real-vault failures. Individual causes are not present in the cited records. Do not infer causes or claim that the historical test items disappeared. The no-unexplained-item exit applies to the observed real-vault trial, with these historical evidence limits explicit.

Service measurement evidence: browser HTML read at https://obsidian-bridge.mmorillo.dev/owner/measurements?format=html on 2026-11-06. The existing Access session worked. No PIN was needed. The Access cookie was not visible to page JavaScript. No cookie value was read. The reviewed collect:f4 CLI was not used. The HTML page is the evidence. Only the safe summary appears here.

Daily UTC window: 2026-11-06T00:00:00.000Z to 2026-11-07T00:00:00.000Z. Request observations: 2026-11-06T00:00:46.862Z to 2026-11-06T16:45:28.806Z. Coverage: partial. Requests are observed lower bounds, not billing totals. Total 575 requests, all REST, zero MCP. Client e12MCRtYZ0t4tb0v: 553 REST, zero MCP, total 553 requests in that window. Last feed request 16:45:28.546Z, observed intervals 246 to 595185 milliseconds. Client j-jAYgxDZ6cyAPVM: 22 REST, zero MCP, total 22 requests in that window. Last feed request 12:26:17.453Z, observed intervals 816 to 60227 milliseconds. The page did not list dev-1 client 2co2-3SyCC3aatQJ. This is not two-test-vault measurement proof or a full-day rate.

Feed response preparation p95: 180 milliseconds. Samples: 375 retained of 375 total, from 2026-11-06T00:00:47.318Z to 2026-11-06T16:45:28.620Z. No daily-cap sample removal occurred. Boundary: authenticated router entry through successful changes response headers. Excluded: lazy body production, network transfer, plugin apply, and publication delay. Requests and latency were observed and fresh, not stale or unknown. DO SQLite allocated storage: 3014656 bytes. Referenced R2 blobs: 3310536 bytes, distinct referenced blobs only, not full bucket allocation. No growth rate, prior-day total, full-trial coverage, billing total, or end-to-end latency is proven.

Remaining limits: OAB-10.2 criteria 1, 3, and 4 remain unchecked. Plugin display, live event-origin classification, and two-test-vault measurement proof do not follow from this read. OAB-8.7.1 now says Done with controller-test evidence and an unverified real-host timing limit. Preserve its F4 trigger and that history. Do not restore its obsolete Deferred state. No personal-vault inspection, backup inspection, cloud resource change, deployment, release tag, or mobile action ran in F4C. Section 14 matches the recorded bounded result, so docs/spec.md stays unchanged.

F4C validation and review: bun run check passed with exit 0 on the Backlog-only branch based on e56944e. The check covered lint, docs, workspace types, tests, and dry-run builds. Separate assertions passed all five draft text comparisons and the Backlog-only scope check, six checks total. No failing product test applies to these task-record changes. Session-model independent branch review used code-review guidance. The first review covered OAB-11 but stopped before complete coverage. The continuation covered OAB-10, OAB-10.1, OAB-10.2, and all five promoted tasks, and returned PASS with no actionable finding. Documentation scope: changed task metadata, criteria, notes, summaries, and exact draft text. Structural implementation candidates and TypeScript declaration checks do not apply because no executable file changed. Review checked source attribution, dates, privacy, task order, triggers, and accepted evidence limits. No new absolute personal path, token, cookie value, owner subject, or raw response appears in the changes. Human branch review remains pending.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed the F4 gate with owner-approved evidence limits, effective on owner merge of this PR. Supervisor evidence records the dated local copy, authorization, Mac-only coexistence, and zero real-vault attention items. The observed trial remains below two weeks. Split AC-19 evidence combines dev-1 capture and reload, one completed dev-2 bounded case, and supervisor real-vault replay. HTML measurements record partial daily request counts, 180-millisecond feed preparation p95, and allocated SQLite plus referenced R2 bytes. No full two-vault pass, real iCloud eviction proof, full-trial measurement, or individual historical test attention cause is claimed. Promoted five unchanged F5 drafts under OAB-11 in To Do. F5 still needs release, copy devices, isolated authority, and explicit owner authorization.
<!-- SECTION:FINAL_SUMMARY:END -->
