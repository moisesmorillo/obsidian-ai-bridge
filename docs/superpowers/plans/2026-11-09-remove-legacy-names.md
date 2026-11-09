# Vaultwire breaking rename and scope consent implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this plan. Track each step with the checkboxes below.

**Goal:** Remove active legacy names and let MCP clients request delete with explicit owner consent.

**Architecture:** Keep the current protocol, plugin adapters, and Worker authorization boundaries. Change names without migration or compatibility code. Keep conditional writes, hash reconciliation, and durable grant checks.

**Tech stack:** TypeScript, Bun, Zod, Obsidian, Cloudflare Workers, Vitest, Biome.

**Spec:** Owner brief R2, including item 8. Backlog task OAB-50.8 records its acceptance criteria. Product contracts remain in `docs/spec.md`, especially sections 7 and 9.

## Owner decisions

The owner chose a breaking release with no compatibility period and no data migration code. Devices and ChatGPT reconnect after release.

Production uses object key `vaultwire`. This selects an empty object. The first connected device imports its local files. Old revision history and export lists remain in the old object.

The owner keeps `vault:delete` separate. Read stays mandatory on consent. Write and delete default checked when requested, but the owner can clear either.

No open product decisions remain. Approval accepts these implementation defaults:

- Rename `docs/api/f2.md` to `docs/api/worker.md` and update active links.
- Remove obsolete deployment evidence from the active API guide rather than relabel historical facts as current facts.
- Preserve released Durable Object transfer migration entries and released tag documentation as history. Report each remaining match with its reason.
- Change the provider identity domain separator to `vaultwire/provider-identity/v1`. No legacy-name fallback is added.
- Reject missing mandatory read, unknown scopes, duplicate scopes, and scopes outside the authenticated consent request.
- Keep device consent selectable too. Device authorization refuses incomplete scope grants because sync needs all three scopes.

## Approach

Use one branch and one implementer for the complete task. This avoids inconsistent protocol paths and storage references between separate writers.

A compatibility alias conflicts with the brief. A data migration also conflicts with the brief. Neither forms part of this plan.

## Global constraints

- Never access the personal vault or run developer tools against a real vault.
- Never deploy or change Cloudflare resources.
- Keep protocol shapes canonical in `packages/protocol`.
- Do not add dependencies.
- Preserve exact observed revisions for mutations. Absence never creates deletion intent.
- Preserve both versions after collisions. Obsolete revisions never overwrite current content.
- Keep README changes narrow because OAB-51 owns the parallel guide rewrite.
- Use a breaking Conventional Commit, such as `feat!: complete Vaultwire rename and scope consent`.
- Do not commit evidence or review-record documents. Put closure notes in Backlog and the pull request.

## Verified feasibility

- `createOAuthOptions` advertises three supported scopes but challenges with only read and write.
- Device enrollment uses `VaultScopeSchema.options`, requests all three scopes, and rejects incomplete token scopes.
- Provider version 1.2.4 supports approved scopes and explicit grant scopes through `completeAuthorization`.
- Provider `approveConsent` accepts even scopes beyond the original request. Application validation must constrain selected scopes to the stored request.
- Existing consent handles bind approval to the browser and work once. Keep these controls.
- Existing production configuration contains a released transfer migration from the old Worker. Keep that historical migration unchanged.

## Review focus

1. A forged scope selection must not expand the stored request. Step 2 tests this before registry effects.
2. A cleared write or delete checkbox must narrow both access and refresh grants. Step 2 tests token behavior.
3. Old local keys, stale epochs, and missing credentials must not lose bytes. Step 1 tests hash reconciliation.
4. A token from the old object must not gain authority in the empty registry. Step 1 tests real Worker requests.
5. Old recovery paths must not leak into new payload references. Step 1 tests the protocol and adapter together.

## Step 1: Breaking protocol, plugin, and object names

**Files:** `packages/protocol/src/schemas/device-auth.ts`, `device-state.ts`, their tests, `apps/plugin/src/main.ts`, `settings.ts`, `infrastructure/{credential-storage,device-storage,settings-sync-storage,text-vault}.ts`, `sync/{enrollment-scope,text-apply}.ts`, plugin tests, `apps/worker/wrangler.production.jsonc`, `apps/worker/src/infrastructure/auth/provider-identity.ts`, Worker OAuth and registry tests.

**Interfaces:** Keep existing function signatures unless migration removal makes them unnecessary. Export `DEVICE_CALLBACK_URI = "obsidian://vaultwire/callback"`. Use `.vaultwire/pending/` and `.vaultwire/pre-apply/` in canonical references.

- [x] Add failing tests for the new callback, new local keys, and new payload and recovery paths.
- [x] Add tests that old local keys yield a new disconnected device. Construct legacy key names from fragments to avoid active legacy-name matches.
- [x] Extend reconciliation tests for stale journal state, an old epoch, and missing credentials followed by reconnect.
- [x] Assert that equal hashes converge, local-only files remain, and conflicting bytes remain visible. Cover import into an empty server.
- [x] Add a Worker regression that presents a valid provider token to a different, empty owner registry. Assert denial without content effects.
- [x] Run focused tests and record their expected failures before source edits.
- [x] Change callbacks, folders, storage prefixes, plugin declarations, CSS class, conflict labels, and provider identity separator.
- [x] Set production `VAULT_OBJECT_NAME` to `vaultwire`. Keep released transfer migration metadata unchanged.
- [x] Remove `plugin-settings-migration.ts`, migration commands, startup gates, target approval state, and calls that exist only for migration.
- [x] Remove `apps/plugin/tools/migrate-plugin.ts`, `plugin-id-migration.md`, and tests dedicated only to that deleted feature.
- [x] Remove old plugin-folder exclusions. Keep the Vaultwire plugin and `.vaultwire/` exclusions. Update enrollment tests accordingly.
- [x] Remove only the obsolete README migration link at this step.
- [x] Run protocol, plugin, and affected Worker tests. Record actual commands and results in task notes.

## Step 2: Scope challenge and selectable consent

**Files:** `apps/worker/src/infrastructure/auth/oauth.ts`, `apps/worker/src/transport/owner-pages/consent.ts`, `apps/worker/test/f2/oauth.test.ts`, `apps/worker/test/consent-page.test.ts`, its snapshot, and device session tests.

**Interfaces:** Keep `ConsentPageViewModel` and `renderConsentPage`. Render one checkbox named `scope` for each requested scope inside the consent form. Keep `vault:read` checked and non-clearable with a submitted hidden value. Submit selected optional scopes only.

- [x] Add failing tests for a challenge with all three scopes and one checkbox per requested scope.
- [x] Test all selected, read-only, read/write, and read/delete grants. Assert the returned token scope and refresh scope.
- [x] Test that `delete_note` works only with delete. Write alone must still return `403 forbidden_scope`.
- [x] Test absent read, unknown, duplicate, and unrequested selections. Reject them before registry consent or grant creation.
- [x] Keep tests for denied consent, expired handles, browser binding, replay prevention, and HTML escaping.
- [x] Run focused tests and record expected failures.
- [x] Set `requiredScopes` to all protocol scopes. Do not turn the challenge list into a rule that rejects narrow valid tokens.
- [x] Render accessible checkboxes. Default requested optional scopes to checked. Keep read mandatory.
- [x] Resolve the authenticated stored consent request, validate submitted selections against it, then create the consent fence.
- [x] Pass only selected scopes to `completeAuthorization`. Keep token exchange and refresh from restoring omitted scopes.
- [x] Keep device enrollment at all three scopes. Test that incomplete device grants fail without file or journal loss.
- [x] Update snapshots and run consent, OAuth, MCP, and device tests.

## Step 3: Deployment guard, current docs, and developer tools

**Files:** `.github/workflows/deploy.yml`, `.gitignore`, `tooling/test/deployment-config.test.ts`, `tooling/{collect-f4,f4-credentials}.ts`, related tests, plugin developer tools and tests, `docs/spec.md`, `docs/api/f2.md`, `docs/f4-coexistence-trial.md`, active links, README MCP scope text if present.

- [x] Change deployment configuration tests to expect `vaultwire` and no cutover-secret guard. Confirm expected failures before source edits.
- [x] Remove the cutover-secret check without weakening actor guards or deployment credential checks.
- [x] Change developer vault names to `vaultwire-dev` and `vaultwire-dev-2` under `~/vaults/`.
- [x] Change current tooling origins and private credential directories to Vaultwire. Run synthetic tests only.
- [x] Update spec sections 7, 9.2, and 9.3 for new paths, callback, scope advertisement, and selected consent.
- [x] Rename the API guide to `docs/api/worker.md`. Replace stale active configuration claims with current repository facts and fix active links.
- [x] Update the coexistence guide and ignore entries. Keep historical released tags and changelogs unchanged.
- [x] Review all name-search matches. Remove active names and list every history exemption in task notes.
- [x] Run `bun run docs:check`, affected tooling tests, and `bun run check`.
- [x] Commit the tested implementation with a breaking Conventional Commit.

## Step 4: Review and publication

- [ ] Get one fresh task reviewer using the code-review skill and TypeScript profile. Address actionable findings with tests.
- [ ] Review the complete branch on the session model using the same skill. Record revision, scope, structural candidates, checks, limits, and finding closures in Backlog.
- [ ] Open one branch review in Plannotator against `main`. Address every annotation.
- [ ] Read Backlog finalization instructions. Verify and check acceptance criteria through the CLI.
- [ ] Fetch and rebase on current `origin/main`. Preserve OAB-51 README changes and remove any reintroduced active names.
- [ ] Run `bun run check` on the final rebased branch. Repeat the acceptance name search and inspect the final diff.
- [ ] Push the branch and create the pull request with an English breaking-change summary and ordered supervisor steps.
- [ ] Remove the worktree only after all commits exist on the remote branch. Never merge locally.

## Final report

Report OAB-50.8, the plan URL, branch review URL, PR URL, commands, results, and every permitted remaining name match.

Describe the breaking release notes for both plugin and Worker. Release Please computes final version numbers. Do not claim a release before publication.

List supervisor steps in this order:

1. Stop all device clients and ChatGPT access. Preserve local file copies before release.
2. Merge the PR and publish the plugin and Worker releases through the approved release process.
3. Confirm deployment and public metadata. Confirm the new object starts empty and denies old grants.
4. Remove the unused cutover repository secret.
5. Rename real developer folders and handle old local folders manually. Do not copy old device state or run removed migration tools.
6. Install the new plugin and reconnect the first complete device. Wait for its file import before reconnecting other devices.
7. Reconnect other devices and check hash reconciliation and visible conflicts.
8. Reconnect ChatGPT with the desired checked scopes. Verify delete only when the owner grants it.
9. Keep old history and export-list access separate from the new object. Any resource cleanup needs separate authorization.
