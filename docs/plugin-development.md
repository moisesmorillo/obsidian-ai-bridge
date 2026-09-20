# Obsidian plugin development and qualification

The current plugin preserves M2 metadata-only inspection, composes the experimental
M3 one-way mirror, and adds explicit reviewed M4 reconciliation. It targets Obsidian
**1.13.0+**, uses only official host APIs and standards web primitives, and is not
production certified. Canonical validation does not require a Worker deployment, real
credentials, or installation in a vault.

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
browser-like CommonJS realms. Its eleven proportional tests are separate from source
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
- a packaged remote-ahead review that displays hostile Markdown literally, creates and
  verifies the exact generated remote preservation artifact, and sends one conditional
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

This procedure documents a possible manual qualification; it was **not performed for
M3 or M4 completion**. Never use a personal or production vault. Use synthetic,
non-sensitive notes and separately authorized disposable server resources if testing
network behavior.

1. Create a new empty disposable vault in Obsidian 1.13.0 or newer. Keep the
   repository outside the vault. Record its actual configuration directory (normally
   `.obsidian`).
2. Run `mise run plugin:smoke`. Close the disposable vault, create
   `<vault>/<config-directory>/plugins/ai-bridge/`, and copy only generated `main.js`
   and `manifest.json`. Do not copy source, dependencies, repository configuration,
   secrets, or the whole repository. No `styles.css` is generated.
3. Reopen the vault, enable Community plugins, and enable **AI Bridge**. Initial load
   provisions a non-secret device UUID in official host-local storage, registers the
   two M2 commands, M3 settings/operational commands, M4 review/recovery commands,
   status UI, and saved Vault listeners. An unconfigured plugin remains passive: it
   does not scan or send notes.
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
   should drive bounded outward requests after layout-ready bootstrap. Do not infer
   delete behavior from startup absence; only observed post-bootstrap events can grant
   runtime delete authority.
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
  loads host-local state. Listener gaps receive positive-only reconciliation and
  absence never authorizes delete. Unsupported registry/state versions fail closed.
- To remove a disposable installation, pause/drain first, disable AI Bridge, close the
  vault, verify the path, and remove only its `ai-bridge` directory. Removing files
  does not prove in-flight Worker requests were cancelled, revoke/delete a shared
  native secret, or erase host-local state safely.
- If an old experimental `obsidian-ai-bridge` directory exists, disable and remove it
  deliberately before installing `ai-bridge`; never run both. Do not delete the whole
  vault configuration directory.
- Never downgrade to version-2/3 plugin code after device-state version 4 is written,
  and never downgrade a Worker that does not understand format-2 generations. The
  v2→v3→v4 transition has no reverse state migration. Follow [rollback restrictions](operations.md#rollback-and-downgrade-restrictions).

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
did not install into a vault. Real desktop/mobile, iCloud traces, native secret UI,
host-local durability/rollback, WebView transport behavior, and deployed Worker/R2
remain explicit residual qualification limits.

## Operating model

The [M3/M4 operator guide](operations.md) is authoritative for initial empty-
association setup, reviewed divergence/tombstone/restore/history operations, conflict
artifact cleanup, one-writer availability, safe upgrade/re-enable, handoff/reset,
independent bearer rotation, recovery list/read/seal/purge, state migration, iCloud
uncertainty, and forbidden rollback/downgrade actions. It does not authorize deployment
or claim production support.
