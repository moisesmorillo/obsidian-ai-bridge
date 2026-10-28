---
id: OAB-7.8
title: Verify real F2 clients revocation and owner account decision
status: Done
assignee:
  - '@pi'
created_date: '2026-10-24T00:05:00Z'
updated_date: '2026-10-28T16:50:00Z'
labels:
  - F2
  - needs-owner-authorization
  - deployed-service
dependencies:
  - OAB-7.7
documentation:
  - docs/spec.md
parent_task_id: OAB-7
ordinal: 7800
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Needs explicit owner authorization for deployed-service use and synthetic test writes. F2 exit needs real MCP clients and an owner account decision. Worker tests cannot supply this evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 MCP Inspector, Claude Code, and ChatGPT web connect to the authorized deployed revision and complete real read and write checks.
- [x] #2 Real OAuth and owner revocation checks prove the next DO request fails with 401 revoked without waiting for KV propagation.
- [x] #3 Owner verifies Developer mode and iPhone availability in their ChatGPT account. Record the result and the owner mobile client strategy.
- [x] #4 Record the AC-08 evidence boundary. Plugin revoked status and local-file preservation remain later plugin obligations, not proof from Worker or MCP tests.
- [x] #5 Any unresolved exit requirement stays open with its blocker. Do not start OAB-8 or later phases or access the personal vault.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Correct the task record with owner results. The owner assistant cancelled the dialog, not the owner. 2. Add failing regression tests for protected-resource scopes_supported and the 401 Bearer scope parameter. Fix scope discovery with canonical protocol scopes and preserve exact origin and denial behavior. 3. Assess owner-subject disclosure and missing console revoked state against the spec without silent scope expansion. 4. Run docs:check and check. Complete task review and branch review, then publish the pull request. 5. Stop before deployment and request separate owner authorization. Repeat named clients and account checks only after an authorized deployment. Keep incomplete criteria and the F2 gate open. Do not start OAB-8.

Owner closure brief on 2026-10-28 supersedes the earlier pending-deployment steps. Record supplied rounds two and three without new service checks. Check AC #1 and #3, preserve the AC-08 boundary, create deferred tasks for S1 and S2, and close this subtask.

Review the parent gate without claiming plugin evidence. Open human branch review, then publish a pull request. No product edits, deployment, state cleanup, or later phase work.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Correction from the owner on 2026-10-28: the owner did not decline the action batch. The owner assistant cancelled the dialog because the results did not fit its options. This record replaces the earlier cancellation claim and Deferred status. The owner supplied the results below. The earlier Backlog-only review did not assess these results or the scope defect.

Access PASS: at 15:03Z the owner completed the PIN login in the Orca browser. The Worker rendered Connected clients. Exact subject verification passed through the Worker verifier. The Access session also served consent pages without another login. No subject, JWT, PIN, token, or cookie belongs in tracked files.

Named clients: no named client completed both read and write. MCP Inspector 2.12.0 used Streamable HTTP and reached consent. Approval returned an authorization code, then Inspector showed Auth challenge: unauthorized. The consent page listed no scopes. The owner reproduced the cause: protected-resource metadata omits scopes_supported and the 401 Bearer challenge omits scope. SDK clients therefore request no scope. Authorization-server scopes_supported does not supply that SDK path. A curl OAuth client without scope received a token with empty scope, then MCP initialize returned 403 forbidden_scope. Explicit vault:read vault:write produced MCP initialize 200. AC #1 stays open until a corrected deployment and real Inspector, Claude Code, and ChatGPT web checks.

Synthetic curl read/write at 15:12Z: tools/list returned nine tools. list_notes with prefix oab-7.8/ returned epoch e3e0b88a44776e55eb8ef8301015f427 and no entries. create_note wrote oab-7.8/20261028-curl-01.md with ETag "e3e0b88a44776e55eb8ef8301015f427.1". read_note returned matching content and ETag. This proves the deployed service path, not any named client.

Revocation PASS for real OAuth client probe rw: baseline GET /v1/vault returned 200 at 15:12:39Z. Owner console revocation completed at 15:12:41Z. The first same-token request at 15:12:42Z returned 401 revoked without WWW-Authenticate. The next request at 15:12:43Z returned 401 invalid_token with the Bearer challenge. The first response proves DO denial before provider cleanup. AC #2 is complete. The scope defect prevented use of the Inspector token.

Account strategy OPEN: ChatGPT web, Developer mode, web write tools, iPhone availability, and the owner mobile strategy wait for the scope correction and an authorized deployment. AC #3 stays open.

AC #4 boundary: actual plugin evidence must prove revoked status and preservation of local files and queues. Worker or MCP results cannot prove those effects. This record does not waive them. AC #5: incomplete exit criteria and the parent F2 gate stay open. No OAB-8 or personal-vault access belongs to this task.

Leftover deployed state from owner checks: probe noscope revoked, probe rw revoked, MCP Inspector 7.8 active with an empty-scope token, and synthetic note oab-7.8/20261028-curl-01.md. Do not remove this state without owner authority.

Findings for assessment: provider authorization codes contain the owner subject as their user-id prefix. Consider an opaque provider identity without changing durable authority or existing grants silently. Revoked clients still show View grants (1) and Revoke with no revoked state. Assess against the spec and OAB-7.3. The owner authorized the local scope correction with TDD on this branch, checks, review, and a pull request. No deployment or Cloudflare resource change is authorized.

Local scope correction: RED command `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts test/f2/mcp-reads.test.ts -t 'publishes configured issuer|keeps OAuth challenges on unauthenticated MCP requests'` exited 1. Both new assertions failed: protected-resource `scopes_supported` was undefined, and the 401 Bearer challenge lacked `scope`. GREEN command `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts test/f2/mcp-reads.test.ts` passed 39 tests. The real OAuth test selects scopes from protected-resource metadata, completes authorization and token exchange, then MCP initialize returns 200. MCP invalid-token challenge retains `resource_metadata` and advertises exactly `vault:read vault:write`. The DO-level revoked 401 still has no `WWW-Authenticate`. No deployment or Cloudflare change occurred.

Local verification completed: `bunx biome check --write apps/worker/src/infrastructure/auth/oauth.ts apps/worker/src/transport/mcp-http.ts apps/worker/test/f2/oauth.test.ts apps/worker/test/f2/mcp-reads.test.ts apps/worker/test/f2/mcp-mutations.test.ts` passed with no formatting changes. `bun run docs:check` passed. Focused F2 command `cd apps/worker && bunx vitest run --config vitest.f2.config.ts test/f2/oauth.test.ts test/f2/mcp-reads.test.ts test/f2/mcp-mutations.test.ts` passed 77 tests. `bun run check` passed: lint, docs, typecheck, tests, and dry-run builds all exited 0. Test logs included expected injected Worker network and SQLite exceptions; all suites passed. AC #1 and #3 and the parent F2 gate remain open pending authorized deployment and named-client/account checks. Provider subject disclosure and owner console revoked state remain outside this correction. No deployment, Cloudflare change, or vault access occurred.

Assessment S1, provider identity disclosure: confirmed in createAuthorizeHandler, which passes owner.subject as completeAuthorization.userId. The installed provider constructs codes and tokens with a userId prefix. This exposes a stable identity to browser history and client logs. It is a privacy concern, not a bearer credential or an Access bypass by itself. An opaque provider identity is preferable, but a safe change also needs stable identity mapping, token callback owner matching, provider KV cleanup, and compatibility with existing grants. A one-line userId replacement would break those paths. Keep this finding open outside the scope correction. Trigger: design and test the identity transition before broader third-party client use. Do not record actual codes, tokens, or subjects.

Assessment S2, owner console state: SqliteClientRegistry.listClients counts all retained client_grants. revokeClient inserts durable denials and keeps those grant rows. markGrantCleanupComplete clears cleanup_pending but does not delete grant history. OwnerClientSchema and OwnerGrantSchema expose no revoked state, and owner.ts renders the count and Revoke action without such a label. Retention and the repeated Revoke button do not mean the grant remains authorized. The real first-request denial proves enforcement. Spec section 9.5 and OAB-7.3 need durable revocation, not deletion of registry history. The explicit revoked device display in AC-08 remains a plugin obligation. Console state remains an operator visibility gap. Trigger: add authoritative active/revoked/cleanup display and tests before relying on this console for client-state decisions. Keep this finding open outside the scope correction.

Task review d542b059 approved the local correction with no actionable findings. Scope: 06b3816..502db7e, including a099750. The reviewer checked the installed provider requiredScopes contract: it advertises metadata and challenge scopes, not global enforcement. Existing route and DO checks retain operation-specific authority. Existing tests cover read-only refresh and write-only denial of reads. The new test covers real local OAuth from discovered scopes through MCP initialize. Documentation and structural review found cohesive provider and transport owners with canonical protocol scope vocabulary. The reviewer used the worker test evidence and did not rerun checks. Deployment and named-client/account evidence remain open.

Final whole-branch review ddff785a approved 181e09101ce77bac05546222696432b45d4b9007..25e3ffa44b0776a7103af44d74582c8f0a3145c4 with no actionable finding in the local correction. It covered all six changed files, installed provider behavior, narrower-token tests, both MCP revoked denial paths, and task evidence. Documentation review covered changed declarations, helper contracts, API docs, and spec sections 9.3/9.5. OAuth and MCP HTTP owners remain cohesive, with protocol vocabulary and durable authority unchanged. S1 identity disclosure and S2 console state remain explicitly open with their triggers. The reviewer confirmed git diff --check exit 0 and reviewed the worker RED/GREEN and full-check evidence without rerunning unchanged tests. Hosted CI and new deployed results did not form part of that review. Human branch review and publication follow. Deployment still needs separate owner authorization.

Human branch review pn-474aa1 approved the complete branch with no changes requested. Publish the reviewed correction and task evidence through a pull request. Keep OAB-7.8 In Progress and AC #1/#3 open. No deployment authorization exists.

Owner evidence, round two, 2026-10-28 UTC. PR #24 at f84a225 merged before the owner-authorized deployment at 16:18Z. Worker version: 0527d86b-0edd-4b56-915f-aa652a38bc5f.

The owner assistant used the documented Wrangler command and owner OAuth session. Public discovery returned 200. Protected-resource metadata listed vault:read and vault:write.

The /mcp 401 Bearer challenge advertised both scopes. OAB-25 tracks CI deployment work separately. This closure task did not deploy or repeat service operations.

MCP Inspector 2.12.0 PASS on the corrected deployment. The owner revoked the stale client and approved MCP Inspector 7.8 v2 at 16:22:23Z. Consent listed vault:read and vault:write.

Inspector connected. Initialize and tools/list passed with nine tools. At 16:23:15Z, list_notes for oab-7.8/ returned the curl note and epoch e3e0b88a44776e55eb8ef8301015f427.

At 16:23:55Z, create_note wrote oab-7.8/20261028-inspector-01.md with ETag "e3e0b88a44776e55eb8ef8301015f427.1". At 16:24:33Z, read_note returned the same path, ETag, and content "OAB-7.8 Inspector synthetic check", with truncated false.

Claude Code 2.1.311 PASS on the corrected deployment. A temporary-directory HTTP MCP configuration requested vault:read vault:write. The owner approved Claude Code 7.8 at 16:28:23Z.

Claude Code reported successful authentication and connection. One prompt called list_notes, create_note, and read_note. Listing returned the same epoch and the curl and Inspector notes.

Creation wrote oab-7.8/20261028-claude-01.md with ETag "e3e0b88a44776e55eb8ef8301015f427.1". Reading returned "OAB-7.8 Claude synthetic check", with truncated false. The check finished at 16:29Z.

Client operator note: before revocation, Inspector refreshed its old empty-scope grant with token response 200, then MCP returned 403 forbidden_scope. Refresh preserves the original grant scope. Clients first authorized before the scope fix need new authorization, not only token refresh.

Owner evidence, round three, 2026-10-28. ChatGPT web PASS. The owner created the OAuth custom app ChatGPT 7.8 at https://obsidian-bridge.mmorillo.dev/mcp.

Developer mode and custom apps were available in the owner account. The owner reported model GPT-6.1 Sol. In a new chat, ChatGPT listed only oab-7.8/, which contained the three earlier notes.

It created oab-7.8/20261028-chatgpt-01.md with content "OAB-7.8 ChatGPT synthetic check" using epoch e3e0b88a44776e55eb8ef8301015f427, then read the content. The owner keeps the screenshot. The source report gives no exact web-check time.

Together with Inspector and Claude Code, this completes AC #1.

iPhone PASS at 11:45 local time on 2026-10-28. The report does not give the local timezone or a UTC conversion. The ChatGPT iPhone app used the same account and ChatGPT 7.8 connector.

It read all four synthetic notes with content, no truncation, revision .1 ETags, and epoch e3e0b88a44776e55eb8ef8301015f427. The owner chose the custom ChatGPT app on iPhone as the mobile client strategy. Developer mode, custom app availability, iPhone availability, and that decision complete AC #3.

This is ChatGPT evidence, not Obsidian plugin evidence.

Latest reported console state at 16:46Z UTC: probe noscope and probe rw remained listed despite revocation. ChatGPT 7.8 and Claude Code 7.8 each showed one grant. MCP Inspector 7.8 v2 showed two grants.

The revoked MCP Inspector 7.8 client no longer appeared. The different listing outcomes remain unexplained. They do not negate the earlier first-request DO revocation proof.

S1 owner-subject prefix stays open in Deferred OAB-26. S2 revoked-client visibility and listing differences stay open in Deferred OAB-27. Both tasks contain explicit triggers.

No actual subject, code, token, or cookie is recorded.

Preserve synthetic notes under oab-7.8/: 20261028-curl-01.md, 20261028-inspector-01.md, 20261028-claude-01.md, and 20261028-chatgpt-01.md. No client, grant, or note cleanup belongs to this task. AC #2 keeps its 15:12:42Z first-request 401 revoked proof.

AC #4 keeps the plugin revoked-state, local-file, and queue preservation obligations open for later plugin evidence. AC #5 keeps OAB-7 open for missing exit evidence. No OAB-8 work or personal-vault access occurred.

Closure review: human branch review pn-976c0e approved the complete Backlog change against main b184c98 with no changes requested. Review scope: the supplied owner results, OAB-7.8 criteria, parent exit boundaries, and both deferred findings. Only four Backlog task files change. No implementation module, semantic declaration, or structural candidate changes.

Closure validation: frozen dependency installation, bun run docs:check, and bun run check all passed with exit 0. The full check included lint, documentation, type checks, tests, and dry-run builds. Owner-supplied real-client results remain the deployed evidence. Local checks do not prove plugin effects or repeat the owner checks.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Recorded owner-supplied deployment and real-client evidence from 2026-10-28. Inspector, Claude Code, and ChatGPT web completed synthetic read/write checks. ChatGPT iPhone read all four notes.

The owner chose the custom ChatGPT app for iPhone. All five subtask criteria now have evidence or their explicit evidence boundary. S1 and S2 remain Deferred in OAB-26 and OAB-27.

OAB-7 stays open because full AC-08 plugin effects lack evidence. No product code, deployment, vault access, or synthetic-state cleanup belongs to this closure.
<!-- SECTION:FINAL_SUMMARY:END -->
