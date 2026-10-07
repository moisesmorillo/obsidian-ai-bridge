# M8 experimental plugin implementation plan

> **For agentic workers:** Use `executing-plans` inline; follow the owner-approved M8 scope without renewed approval for routine decisions.

**Goal:** Ship a separately built, explicitly armed disposable-vault plugin and demonstrate all five requested flows with two isolated plugin instances.
**Architecture:** Compose the merged durable client through official Vault capabilities, native SecretStorage and App-local strings. A versioned same-realm App owner retains unsettled work across unload/re-enable; session checks fence every later dispatch. Release entrypoint, manifest, state and M3 runtime remain untouched.
**Tech Stack:** Existing TypeScript, Obsidian 1.13.0, Bun, Vitest, Miniflare/workerd; no new dependencies.
**Spec:** [Accepted M8](../milestones/m8-local-markdown-sync-demo.md), ADR 0021. #112 merged `cf05833`; #113 merged `75968a3`; execution baseline `main/e71bcf3`.

## Global constraints

- Synthetic-only explicit acknowledgement; exact loopback HTTP origin, three ASCII Markdown paths maximum, 16 KiB/note.
- No personal vault, deployment, stable-release installation, delete, rename, migration or MCP. G1–G6 stay open.
- Ledger/config are separate host-local strings; only a native secret reference is configurable. Corrupt/unavailable state is not absent and never resets.
- Install all saved-file listeners before effect admission. All events count as successor observations, including own events; no path/time-based suppression.
- Desktop binary availability does not prove a safe isolated launch. Do not launch an existing user profile that may restore a personal vault. Authorized isolated simulated plugin realms are the fallback.

## Scope estimate and review focus

Five new production modules (`demo-config`, `demo-local`, `demo-owner`, `demo-settings`, `demo-main`), experimental manifest, Worker path-policy consolidation, mise build/smoke tasks, artifact test configuration and the existing Fetch adapter's read-only unsettled-permit accessor: at most ten production files, approximately 800–1,150 net lines. Tests/docs outside the cap. Stop before expanding beyond ten files/1,500 lines.

1. Full metadata preflight must reject folder/alias/ancestor collisions, including aliases introduced after a saved read and inside `Vault.process`.
2. Unload/re-enable during request/read/process must not overlap owners or grant a stale session further dispatch; already dispatched settlement/persistence remains owned.
3. Secret rotation and bad local config must refuse within the same request and not store credentials/bodies in diagnostic state.
4. Prepared-effect recovery verifies saved postconditions, never blindly retries replacement; preservation collision never overwrites.
5. Real artifact separation, UI status and commands must be exercised, not inferred from source-level clients.

## Task 1: Official saved-vault capability and unified path policy

Files: new `apps/obsidian-plugin/src/demo/demo-local.ts`; modify `apps/worker/src/demo/demo-configuration.ts` to reuse exported `syncDemoClientPathSchema`; tests `apps/obsidian-plugin/tests/unit/demo-local.test.ts`.
Interface: `DemoLocal(app.vault, allowed)` implements merged `SyncDemoLocal`; caller supplies active-session predicate.
- [x] Test-first: verify official create/process, exact-byte race refusal, complete metadata aliases/folders/config exclusion, unsupported/oversized bodies, deterministic create-only remote copy/collision and stale-session refusal.
- [x] Implement fresh preflight at read and each effect boundary, compare inside official process and verify saved bytes afterward. No raw filesystem API.
- [x] GREEN and type/static diagnostics; retain evidence.

## Task 2: Retained local owner and explicit plugin/UI

Files: new `demo-config.ts`, `demo-owner.ts`, `demo-settings.ts`, `demo-main.ts`; independent experimental manifest.
Interfaces: strict config decoder with host-local storage; `acquireDemoOwner(app, config)`; owner `attach/detach/syncNow` with finite client and session-gated remote/local adapters; declarative settings and explicit Sync now command/button.
- [x] Test-first: unarmed/malformed/off-loopback settings cause no effects, local-only config/ledger and dispatch-time secret retrieval, layout/listener barriers, successor status, retained busy ownership and incompatible registry/state fencing.
- [x] Implement versioned same-realm registry (not a distributed lock), refuse configuration changes within retained owner; fresh disposable namespace required for reset, no automatic state repair.
- [x] GREEN with useful TSDoc; source release runtime remains unreferenced.

## Task 3: Separate artifact and five-flow demonstration

Files: `.mise.toml`, existing smoke configuration, new artifact tests/typed simulated host helpers outside src.
- [x] Add explicit `demo:plugin:build` and `demo:plugin:smoke`, separate `dist/demo-plugin` output/manifest, included in canonical check/build.
- [x] Load actual CommonJS artifact in two isolated JS realms with two newly created disposable filesystem-backed simulated Vaults, independent App-local storage/native-secret doubles; exercise actual Worker bundle with local workerd R2.
- [x] Demonstrate A→B, B→A, third-principal REST edit, stale write refusal, local/remote concurrent conflict retention with visible attention, cold restart and exact state recovery. Drive bounded explicit commands with honest pending floors, not Worker sleeps.
- [x] Exercise built release noninterference, status/control and lifecycle recovery; label simulation, no real Desktop compatibility claim.
- [x] Run `mise install && mise run check`; inspect diagnostics/coverage/artifact output. Perform post-green author semantic/security review.
- [x] Synchronize spec/roadmap/current-state/architecture/lab and source-bound demonstration report; no later milestone code. If no eligible next milestone exists, leave a roadmap proposal, not invented scope.
- [ ] Publish functional Conventional Commit PR with actual scope, review-size disclosure and evidence. Manual owner merge only.

## Execution evidence

- #112/#113 merge verification and baseline fast-forward passed before implementation.
- Local/owner startup REDs were missing modules, **not assertion-based behavioral proof**. Official local safety then passed 9 tests, combined local/owner 15.
- Post-integration source run passed 20 tests. Genuine secret-await lifecycle RED (`b168e2217`) dispatched once after queued unload; an actual-fetch-boundary execution gate closes it and the assertion passes.
- Native built-artifact scenario `b6a448534` passed both tests in 60.88 seconds: A→B, B→A, REST clean pull, cold App-local owner reload and preserved concurrent versions/attention, followed by same-realm bundle reevaluation without duplicate copy. Every explicit pass asserts ≤32 dispatches. Missing Miniflare resolution and VM btoa/atob were corrected harness capability failures, not production safety findings.
- Strict TS caught literal Vault-event overload selection, fixture brands and DOM/Miniflare RequestInit/Header incompatibility; fixed through explicit narrow adapters, not casts.
- TSDoc presence passed across 276 files; tag-contract lint findings were corrected with meaningful parameter/result semantics. Final canonical `bfaeb296c` runs `mise install/check`, latest artifact rebuild and all diagnostics/coverage; superseded by final `b4f98a2a2`: `mise install/check` passes **2,244 fast / 53 native / 14 artifact tests** (12 unchanged release + 2 experimental), coverage **95.02/91.49/98.61/96.86%**, thresholds unchanged, zero configured diagnostics. The coverage failure at 94.89% was corrected with meaningful GUI/uncertain-I/O tests, never exclusions or threshold reductions.
- One slicing pass considered local capability, retained owner and artifact/UI independently. Remaining owner/artifact slices still exceed 400 with verifying tests/docs; request review-size exception for the cohesive final functional delivery, not the hard production caps.

Post-green author semantic review: local admission owns metadata/atomic-effect/postcondition mechanics; the retained owner owns attachment/execution lease/layout/event-generation/transport-exclusion relationships; the merged core alone owns parent/recovery/ACK/conflict/cursor decisions. Tests exercise process races, stale-secret await dispatch, busy unload/re-enable, unverified state and successor events. No framework objects or weak input escape into core; official supported APIs, strong boundary conversion, semantic TSDoc/status values and unchanged privacy/release boundaries reviewed. No blocking finding remains. This is author review, not independent review or Desktop qualification.

The owner explicitly requests complete delivery and authorizes simulated plugin fallback; no additional approval gate applies to routine accepted implementation choices.
