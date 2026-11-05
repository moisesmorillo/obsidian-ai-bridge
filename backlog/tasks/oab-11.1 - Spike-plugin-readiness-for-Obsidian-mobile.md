---
id: OAB-11.1
title: 'Spike: plugin readiness for Obsidian mobile'
status: Done
assignee:
  - '@pi'
created_date: '2026-11-05T23:18:00Z'
updated_date: '2026-11-05T23:26:00Z'
labels: []
dependencies: []
documentation:
  - docs/spec.md
parent_task_id: OAB-11
type: spike
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The F5B owner brief requests research during F4 without product changes. Mobile APIs and three-device evidence need a bounded plan before F5 starts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Task notes identify mobile API risks with exact source references and evidence limits.
- [x] #2 Task notes rank proposed changes with size estimates and deferred draft triggers.
- [x] #3 Findings open in Plannotator for owner review without product changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Inspect plugin runtime and acceptance tools. 2. Check current primary Obsidian sources. 3. Record findings and Deferred drafts. 4. Get owner approval. 5. Complete delivery checks, close the spike, commit the six records, merge origin/main, push, open one PR, remove the worktree, and stop.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The F5B owner brief authorizes research during F4 only. OAB-11 stays To Do. No vault or service action is authorized.
The supervisor later authorized task closure, one backlog commit, a merge from origin/main, a push, one PR, and worktree removal.

## Mobile readiness findings and proposed plan

### Scope and verdict

Baseline: main 091b2b1d82723c03fe78fbfffaf6df5f797ff18d. Research date: 2026-11-05 UTC.
This is a research spike, not F5 execution or mobile qualification.
The F5B brief authorizes research during F4. OAB-11 remains To Do.
The author also did this design review. This is not an independent review.

Verdict: not ready for mobile qualification.
Static source supports a shared runtime, but native enrollment, persistence, suspension, and iCloud behavior lack device evidence.
No mobile device, vault, service endpoint, or Cloudflare resource was accessed.
No product code, dependency, manifest, release, or deployment file changed.
The research stage ran no tests or builds. Delivery checks appear in the final summary.
No native runtime or device result is claimed.
Existing test names below show coverage intent, not test results from this session.

Checklist:
- [x] Inspect runtime and acceptance tooling.
- [x] Check public primary API and mobile documentation.
- [x] Record source references, risks, estimates, and deferred drafts.
- [x] Owner approved all six files in Plannotator, session pn-c61676.
- [x] Supervisor replaced the stop instruction with backlog-only delivery authority.
- [x] Complete delivery checks and close this spike.
- [ ] Publish the approved records and remove the worktree.

### Owner decisions

This review approves research findings and the proposed order only. It does not start F5 or any draft.
Recommended sequence: isolated copy-vault qualification first, then a separate proposal for any real-vault work.
Keep Mac, iPhone, and iPad as the F5 exit devices. Treat Android as a compatibility probe, not a fourth gate device.
Keep PKCE proof in memory. After process loss, ask for a fresh connection rather than persisting the verifier in vault settings.
Keep existing exact-revision writes, immutable sent operations, visible conflict copies, and no-delete-from-absence rules.

The current F4 service vault also feeds the live trial. A new local copy or fixture prefix does not isolate service effects.
No test device can publish fixtures against that authority during F4.
Future execution needs F4 closure and explicit approval of the copy-vault and isolated-service scope.
An isolated service may need infrastructure work. This spike authorizes none.
The mobile real-vault coexistence policy remains unresolved. Spec §7.10 describes Mac-only coexistence.
Resolve that policy before a mobile real-vault plan. Do not infer approval from a successful copy test.

### A. Desktop-only API inventory

1. No Node, Electron, Bun runtime imports, FileSystemAdapter casts, or getBasePath calls appear in apps/plugin/src.
   Static import and host-call searches covered that directory.
   apps/plugin/build.ts:13 selects browser/CommonJS packaging with only obsidian external.
   apps/plugin/tsconfig.json:4 uses ES2022 and DOM with no ambient Node types.
   apps/plugin/test/artifact.test.ts:12 checks the manifest and external runtime imports.
   This is static evidence, not a fresh artifact build or native device proof.

2. apps/plugin/src/main.ts:492 uses window.open after asynchronous discovery, registration, and PKCE hashing.
   This is a browser API, not a desktop-only import. Native mobile browser launch remains unverified.
   A user gesture may no longer be active by this point.
   The method returns no launch status to DeviceSession.
   Do not use a null window handle alone as failure evidence. noopener can also return null.

3. apps/plugin/src/infrastructure/oauth-transport.ts:40 and :60 use requestUrl with throw:false.
   The adapter normalizes header names and returns text plus arrayBuffer at :66-73.
   The API describes HTTP requests without CORS restrictions. It does not document complete desktop/mobile transport equivalence.
   Native redirect, cookie isolation, TLS failure, timeout, header, and binary behavior remain unverified.
   Browser Access authentication does not imply requestUrl shares browser cookies.
   Protected sync requests use bearer credentials through auth/device-session.ts:277-332.
   Device tests must cover form token exchange, exact UTF-8, binary bytes, conditional request headers, ETag, Retry-After, 401, 412, and 429.
   Do not replace requestUrl with fetch or add Node networking as a speculative fix.

4. apps/plugin/src/infrastructure/text-vault.ts:15-114 uses Vault APIs and generic DataAdapter methods.
   Hidden recovery bytes use stat, list, readBinary, writeBinary, mkdir, and remove.
   infrastructure/device-storage.ts:24-62 uses the same generic adapter for .ai-bridge/pending payloads.
   The primary API marks FileSystemAdapter as desktop-specific, but the plugin does not depend on that class.
   Mobile hidden-directory persistence, trash behavior, read failures, and byte verification need device evidence.
   No Node filesystem rewrite is justified by the current source.

5. main.ts:575-597 wires DOM timers, focus, blur, and visibilitychange.
   sync/desktop-sync.ts:29 defines an optional isSuspended capability. main.ts does not supply it.
   desktop-sync.ts:264 checks suspension only while scheduling polling.
   syncNow and event debounce do not use a suspension guard.
   OS timer suspension is not a proof of the §7.4 no-work-while-suspended contract.
   Test in-flight suspension, resume, timer ownership, network return, and restart recovery.
   A foreground retry must use the existing serialized controller, not a second loop.

6. status-panel.ts uses DOM controls. settings.ts:124 shows the fallback credential warning.
   These modules have no desktop runtime import. Touch layout, focus, and safe-action behavior still need mobile inspection.
   P5 owns current status work. This spike makes no UI edit.

7. apps/plugin/tools/desktop-acceptance.ts:1-7 uses Node child processes, filesystem, crypto, and paths.
   DesktopVaultId at :26 allows only dev-1 and dev-2.
   authorizedVaults at :403 fixes two Mac paths.
   invokeScopedObsidian at :2410 executes desktop CLI commands.
   dispatchCapturedCallback at :794 uses getBasePath and directly calls the private session callback.
   The installer at :2499 uses desktop eval and private plugin fields.
   These are desktop-only tools, outside the production bundle.
   They cannot prove native mobile URI delivery or admit a third device without new guarded tooling.
   Do not remove their exact-vault guards to make mobile tests pass.

### B. PKCE browser and callback path

Current path:
Settings Connect -> discovery -> public-client registration -> WebCrypto S256 -> external browser -> Access consent -> obsidian URI -> plugin handler -> token exchange -> verified credential write -> journal client identity.

Exact owners:
- auth/device-session.ts:24 sets a ten-minute pending-consent lifetime.
- :105-162 registers the client, creates random verifier/state, and builds authorization parameters.
- :195-275 validates pending generation, expiry, state, optional issuer, and code/error exclusivity.
- :219-262 exchanges the code and serializes verified credential and journal writes.
- :336-340 drops pending consent and credential memory on close.
- main.ts:147 registers ai-bridge/callback after credential restore.
- packages/protocol/src/schemas/device-auth.ts:6 owns obsidian://ai-bridge/callback.

A suspended process can retain pending proof. A killed or reloaded process cannot.
After process loss, the current callback rejects safely because no active consent exists.
A callback can also arrive before handler registration or in another active vault.
The current URI has no vault selector. Public API documentation does not establish routing for this custom slash action across mobile vaults.
Do not change the canonical URI or relax state checks without failing native evidence.

Missing cases: normal Safari/Android browser return, denied consent, expired proof, duplicate return, wrong vault, cold launch, plugin reload, and interrupted token storage.
The desktop driver bypasses native dispatch. Its result cannot close these cases.

Credential availability:
- Primary App declarations expose secretStorage since 1.11.4 and do not mark it desktop-only.
- No retrieved primary source proves iOS, iPadOS, or Android encryption and restart behavior individually.
- credential-storage.ts:49-60 selects secret storage when present, otherwise vault-local localStorage.
- :119-145 verifies writes and clears. Tests cover separate keys, absent capability, and no fallback after secret-store errors.
- API presence is not proof of encryption, durability, or OS keychain storage.
- The desktop 1.11.5 encryption announcement applies to desktop. Do not extend it to Android or iOS.
- Record capability, get/set verification, restart, refresh, clear, device isolation, and visible fallback warning per platform.
- Use disposable test secrets. Record results only, never secret values.
- If the capability changes after upgrade, credentials in the old store can become unavailable. Keep migration behavior explicit.
- main.ts:40 defaults to Obsidian desktop. :213 persists deviceName in data.json.
  iCloud can copy this label to another device. Journal IDs remain local, but device labels and conflict names can be misleading.

### C. iCloud placeholders and coexistence

Spec §7.8 excludes *.icloud and hidden service directories.
enrollment-scope.ts:42 excludes placeholder names.
text-vault.ts:108-117 detects path.icloud and .name.icloud with metadata only.
coexistence.ts:28-65 captures destructive events and tracks unavailable paths.
:71-118 refuses confirmation when the source is unavailable or exists again.
publication.ts:148 and :241 skip known unavailable paths.
Current tests simulate these names. They do not establish iOS File Provider metadata or event ordering.

The primary Obsidian sync guide warns that iCloud offload makes files inaccessible.
It also warns against two simultaneous sync services.
An iOS provider can expose absence or a failed read without either filename form.
That is a counterexample to complete placeholder detection, not proof that an unsafe delete currently occurs.
No public source retrieved here specifies every native eviction event or a portable hydration API.
Keep this unknown explicit. Never infer a user delete from absence.

Future copy tests must observe eviction, materialization, rename, missing metadata, read rejection, and reload.
Keep Downloaded is a mitigation, not an acceptance proof.
Test conflict convergence outside iCloud first, so iCloud cannot mask a failed service transfer.
Test iCloud coexistence separately in an approved synthetic copy and isolated authority.
Binary apply retains the approved best-effort race window from §7.5. This spike does not change that contract.
P4 owns coexistence corrections. Recheck its merged source before future implementation.

### D. Three-device tooling and acceptance plan

Use three independently enrolled copies: A=Mac, B=iPhone, C=iPad.
Verify distinct device_id/client_id values and stable local journals after restart.
Pin one released plugin artifact and record app, OS, plugin version, and artifact identity.
BRAT needs the F5A release artifacts. Do not change release files in this scope.
Desktop mobile emulation checks layout only. It does not emulate native storage, networking, suspension, or URI dispatch.
Primary mobile docs describe Safari inspection on iOS 16.4+ and Chromium inspection on Android.
Inspector availability and unattended device control were not probed here. They remain tooling prerequisites.

Use real network isolation for the offline editor. Pause alone is not offline evidence.
Save the note before reconnect. Control the first publisher, then reconnect the offline editor.
Keep C offline until the conflict resolves, then verify third-device catch-up.
Repeat with iPhone and iPad as the offline editor and with both publisher orders.

| Case | Required observation on A, B, and C |
| --- | --- |
| AC-03 | First publisher bytes at the original path. Other bytes in one conflict copy. Both files converge everywhere. |
| AC-04 | Original tombstone stands. Offline editor bytes converge as a conflict copy. Original enters Obsidian trash. |
| AC-05 | Y contains rename-origin bytes. Offline X edit converges as a Y conflict copy. X stays absent. |
| AC-05 links | Origin uses the normal Obsidian rename UI with link updates. Peers receive ordinary puts without a second rewrite. |
| iPhone restart | Offline saved edit survives app stop and restart, then resolves after network return. |

Assert exact observed revisions, hashes, conflict count, bases, empty queues, empty pending applies, and cursor/head convergence.
Observe service authority through canonical transport. Missing manifest rows never prove deletion.
Use bounded phase deadlines and classify uncertain effects separately from failures.
Before a retry, inspect receipts and durable state. Do not invent a new idempotency key for an uncertain sent operation.
Cleanup uses only approved fixture paths and exact-revision conditional operations. Preserve unexplained conflicts.
Collect allowlisted client IDs, times, counts, revisions, and results only.
No tokens, cookies, raw callback URLs, owner subjects, or vault content enter tracked records.

### E. Aggregate budgets and unknown limits

These are source-derived bounds, not device measurements.

| Operation | Aggregate estimate | Limit and consequence |
| --- | --- | --- |
| Cold enrollment, each device | 1 discovery + 1 registration + browser consent/Access + 1 token exchange | Browser/Access call count and latency are not bounded here. Pending proof expires after 600 seconds. |
| Three device enrollments | At least 9 plugin OAuth requests, plus browser traffic and initial sync | No claim about account admission or native browser timing. |
| Warm idle sync cycle | At least 1 changes request + 1 final vault-summary request | main.ts:547 adds a summary read. Startup adds another. Recovery, refresh, and content add calls. |
| Three focused-active devices | 3 × (8 × 3600 / 15) × 30 = 172,800 cycles/month | At least 345,600 plugin requests at two per cycle, before changes or retries. |
| Mobile suspension | Target 0 scheduled polls, then one serialized recovery on resume | Host wiring does not prove this target. No background execution guarantee is assumed. |
| Largest blob | B = 25,000,000 bytes from canonical blob schema | requestUrl buffers the body. No streaming cap prevents native allocation before validation. |
| Blob apply memory | At least native response B + transport copy B + current local bytes B = 75,000,000 bytes on a replacement path | More copies, text conversion, hashing, and JS overhead can increase peak use. No verified iOS/Android memory ceiling or headroom exists. |
| Journal persistence | Full state serialization, parsing, and read verification per commit | device-journal.ts:1199-1218. Native localStorage quota and write latency remain unmeasured. |
| Pending/recovery storage | Sum of retained pending payload bytes plus retained pre-apply copies | .ai-bridge files remain outside service scope. Disk capacity and native eviction behavior remain unmeasured. |

The monthly figure is a lower bound for plugin HTTP traffic, not a corrected Cloudflare billing result.
Worker routing can add internal calls. No current account-tier headroom was measured.
Spec §7.4 counts one changes request per poll. The source adds summary traffic.
Future F5 measurement must include the whole cycle and retry traffic.
Do not claim the 25 MB contract is safe on mobile without peak-memory and interruption evidence.
Unknown native limits keep the readiness verdict at not ready.

### F. Ranked proposed changes and size

Estimates include failing tests, implementation, and checks. They exclude owner login and device access delays.
S means about one engineer-day. M means two to three. L means four to five.
All code changes are proposals. A device probe can show that no product fix is needed.

| Rank | Proposed change | Size | Draft |
| --- | --- | --- | --- |
| 1 | Add exact-target mobile control and safe three-device observations. Keep desktop guards intact. | L, with device-access uncertainty | DRAFT-4 |
| 2 | Verify native browser return and credential persistence. Correct only evidenced launch or callback failures. | M | DRAFT-1 |
| 3 | Make device labels local if copy tests confirm shared data.json propagation. Preserve stable journal identities. | S | DRAFT-1 |
| 4 | Supply mobile lifecycle admission and recovery where native probes expose a gap. Verify requestUrl and storage limits. | M to L | DRAFT-2 |
| 5 | Extend unavailable-path handling only for observed iOS provider cases. Preserve confirmation and revision fences. | M to L, native API uncertainty | DRAFT-3 |
| 6 | Run and correct AC-03/04/05 across three independent copies. Add regression tests for each exposed defect. | L, plus device time | DRAFT-5 |

The estimates overlap. They are not a summed delivery commitment.
No general platform layer, second plugin, Node adapter, new dependency, or protocol redesign is proposed.

### G. Deferred Backlog records

Created DRAFT-1 through DRAFT-5 with parent OAB-11, explicit triggers, and F5/Deferred labels.
Backlog stores drafts with status Draft even when creation receives status Deferred.
Deferred intent is explicit in every title, label, and trigger. None is an active task.
No draft was promoted or started.

Proposed order: DRAFT-4 tooling first, then DRAFT-1 enrollment.
DRAFT-2 lifecycle/transport and DRAFT-3 placeholder work follow their copy-scope triggers.
DRAFT-5 waits for release artifacts, the compatibility results, guarded tooling, and approved isolated copies.
Android evidence belongs to DRAFT-1/2 and does not replace iPhone or iPad acceptance.

### H. Primary sources and evidence limits

Retrieved on 2026-11-05 UTC:
- Mobile development: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Getting%20started/Mobile%20development.md
- Current API declarations: https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts
  Relevant declarations: App.secretStorage, SecretStorage, requestUrl, RequestUrlParam, DataAdapter, FileSystemAdapter, and Plugin.registerObsidianProtocolHandler.
- Store secrets guide: https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Guides/Store%20secrets.md
  The guide describes vault-keyed local storage. It does not establish per-platform encryption.
- URI guide: https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Extending%20Obsidian/Obsidian%20URI.md
- iCloud/offline guidance: https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Getting%20started/Sync%20your%20notes%20across%20devices.md
- Desktop encryption announcement: https://obsidian.md/changelog/2026-01-20-desktop-v1.11.5/
- Mobile 1.11.4 release notes: https://obsidian.md/changelog/2026-01-07-mobile-v1.11.4/
  These notes do not establish the mobile SecretStorage encryption contract.
- BRAT maintainer README: https://raw.githubusercontent.com/TfTHacker/obsidian42-brat/master/README.md

The published help HTML did not extract. The official repository Markdown supplied the help evidence.
The Apple Files guide returned HTTP 429. No Apple-specific filename or eviction guarantee is inferred from it.
Third-party search summaries were discovery aids, not proof of API behavior.
No device capability, native memory limit, mobile secret-store encryption, iCloud event sequence, or unattended device-control result was verified.

### I. Findings disposition

- MAJOR: native enrollment and per-platform credential evidence missing. Intentionally deferred to DRAFT-1 under the research-only scope.
- MAJOR: suspension and transport/storage limits unverified. Intentionally deferred to DRAFT-2.
- MAJOR: iOS placeholder event contract unverified. Intentionally deferred to DRAFT-3.
- MAJOR: two-device desktop tooling cannot prove F5. Intentionally deferred to DRAFT-4 and DRAFT-5.
- MINOR: shared device label and desktop default need correction or explicit isolation evidence. Intentionally deferred to DRAFT-1.
- MINOR: poll estimate omits summary traffic. Intentionally deferred to DRAFT-2 measurement.

Deferral does not mean mobile readiness or F5 acceptance.
Structural candidates were main.ts lifecycle wiring, DeviceSession consent state, credential storage, coexistence observation, and the desktop acceptance driver.
They retain existing authority boundaries. No structural rewrite is justified by this spike.
This review covers mobile feasibility, not a complete TypeScript semantic audit or an independent whole-branch code review.

### J. Delivery verification

The supervisor replaced the original stop instruction with backlog-only publication authority.
Owner approval: Plannotator pn-c61676 covered the task and all five drafts.
Independent final records review: dd4f39c4c0e486e30725c17ed135af8b5 returned PASS with no actionable findings.
The review checked all six records and selected source contracts. It did not claim native device proof.
Delivery check bfe9191e3 passed: bun install --frozen-lockfile and bun run check, exit 0.
The Worker build used dry-run only. No deployment ran.
No failing test was added because this branch changes backlog records only.
The original source baseline and native evidence limits remain unchanged.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Recorded mobile API risks, PKCE and credential limits, iCloud placeholder gaps, three-device acceptance needs, and ranked size estimates. Created five deferred drafts under OAB-11 with explicit triggers. The owner approved all six records in Plannotator pn-c61676. Independent records review passed without findings. Frozen install and bun run check passed, exit 0. No product code, native device, vault, service, or Cloudflare change ran. Mobile readiness remains unproven. F5 and all five drafts remain unstarted.
<!-- SECTION:FINAL_SUMMARY:END -->
