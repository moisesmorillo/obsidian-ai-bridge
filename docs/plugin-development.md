# Obsidian plugin development and qualification

The current plugin preserves M2 metadata-only inspection, composes the M3 one-way
mirror, and adds explicit reviewed M4 reconciliation. It targets Obsidian **1.13.0+**,
uses only official host APIs and standards web primitives, and is not security-certified
or deployed as a production service. The narrow M5 software-support claim is for the
latest release v1.0.2 on Obsidian Desktop 1.13.7 / macOS 26.6.2 / Apple M4 Pro, with
one active writer and synthetic scale through 10,000 eligible notes. See the [final
qualification report](qualification/m5-final.md) and [operator guide](operations.md#current-m5-qualification-and-support).
No other platform or desktop version is implied. Canonical validation does not require
a Worker deployment, real credentials, or installation in a personal vault.

## Build and generated-artifact qualification

From the repository root after [development setup](../README.md#development):

```bash
mise run plugin:smoke
mise run build
mise run check
```

`plugin:build` uses Bun's browser target and CommonJS format, leaves only `obsidian`
external, and copies the source manifest unchanged:

```text
apps/obsidian-plugin/dist/
├── main.js
└── manifest.json
```

The bundle exposes `module.exports.default`, matching the official sample plugin.
There is no custom export footer, Node/Electron runtime shim, or runtime dependency
other than host-provided `obsidian`. Node is used only by development validation.

`plugin:smoke` rebuilds and evaluates the **actual generated files** in isolated
browser-like CommonJS realms. Its twelve proportional tests are separate from source
coverage and do not import the production entrypoint. They prove packaging/runtime
properties that source tests cannot:

- unchanged manifest identity, 1.13.0 minimum, CommonJS default class, and only the
  `obsidian` external;
- absence of Node globals/imports and fixture bearer/note/recovery content, private-key
  markers, and machine-local path patterns in `main.js`;
- unconfigured inert loading, both M2 commands, M3 operational commands, M4 review/
  recovery command registration, modern declarative settings, native
  `SecretComponent`, official create/modify/delete/
  rename listener registration, layout-ready integration, and cleanup;
- an official saved-file event through the packaged plugin runtime, core engine,
  `RemoteBridge`, and standards Fetch to one real conditional v2 PUT with canonical
  base64url path, bearer, association/writer/operation headers, `If-None-Match: *`,
  Markdown media type/body, and no v1 request;
- a host double that reproduces physical dot-folder creation without subsequent Vault-
  index visibility;
- a packaged remote-ahead review that displays hostile Markdown literally, creates and
  verifies the exact host-visible generated remote preservation artifact, and sends one conditional
  v2 Keep local PUT with the reviewed revision and exact association/writer/operation
  identity; replacing the bundle while that request is pending retains one durable
  owner/operation and conservatively records unknown effect evidence rather than
  duplicating the mutation;
- packaged stale-session, same-text local-event, and changed-remote-revision cases that
  refuse preservation and mutation;
- a packaged exact recovery restore that writes only local bytes, makes no remote
  mutation, and persists `restored-pending-review` ownership;
- retained M3 same-realm in-flight owner reuse, incompatible-registry fail-closed
  behavior, and M2 in-flight inspection exclusion/stale-UI suppression.

The artifact realm provides standards `fetch`, Web Crypto, streams, abort, URL,
encoding, and deterministic timers plus a typed Obsidian host double. It intentionally
does not expose Node production globals. The artifact test TypeScript configuration
alone receives Node filesystem/VM types; production plugin typechecking uses only the
Obsidian/browser surface.

These tests do **not** prove real Obsidian rendering, native secret behavior, WebView
Fetch/CORS/abort timing, mobile compatibility, iCloud event ordering, background iOS
execution, or deployed Worker/R2 behavior.

## Source test boundaries

Source unit and integration tests cover strict preferences/local-state codecs,
SecretStorage dispatch, endpoint policy, Fetch response bounds, event adaptation,
runtime/configuration/reconciliation/handoff ownership, core scheduler/lifecycle
policy, status redaction, and complete Worker behavior. They remain in ordinary V8
coverage. Generated-artifact tests remain build-boundary smoke and never replace or
inflate source coverage.

## Deliberate disposable-vault procedure

This procedure documents manual qualification steps. The bounded M5 scenarios
recorded in the [final report](qualification/m5-final.md) were performed only with
synthetic notes, a disposable vault, and a loopback Worker/R2 emulator; the broader
platform/failure matrix below is not implied complete. Never use a personal or
production vault. Use synthetic, non-sensitive notes and separately authorized
disposable server resources if testing network behavior.

1. Create a new empty disposable vault in Obsidian 1.13.0 or newer. Only Obsidian
   Desktop 1.13.7 on macOS 26.6.2 / Apple M4 Pro is in the M5 support envelope;
   the declared API minimum does not qualify every newer host version. Keep the
   repository outside the vault and record its actual configuration directory.
2. Run `mise run plugin:smoke`. Close the disposable vault, create
   `<vault>/<config-directory>/plugins/ai-bridge/`, and copy only generated `main.js`
   and `manifest.json`. Do not copy source, dependencies, repository configuration,
   secrets, or the whole repository. No `styles.css` is generated.
3. Reopen the vault, enable Community plugins, and enable **AI Bridge**. Initial load
   provisions a non-secret device UUID in official host-local storage and registers
   the M2 commands, M3 settings/operational commands, M4 review/recovery commands,
   and status UI. Saved Vault listeners attach only after workspace layout readiness;
   an unconfigured plugin remains passive and does not scan or send notes.
4. For local-only M2 inspection, create synthetic notes and run **AI Bridge: Inspect
   local Markdown notes** or **AI Bridge: Inspect active Markdown note**. Results show
   paths/byte metadata only, never note bodies. Active inspection reads saved text,
   not an unsaved editor buffer; save and retry. It does not enable the mirror.
5. Network qualification requires a separately authorized empty v2 association. Use
   the complete [operator setup](operations.md#initial-setup-for-a-new-empty-association):
   configure HTTPS (or explicit exact-loopback HTTP), select a native SecretStorage
   reference, copy the displayed device UUID into Worker designation, verify
   authenticated association/writer identity, acknowledge whole eligible scope and
   plaintext/runtime-delete trust, then activate.
6. Use only synthetic eligible lowercase `.md` notes of at most 1 MiB. Dot-prefixed
   segments and the configuration subtree are excluded. Save/create/modify events
   should drive bounded outward requests after layout readiness. Startup buffers a
   bounded number of callbacks, classifies persisted M4 operations, and runs positive
   bootstrap. Before the drain, only current-scan positive paths without unresolved M3
   intent or M4 reservations may use the scheduler; persisted destructive/uncertain work
   waits until callbacks are durable; only then may normal scheduling and persisted M4
   resume proceed. Overflow, failed drain, or active event-delivery rejection closes the
   current lease and normal scheduling; unresolved operations remain fenced until a fresh
   classified listener epoch. Do not infer delete behavior from startup/listener-gap
   absence; only observed events can grant runtime delete authority.
7. Inspect metadata-only status and authenticated Worker reads. Never put credentials
   in screenshots, terminal transcripts, notes, or issue reports. Do not claim an
   iCloud/mobile result unless that exact disposable trace was run and recorded.

### M2 inspection behavior retained

- List enumeration reads metadata only and sorts eligible paths lexically.
- Active inspection reads the exact saved file once and reports measured UTF-8 bytes,
  not content.
- Unsupported/excluded/invalid/oversized files fail closed under the shared policy.
- A second inspection in the same enable lifetime reports busy; unload suppresses
  late UI but cannot cancel a host read.
- Host reads/listing are best-effort snapshots. Same-size edits with indistinguishable
  timestamps can evade race evidence.

## Update, disable, and removal

- Before updating, pause mirror admission and inspect pending/blocked state. Do not
  discard unresolved ledger data. Disable the plugin, close the disposable vault,
  rebuild/smoke-check, replace only `main.js` and `manifest.json`, and restart Obsidian
  when the manifest changes.
- Compatible same-realm replacement/re-enable reuses the runtime owner; a new process
  loads host-local state. Every fresh observation epoch durably gap-fences active M4
  operations before effectful resume; current dispatch rechecks the exact lease, and
  fresh complete-group review is required to settle or transfer reservations. Positive
  scans remain absence-neutral. Unsupported registry/state versions fail closed.
- To remove a disposable installation, pause/drain first, disable AI Bridge, close the
  vault, verify the path, and remove only its `ai-bridge` directory. Removing files
  does not prove in-flight Worker requests were cancelled, revoke/delete a shared
  native secret, or erase host-local state safely.
- If an old experimental `obsidian-ai-bridge` directory exists, disable and remove it
  deliberately before installing `ai-bridge`; never run both. Do not delete the whole
  vault configuration directory.
- Never downgrade to version-2/3/4 plugin code after device-state version 5 is
  written, and never downgrade a Worker that does not understand format-2 generations.
  The v2→v3→v4→v5 transition has no reverse state migration. Follow [rollback
  restrictions](operations.md#rollback-and-downgrade-restrictions).

## Bounded ADR 0013 disposable-host qualification

A corrective disposable-host run in Obsidian 1.13.7 exercised strict v4→v5 startup
migration, a fresh complete-group gap review with atomic successor transfer, and a
later edit made while the plugin was detached. The latter remained unreviewable after
reattach and retained reservations rather than overwriting or releasing authority.
The run used only synthetic notes and a loopback API fixture; it did not qualify the
10,000-note target or the M5 platform/failure matrix. See the [bounded qualification
record](qualification/m4-listener-gap-recovery.md) for scope, outcomes, and limits.

## Official API and minimum-version evidence

The manifest is `ai-bridge`, `minAppVersion: 1.13.0`, and `isDesktopOnly: false`.
Compatibility was checked against installed official `obsidian` **1.13.1**
declarations and official source history, not inferred solely from the manifest:

- [Official current declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
  expose `Plugin`, `Vault` saved-file events, `Workspace.onLayoutReady`,
  `App.secretStorage`, `SecretStorage`, `SecretComponent`,
  `App.loadLocalStorage`/`saveLocalStorage`, modern declarative
  `PluginSettingTab.getSettingDefinitions`, M2 saved reads, Modal/Notice, and
  lifecycle cleanup. Slice 0 records exact declaration evidence in
  [platform qualification](qualification/m3-slice-0-platform-primitives.md).
- SecretStorage is declared since 1.11.4, vault-local App storage since 1.8.7, and
  modern declarative settings since 1.13.0. Deprecated imperative `display()` is not
  used and there is no old-host fallback.
- [Official event guidance](https://docs.obsidian.md/Plugins/Events) requires event
  cleanup. [Load-time guidance](https://docs.obsidian.md/plugins/guides/load-time)
  explains initial create events and layout readiness, but does not make layout-ready
  proof of iCloud hydration completion.
- [Official SecretStorage guidance](https://docs.obsidian.md/plugins/guides/secret-storage)
  describes shared vault-local secret references and plaintext `data.json`; it does
  not establish OS-keychain isolation or a secret delete API.
- [Official sample build configuration](https://github.com/obsidianmd/obsidian-sample-plugin/blob/f8667cee6b35a068b98fb717626893b911247ff6/esbuild.config.mjs)
  uses CommonJS with `obsidian` external. The plugin does not use Node/Electron or
  `requestUrl` fallback.
- [Official mobile guidance](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
  establishes that Node/Electron APIs are unavailable; it does not certify standards
  Fetch streaming/abort/CORS behavior in every desktop/mobile WebView.

Host declarations establish API availability, not runtime qualification. M4 Slice 8
did not install into a vault. Later isolated runs qualified the replacement preservation
root/Keep-local path and bounded listener-gap migration/review/transfer/detached-edit
scenarios; see [preservation evidence](qualification/m4-host-visible-preservation.md)
and [listener-gap evidence](qualification/m4-listener-gap-recovery.md). M5 adds the
exact 1k/5k/10k active-writer and v4→v5 migration/restart envelope on the single
listed desktop host, plus loopback recovery and live-diagnostics checks; see the [final
report](qualification/m5-final.md). Other desktop versions, mobile, iCloud traces,
host-local fsync/durability, general rollback, broad WebView transport behavior, and
deployed Worker/R2 remain explicit residual qualification limits.

## Operating model

The [M3/M4/M5 operator guide](operations.md) is authoritative for initial empty-
association setup, reviewed divergence/tombstone/restore/history operations, conflict
artifact cleanup, one-writer availability, safe upgrade/re-enable, handoff/reset,
independent bearer rotation, recovery list/read/seal/purge, state migration, iCloud
uncertainty, and forbidden rollback/downgrade actions. It defines the narrow v1.0.2
M5 software-support envelope; it does not authorize production Worker deployment,
security certification, a general production service, or complete backup.
