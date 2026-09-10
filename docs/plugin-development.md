# Read-only local plugin development

M2 is complete and implements explicit local inspection, not a connection to the
Worker. See the [validation and semantic review evidence](plans/m2-obsidian-read-only-local-adapter.md).
No credentials,
Cloudflare resources or existing vault installation are needed.

## Build and automated artifact check

From the repository root after the [development setup](../README.md#development):

```bash
mise run build
mise run plugin:smoke
mise run check
```

`plugin:build` uses Bun's browser target and CommonJS format, leaves `obsidian`
external and copies the source manifest unchanged. Output is:

```text
apps/obsidian-plugin/dist/
├── main.js
└── manifest.json
```

The bundle exposes the default Plugin class as `module.exports.default`, matching
the CommonJS namespace/default shape produced by the official sample plugin.
There is no custom export footer, Node runtime shim or runtime dependency other
than host-provided `obsidian`. Node is used only for development validation.

`plugin:smoke` depends on `plugin:build`; `build` includes the smoke check and the
Worker's unchanged non-deploying dry-run. `check` includes `build`. The dedicated
Vitest smoke suite reads the actual generated files and evaluates `main.js` in
an isolated CommonJS realm with only `obsidian` module resolution and standard
web `TextEncoder`, not Node globals. It verifies manifest identity/staging,
external imports, the default class, both commands, inert enabling, saved-file
inspection, unload/re-enable and suppression of late results. This build-boundary
suite is separate from the source tests/coverage and imports no source entry.
Its strictly typed test harness uses Node's built-in filesystem/VM APIs with a
dev-only `@types/node` 24 dependency (locked at 24.13.4), matching the pinned Node
24 toolchain. A dedicated artifact `tsconfig.json` confines explicit Node types to
the tooling boundary. Canonical `typecheck` also checks the production plugin
separately with only Obsidian ambient types, so test-tool Node globals cannot mask
accidental Node runtime usage. No runtime dependency is added to plugin source.

These checks use an in-memory host double. **No real Obsidian desktop or mobile
host, installed vault, or separate editor session has been tested.** They do not
prove visual integration, real event timing or mobile compatibility.

## Deliberate installation into a disposable vault

Do not develop in a personal/production vault. Use only synthetic, non-sensitive
notes. These are manual developer actions, never tasks performed by the plugin.

1. Create a new empty disposable vault in Obsidian **1.5.0 or newer**. Keep this
   repository outside the vault. Note the vault's configuration directory (default
   `.obsidian`; use its actual name if customized).
2. Run `mise run plugin:smoke` from the repository root. Close the disposable vault
   before copying files. Create `<vault>/<config-directory>/plugins/ai-bridge/`
   and copy **only** the generated `main.js` and `manifest.json` into it. Use a
   fresh `ai-bridge` directory: do not overwrite an unknown existing installation.
   Do not copy source, dependencies, a `package.json`, secrets or the entire repo.
   No `styles.css` or `data.json` is generated or required.
3. Reopen the disposable vault. In **Settings → Community plugins**, turn on
   community plugins and enable **AI Bridge**. Enabling alone must not show
   results, enumerate files, read notes or create plugin settings. Obsidian itself
   may persist its enabled-plugin configuration; M2 does not call `saveData`.
4. Create/save synthetic notes through Obsidian, for example `Hello.md` containing
   `hello` (5 UTF-8 bytes if no newline) and a nested Unicode-named `.md` note.
   Add a non-Markdown attachment if desired. The plugin never creates these files.
5. Open the command palette and invoke **AI Bridge: Inspect local Markdown notes**.
   Expect a read-only modal of eligible exact paths in lexical order, byte-size
   metadata and eligible/skipped totals with four skip categories. A vault with
   no eligible files shows an explicit empty result. Enumeration reads no bodies.
6. Open `Hello.md` and invoke **AI Bridge: Inspect active Markdown note**. Expect
   its exact path, measured UTF-8 bytes and saved-file guidance, **not note text**.
   This reads the saved vault file once, not the editor buffer. Save and retry to
   include unsaved edits; the command does not force-save. With no active file or
   an unsupported file, expect a specific refusal, not another note's result.
7. Only lowercase `.md` files with valid literal relative paths and at most 1 MiB
   are eligible. Dot-prefixed path segments and the configured directory subtree
   are excluded. Paths are never URI-decoded/repaired. Unsupported, excluded,
   invalid and oversized files are skipped in that precedence order. Host APIs
   may omit hidden/configuration files entirely; skipped counts cover only files
   the host actually enumerates. No path/body from a skipped file is displayed.
8. A second operation during an inspection reports busy; observed file changes
   fail safely and unexpected failures have generic retry notices. Retry is manual.
   Disable AI Bridge while a result modal is open: owned modals/notices close and
   commands disappear. An in-flight host read cannot be cancelled, but its late
   result must not produce UI. Re-enable to register one fresh pair of commands.

No Worker needs to be running, and offline use has identical behavior. Paths are
sensitive metadata displayed only by deliberate local commands; do not share
screenshots containing private names. Eligibility is **not consent to upload**.

## Update and removal

- For another local build, disable AI Bridge first, close the disposable vault,
  rebuild/smoke-check and replace only its two generated files. Reopen and enable
  again. Restart Obsidian whenever the manifest changes, as the official tutorial
  recommends. Do not run development copying against a real vault.
- To remove, disable AI Bridge, close the disposable vault and remove only the
  manually installed `ai-bridge` plugin directory using your file manager after
  verifying its location. Reopen and confirm the commands are absent. M2 has no
  persisted plugin state/cache to migrate or clean up and has not modified notes.
- If an old experimental installation uses `obsidian-ai-bridge`, disable/remove
  that old plugin directory deliberately before installing `ai-bridge`; do not
  keep two installations enabled. Do not delete the vault configuration directory.

## Official API and minimum-version evidence

The manifest remains `ai-bridge`, `minAppVersion: 1.5.0`, `isDesktopOnly: false`.
Compatibility was checked against installed official `obsidian` **1.13.1** types
and public official API history, not inferred solely from that manifest:

- [Official API declarations at 1.4.11](https://github.com/obsidianmd/obsidian-api/blob/83ce5767ab107e888079e9a673ce4c3153db1ff2/obsidian.d.ts)
  and [that revision's package version](https://github.com/obsidianmd/obsidian-api/blob/83ce5767ab107e888079e9a673ce4c3153db1ff2/package.json)
  establish pre-1.5.0 availability of every used host surface: `Plugin` construction,
  `app`, `addCommand`, lifecycle hooks; `Vault.configDir`, `getFiles`,
  `getAbstractFileByPath`, `read`; `TFile.path`/`stat`, `FileStats.size`/`mtime`;
  `Workspace.getActiveFile`; `Modal` construction, `titleEl`/`contentEl`,
  `open`/`close`, `onOpen`/`onClose`; `Notice` string construction/`hide`; and
  `Node.empty`/`createEl` with the text option. `textContent` and `TextEncoder`
  are standard web APIs, not Node integrations.
- [Current official declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
  match installed signatures. Their `@since` evidence places `getFiles`, `read`,
  `TFile` and `addCommand` at 0.9.7, `configDir` at 0.11.1 and
  `getAbstractFileByPath` at 0.11.11. We deliberately do **not** use `getFileByPath`
  (1.5.7). No used API is marked deprecated. Direct saved-file `read` instead of
  `cachedRead` is the M2 freshness choice, not a raw-byte or atomic snapshot claim.
- [Official sample build configuration](https://github.com/obsidianmd/obsidian-sample-plugin/blob/f8667cee6b35a068b98fb717626893b911247ff6/esbuild.config.mjs)
  specifies CommonJS with `obsidian` external; its default-exported Plugin entry
  supplies the namespace/default convention. Our browser-target bundle does not
  externalize Node builtins or require Electron.
- [Official build/install tutorial](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
  requires a separate development vault, `main.js`, matching plugin directory/ID,
  enabling through Community plugins and reload after code changes. The manual
  procedure above follows those constraints without cloning dependencies into
  a vault or relying on an installed host for canonical validation.

Metadata race checks are best-effort: same-size edits with indistinguishable
mtime can evade detection. Listing is not an atomic snapshot and saved-file text
is already decoded by Obsidian, not raw-byte UTF-8 validation. These limits must
not be reused as write concurrency protection in later milestones.
