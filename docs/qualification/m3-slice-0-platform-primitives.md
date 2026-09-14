# M3 Slice 0 — platform primitive qualification

This record covers only M3 implementation-plan Slice 0. It qualifies the local
storage runtime contract and records official host declaration availability before
any mirror, v2 Worker API, settings, credentials, autosync, state machine, recovery
service or production adapter is implemented. M3 remains `NEXT`.

## Conditional R2 qualification

`mise run worker:storage-test` starts an ephemeral Miniflare isolate under Node and
dispatches requests through a test-only Worker module. The module constructs
`Headers` and calls its R2 binding **inside workerd**; the assertions are not an
in-memory R2 mock and do not reach through Wrangler's transitive package layout.
No persistence path, Cloudflare account, remote bucket, token or deployment is used.

The harness is deliberately version-aligned:

| Component | Locked version | Reason |
| --- | --- | --- |
| Wrangler | `4.130.0` | Existing Worker build/development tool |
| Miniflare | `5.20260908.0-alpha` | Exact direct Worker dev dependency; this is the version Wrangler 4.130.0 declares |
| workerd | `1.20260908.1` | Runtime selected by both the locked Wrangler and Miniflare packages |
| Workers declarations | `5.20260910.1` | Existing direct binding declarations, unchanged by this slice |

The runtime test proves these local-emulator behaviors for both `vault/` current
keys and `recovery/` keys:

1. A constructed `Headers` containing `If-None-Match: *` permits the first PUT.
2. A second create-only PUT returns the binding's `null` result; the test Worker
   maps that to 412, and the original bytes, ETag, version and upload timestamp
   remain stored.
3. `onlyIf.etagMatches` permits a replacement with the observed R2 ETag.
4. Reusing the stale ETag returns `null` and leaves the winning replacement bytes
   and metadata unchanged.
5. Two envelopes containing identical note text but different embedded revisions
   have distinct stored bodies, R2 ETags and R2 upload versions.
6. A successful conditional tombstone PUT returns an `uploaded` `Date` for that
   stored generation. A following GET reports the same timestamp, and a stale
   refused PUT does not change it. This is the timestamp primitive ADR 0004 needs
   to calculate recovery retention after the actual head commit.

This proves the required behavior in the pinned local workerd runtime. It is not a
deployed-R2 test, a production Cloudflare compatibility claim, evidence of native
R2 history/trash, or proof of the future envelope/recovery implementation. Slice 2
must still exercise exact handler-to-service-to-adapter races; mocks alone will not
replace this runtime regression test.

Primary API evidence remains Cloudflare's
[R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
conditional PUT accepts `R2Conditional | Headers`, returns `null` without storing
when its condition fails, and successful objects expose `etag`, `version`, and
`uploaded`. The local test pins the historically sensitive constructed-Headers
behavior instead of relying on documentation alone.

## Obsidian and standards declaration qualification

`apps/obsidian-plugin/tests/qualification/host-api-primitives.types.ts` is compiled
by the canonical root typecheck against the installed official `obsidian` **1.13.1**
declarations and the repository's browser `DOM` libraries. It intentionally makes
no runtime call. The checked declaration surfaces are:

| Required surface | Declaration evidence |
| --- | --- |
| Vault `create`, `modify`, `delete`, `rename` | All four overloads accept `TAbstractFile`; rename additionally supplies `oldPath: string`. The create declaration warns it also fires for existing files during initial vault load and points to `Workspace.onLayoutReady`. |
| `App.secretStorage` / `SecretStorage` | `App.secretStorage`, `SecretStorage.setSecret`, `getSecret`, and `listSecrets` are declared since 1.11.4. `getSecret` returns `string \| null`; there is no declared delete method. |
| `SecretComponent` | The native secret-reference component and its `setValue`/`onChange` methods are present. The installed 1.13.1 declaration passes a secret identifier string, not a secret value. |
| `App.loadLocalStorage` / `saveLocalStorage` | Both vault-specific host-local methods are declared since 1.8.7. The official load return is weakly typed as `any \| null`; a future adapter must validate it immediately rather than propagate that type. Save accepts serializable data and clears on `null`. |
| Declarative settings | `PluginSettingTab.getSettingDefinitions`, `getControlValue`, and `setControlValue`, plus `SettingDefinitionItem`, are declared since 1.13.0. `SettingTab.display()` is deprecated for this baseline, so no legacy fallback is permitted. |
| Fetch controls | Browser declarations provide `fetch`, `RequestInit.redirect` including `"error"`, `AbortController`, nullable `Response.body`, `ReadableStream`, and stream readers. These are standards declarations, not Obsidian-host runtime evidence. |

Official source material inspected for this slice:

- [Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts)
- [Obsidian event registration guidance](https://docs.obsidian.md/Plugins/Events)
- [Obsidian secret storage guidance](https://docs.obsidian.md/plugins/guides/secret-storage)
- [Obsidian settings guidance](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [Obsidian mobile development guidance](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)

The declarations establish compile-time availability at the accepted 1.13.0+
baseline. They do **not** establish that a real Obsidian desktop or mobile WebView
has exercised event timing, SecretStorage/SecretComponent, host-local persistence,
Fetch redirect refusal, abort settlement, CORS or bounded stream consumption.
The mobile guide establishes that Node/Electron APIs are unavailable; it does not
certify these Fetch details. Future production composition must feature-detect the
required standards APIs and fail closed, with no `requestUrl`, Node, Electron,
deprecated settings or old-host fallback.

Still unqualified:

- real Obsidian desktop and Android/iOS hosts;
- actual iCloud/external event ordering or event provenance;
- host-local storage quota, durability, rollback and cross-process behavior;
- native secret UI/storage behavior in an installed vault;
- Fetch/AbortController/redirect/CORS/stream behavior in each supported WebView;
- deployed Cloudflare R2 and production account/bucket behavior.

No real or personal vault was used. Slice 1 remains responsible for changing the
manifest and artifact expectations together; this slice leaves the M2 `1.5.0`
artifact and all M1/M2 production behavior unchanged.

## Validation and semantic review

The final Slice 0 tree passed:

- `mise install` with the pinned Bun 1.4.2 and Node.js 24.21.0 already installed;
- `mise run install` using the frozen `bun.lock`;
- `mise run worker:storage-test`: 1 runtime file and 6 tests;
- `mise run check`: Biome, type-aware Oxlint/deprecation checks, all TypeScript
  configurations, 21 source files / 250 tests, coverage, Worker dry-run build and
  3 packaged-plugin smoke tests;
- V8 coverage: 96.75% statements, 93.75% branches, 95.96% functions and 97.04%
  lines, with thresholds and production-source inclusion unchanged;
- `git diff --check`.

The same-session code-review skill pass inspected the runtime boundary, dependency
resolution, test discovery, type assertions, documentation claims and complete
diff. Its initial MINOR finding was that this qualification record did not retain
the exact validation/review evidence required by the implementation plan; this
section fixes that omission. Corrective review confirmed the tests execute R2 calls
inside workerd rather than a storage mock, Miniflare/workerd versions exactly match
Wrangler's dependency graph, no production source or manifest changed, and host
claims remain declaration-only. **Corrective verdict: APPROVE**, with the explicitly
listed real-host/deployed-R2 limitations still unqualified.
