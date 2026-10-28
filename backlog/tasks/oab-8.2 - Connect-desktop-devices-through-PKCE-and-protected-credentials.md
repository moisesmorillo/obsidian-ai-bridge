---
id: OAB-8.2
title: Connect desktop devices through PKCE and protected credentials
status: In Progress
assignee:
  - '@pi'
created_date: '2026-10-28T19:31:00Z'
updated_date: '2026-10-28T22:22:00Z'
labels: []
dependencies:
  - OAB-8.1
documentation:
  - docs/spec.md
parent_task_id: OAB-8
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Give each test vault its own enrolled device identity without placing credentials in synced settings. One focused PR. Use requestUrl and the existing deployed OAuth service. Owner-interactive acceptance remains in OAB-8.8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Connect uses browser PKCE, validates callback state, exchanges the code, and handles cancelled or failed consent safely.
- [ ] #2 Tokens use secretStorage when available. The localStorage fallback has a visible unencrypted-storage warning. No token, code, or verifier reaches logs or data.json.
- [ ] #3 Refresh rotation and failed refresh stop unauthorized work. Reconnect does not discard journal entries or local files. Automated lifecycle and transport tests pass.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Desktop PKCE Enrollment Implementation Plan

> Agent workers: use the subagent-driven-development skill. One worker owns OAB-8.2, its tests, checks, and commit.

**Goal:** Connect each desktop vault through PKCE without credentials in synced settings or lost journal operations.

**Architecture:** A host-independent session controller owns consent, credentials, refresh, and authorization state. Small Obsidian adapters provide credential storage, requestUrl, browser launch, and settings controls. The journal serializes client identity changes with existing operation transitions.

**Tech Stack:** TypeScript, canonical Zod schemas, Obsidian APIs, Web Crypto, Vitest, and the existing OAuth provider. No new dependencies.

**Spec:** `docs/spec.md`, sections 7.1, 7.2, 9.1–9.5. Backlog task OAB-8.2 defines this delivery. Reconciliation and synchronization remain in later tasks.

## Constraints and decisions

- Use `obsidian://ai-bridge/callback`, S256, and scopes `vault:read vault:write vault:delete`.
- Use `requestUrl` for discovery, registration, exchange, refresh, and authenticated requests. Do not use Node or Electron APIs.
- Never log tokens, codes, verifiers, callback URLs, response bodies, or host errors that can contain them.
- Keep pending state and the verifier in memory. Expire pending consent after ten minutes. Reject stale and replayed callbacks.
- Use one pending consent per controller. Cancel clears it. Unload fences every asynchronous completion.
- Keep the old authenticated session during cancelled or failed reconnect. Successful reconnect replaces credentials without clearing journal entries.
- A failed refresh blocks authenticated work and offers Reconnect. Never continue with the expired or rejected token.
- Serialize refresh. Store and verify rotated credentials before another authenticated request uses them.
- Store credentials as one validated record in secretStorage. Scope its key by the device UUID.
- Use app localStorage only when secretStorage is absent. Show `tokens stored unencrypted on this device` in settings.
- A secretStorage error does not trigger fallback. Credential persistence failure blocks authorization.
- Read and validate stored credentials before use. Do not place credentials in journal state or data.json.
- Keep server URL as the only new non-secret setting. Default to `https://obsidian-bridge.mmorillo.dev`.
- Accept HTTPS service origins only. Validate discovery endpoints against the configured origin before sending secrets.
- Do not add sync scheduling, vault mutation, reconciliation, or the full status panel.
- The owner approved Worker callback support through the normal main-merge deployment pipeline. Do not deploy directly.
- Keep existing HTTPS and loopback callbacks. Allow only the exact Obsidian callback among private-use callbacks.
- OAB-8.5 now records the rejected-operation obligation. Do not change rejection resolution here.

## Approaches

The specification fixes browser PKCE and protected device storage. Use a session controller with small host adapters so tests need no browser.
A controller inside the settings UI couples token rotation to UI lifetime. Do not use that approach.
A localhost callback changes the specified contract and needs a server. Do not use that approach.

## Planning probes and limits

- Main starts at `9ec8971`. Baseline `bun run check` exits zero in the isolated Orca worktree.
- Live discovery advertises S256, registration, refresh, public clients, and the three vault scopes.
- Live registration rejects the exact Obsidian callback with `invalid_client_metadata`.
- The installed provider supports `allowPrivateUseRedirectUris`. Worker options do not enable it.
- Obsidian types expose synchronous `getSecret` and `setSecret`, localStorage, and protocol-handler registration.
- Obsidian types document protocol actions but do not prove runtime routing of a callback with a path.
- Test the host adapter dispatch. Real Obsidian callback dispatch remains part of OAB-8.8.
- No real consent starts in automated tests. Do not use a localhost flow as proof of the specified callback.
- The deployed callback cannot work before merge deploys the Worker policy. Report this limit, not a live success claim.

## Review focus

1. A callback from another vault, previous consent, or wrong issuer must not exchange a code.
2. Concurrent authenticated calls must not rotate the same refresh token twice.
3. Unload, cancel, or reconnect during exchange must not install stale credentials or identity.
4. Dropped credential writes and malformed storage must block requests without erasing journal entries.
5. Discovery must not direct credentials to another origin. API request paths must not leak bearer tokens across origins.

## Files and responsibility

- `packages/protocol/src/schemas/device-auth.ts`: canonical discovery, registration, token, and credential schemas with inferred types.
- `packages/protocol/src/index.ts`: public exports.
- `packages/protocol/src/schemas/device-state.ts`: optional enrolled `client_id` with backward-compatible journal reads.
- `apps/plugin/src/auth/device-session.ts`: consent and authorization controller with explicit small host ports.
- `apps/plugin/src/infrastructure/credential-storage.ts`: device-keyed secretStorage and warned localStorage adapter.
- `apps/plugin/src/infrastructure/oauth-transport.ts`: requestUrl adapter and validated OAuth endpoint use.
- `apps/plugin/src/settings.ts`: labelled Connect, Cancel, Reconnect, server URL, and safe status text.
- `apps/plugin/src/main.ts`: lifecycle composition and protocol callback wiring.
- `apps/plugin/src/sync/device-journal.ts`: serialized enrolled-client update that preserves all other state.
- `apps/plugin/test/`: session, storage, transport, settings, and lifecycle tests with synthetic credentials.
- `packages/protocol/test/`: schema and backward-compatibility tests in the existing test layout.
- `apps/worker/src/infrastructure/auth/oauth.ts`: exact private callback policy.
- `apps/worker/test/f2/oauth.test.ts`: real Worker registration, consent, callback, and exchange tests with local fixtures.
- `docs/spec.md`: no contract changes. Code comments and exported API TSDoc describe the new behavior.

## Task: OAB-8.2 complete delivery

### Interfaces

The worker selects exact internal signatures and records them in useful TSDoc. These contracts fix observable behavior:

- `DeviceSession.connect()` discovers and registers a public client, then opens a PKCE consent URL.
- `DeviceSession.cancel()` invalidates pending consent without changing journal entries or vault files.
- `DeviceSession.callback(params)` validates state, expiry, optional issuer, and code/error exclusivity before exchange.
- `DeviceSession.request(path, options)` admits same-origin API requests only after validated credentials and refresh.
- `DeviceSession.close()` fences later effects and clears in-memory consent secrets.
- `DeviceJournal.setClientId(clientId)` serializes a verified whole-document update without replacing pending operations.
- The credential adapter exposes read, verified write, and a storage warning. It never uses saveData.
- The session publishes safe status and a single UI notification mechanism. UI code does not own credentials.

### Test and implementation checklist

- [ ] Read current function bodies and load TDD before edits. Load code-review and its TypeScript profile before semantic review.
- [ ] Add a Worker regression test for registration with the exact callback. Show RED before the policy change.
- [ ] Enable private-use redirects and constrain private callback metadata to the exact Obsidian URL.
- [ ] Test valid Obsidian registration and code exchange with S256. Keep remote HTTP and unrelated private callbacks rejected.
- [ ] Add protocol tests for malformed token responses, credentials, optional client identity, and old journal state.
- [ ] Add session tests with a fake clock, synthetic storage, deterministic browser capture, and fake request transport.
- [ ] Show RED for missing consent/session behavior before implementation. Wrap expected failures and record their exit codes.
- [ ] Implement canonical schemas and inferred contract types. Do not define protocol shapes in handlers or adapters.
- [ ] Implement PKCE using Web Crypto and random state. Require state before any code exchange.
- [ ] Test success, denial, missing state, wrong state, expired state, replay, duplicate code handling, exchange failure, and explicit cancel.
- [ ] Test optional issuer mismatch, failed browser launch, missing code, malformed discovery, and endpoint-origin mismatch.
- [ ] Test separate device keys, preferred secretStorage, absent-secretStorage fallback, visible warning, and failed verified writes.
- [ ] Test restart from valid credentials, malformed credentials, refresh rotation, concurrent refresh, refresh failure, and persistence failure.
- [ ] Test authenticated requests without valid credentials make no protected request. Test cross-origin request rejection.
- [ ] Test reconnect, cancel, failure, and unload during asynchronous work. Preserve pending operation keys and payloads.
- [ ] Add serialized journal identity tests, including identity update concurrent with enqueue.
- [ ] Implement Settings controls and lifecycle wiring. Register the callback action that matches the specified Obsidian URL.
- [ ] Test host callback dispatch and settings controls through Obsidian mocks. Never start actual browser consent in these tests.
- [ ] Assert no sensitive values reach saveData, logs, error notices, or rendered UI.
- [ ] Run focused tests until GREEN. Run `bun run docs:check` during correction.
- [ ] Run `bun run check`. Report commands, RED/GREEN evidence, changed files, and remaining runtime limits.
- [ ] Commit the task with Conventional Commits. Keep this plan and review records outside tracked product files.

## Acceptance and publication

- [ ] One independent task reviewer checks the complete task against the specification and tests. The worker corrects actionable findings.
- [ ] One session-model branch reviewer checks the whole branch against main. Record reviewed revision and closures in task notes.
- [ ] Open one human branch review against main with Plannotator. Address every annotation before the PR.
- [ ] Verify acceptance criteria from actual test evidence. Read Backlog finalization instructions before closure.
- [ ] Push the branch and create an English Conventional Commit-style PR. Never merge locally.
- [ ] Remove the isolated worktree only after its commits reach the remote and the PR exists. Report the PR and stop.

## Owner manual trial after merge deployment

1. Use only `~/vaults/obsidian-ai-bridge-dev` and `~/vaults/obsidian-ai-bridge-dev-2`.
2. Install the built plugin in each test vault. Open its Settings page and select Connect.
3. Approve consent with names `oab-8.2 dev-1` and `oab-8.2 dev-2`.
4. For an Orca trial, open the captured authorization URL in a dedicated Orca tab.
5. If Access requests a PIN, the owner completes that step in the same tab.
6. Use the form requestSubmit method from the owner brief if the Approve click does not submit.
7. Capture the callback without printing it. Feed it to the plugin callback adapter if Orca cannot open Obsidian.
8. Check distinct client identities and protected credential storage. Inspect no token values.
9. Check reconnect preserves pending state and local files. Do not claim synchronization from Connect alone.

The parent automates browser steps that need no owner action. Record only client IDs, times, and results.
Real Connect acceptance, two-vault synchronization, and ChatGPT account steps remain in OAB-8.8.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Owner approved scope expansion: add tested Worker support for obsidian://ai-bridge/callback. Deploy only through the normal main-merge pipeline. Live registration currently rejects the private callback. No direct Cloudflare changes.

Worker callback policy regression test was run RED before the policy edit: bun run --filter @obsidian-ai-bridge/worker test -- oauth.test.ts -t 'exact Obsidian private callback' returned observed exit 1 because registration returned 400. The OAuth policy then passed the same focused test. Session, storage, and journal tests were added after their initial implementations, so those tests did not have a prior RED run. They now pass in bun run check.

Review record: task review at 47ee53b requested origin binding, shared persistence admission, canonical callback ownership, and accurate discovery TSDoc. Fix 39cf367 addressed all four. Scoped review approved. Whole-branch review at 39cf367 found lowercase provider token incompatibility, refresh during consent replacing reconnect credentials, terminal status, settings-save ownership, and repeated protocol contracts. Fix 124886f addressed all five. Final scoped review approved 124886f. Each finding has direct regression evidence. No actionable finding remains. Documentation scope: changed TypeScript declarations, host ports, schemas, persistence, lifecycle, and API comments. Structural candidates: DeviceSession, credential storage, journal, main/settings, Worker OAuth adapter, and canonical schemas. Reviewers assessed responsibility ownership and cross-method state transitions. Final bun run check passed: tooling 56, protocol 296, plugin 68, Worker 869, total 1289 tests. Direct transport and settings tests pass. Limits: no installed Obsidian routing, live consent, or direct deployment. OAB-8.8 owns installed-host proof. Current deployed private callback remains blocked until normal merge deployment. Human branch review follows before closure.
<!-- SECTION:NOTES:END -->
