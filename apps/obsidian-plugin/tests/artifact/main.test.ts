import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import manifest from "@obsidian-plugin-manifest";
import * as obsidian from "@obsidian-plugin-tests/support/obsidian-runtime";
import {
  App,
  Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  TFile,
  TFolder,
} from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "obsidian",
  async () => import("@obsidian-plugin-tests/support/obsidian-runtime"),
);

/** Reads generated files only; no production source entry import is involved. */
const bundle = readFileSync(
  new URL("../../dist/main.js", import.meta.url),
  "utf8",
);
const manifestText = readFileSync(
  new URL("../../dist/manifest.json", import.meta.url),
  "utf8",
);

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const ASSOCIATION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION = "44444444-4444-4444-8444-444444444444";
const REMOTE_REVISION = "55555555-5555-4555-8555-555555555555";
const RESOLVED_REVISION = "66666666-6666-4666-8666-666666666666";
const REMOTE_OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const RECOVERY_ID = "88888888-8888-4888-8888-888888888888";
const RECOVERY_REVISION = "99999999-9999-4999-8999-999999999999";
const NOTE_PATH = "artifact/100% 雪.md";
const ENCODED_NOTE_PATH = "YXJ0aWZhY3QvMTAwJSDpm6oubWQ";
const NOTE_BODY = "ARTIFACT-FIXTURE-NOTE-BODY";
const MALICIOUS_REMOTE_BODY =
  "# Untrusted\n<script>globalThis.compromised = true</script>\n[run](command:erase-vault)";
const RECOVERY_BODY = "ARTIFACT-FIXTURE-RECOVERY-BODY";
const BEARER = "ARTIFACT-FIXTURE-BEARER";
const SECRET_REFERENCE = "artifact-secret-reference";
const STATE_KEY = "ai-bridge:mirror-device-state";

interface ArtifactRealmOptions {
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly performance?: Pick<Performance, "now">;
  readonly window?: Pick<Window, "setTimeout" | "clearTimeout">;
}

interface ArtifactLivePathState {
  readonly path: string;
  readonly acknowledgement: {
    readonly kind: "live";
    readonly revision: string;
    readonly contentSha256: string;
  };
  readonly unresolvedMutation: null;
  readonly desired: { readonly kind: "none" };
  readonly blockedReason: null;
}

/**
 * One isolated browser-like CommonJS realm retained across bundle evaluations.
 * Reusing this object models same-realm plugin replacement without importing the
 * source registry implementation into the artifact test.
 */
class ArtifactRealm {
  private readonly required: string[] = [];
  private readonly sandbox: Record<string, unknown>;
  private readonly context;

  /** @param options - Standards-only capabilities supplied to the generated bundle. */
  constructor(options: ArtifactRealmOptions = {}) {
    const timerHost =
      options.window ??
      ({
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      } satisfies Pick<Window, "setTimeout" | "clearTimeout">);
    this.sandbox = {
      AbortController,
      DOMException,
      Headers,
      ReadableStream,
      Request,
      Response,
      TextDecoder,
      TextEncoder,
      URL,
      btoa: globalThis.btoa,
      clearTimeout: timerHost.clearTimeout,
      crypto: globalThis.crypto,
      fetch: options.fetch,
      performance: options.performance ?? globalThis.performance,
      setTimeout: timerHost.setTimeout,
      window: timerHost,
      require: (name: string) => {
        expect(name).toBe("obsidian");
        this.required.push(name);
        return obsidian;
      },
    };
    this.context = createContext(this.sandbox);
  }

  /**
   * Evaluates a fresh copy of the generated bundle and awaits its host load hook.
   * @param app - Stable host identity used to test replacement ownership.
   * @returns The actual packaged plugin instance.
   */
  async load(app: App = new App()): Promise<obsidian.Plugin> {
    const module: { exports: unknown } = { exports: {} };
    this.sandbox.module = module;
    this.sandbox.exports = module.exports;
    new Script(
      `(function(module, exports, require) {\n${bundle}\n})(module, exports, require);`,
      { filename: "ai-bridge/main.js" },
    ).runInContext(this.context);
    expect(this.required.length).toBeGreaterThan(0);
    const namespace = module.exports;
    if (
      typeof namespace !== "object" ||
      namespace === null ||
      !("default" in namespace)
    ) {
      throw new Error("Expected a CommonJS default export namespace");
    }
    const pluginClass = namespace.default;
    if (
      typeof pluginClass !== "function" ||
      !(pluginClass.prototype instanceof obsidian.Plugin)
    ) {
      throw new Error("Expected the default export to extend the host Plugin");
    }
    expect(JSON.parse(manifestText)).toEqual(manifest);
    const plugin: unknown = Reflect.construct(pluginClass, [app, manifest]);
    if (!(plugin instanceof obsidian.Plugin)) {
      throw new Error("Expected a host Plugin instance");
    }
    await plugin.load();
    return plugin;
  }

  /** Installs a deliberately incompatible package registry before plugin load. */
  installIncompatibleRegistry(): void {
    new Script(
      `Object.defineProperty(globalThis, Symbol.for("obsidian-ai-bridge.runtime-mirror-coordinator"), {
        value: { format: "obsidian-ai-bridge-runtime-registry", version: 999, coordinators: new WeakMap() },
        configurable: true,
        enumerable: false,
        writable: false
      });`,
    ).runInContext(this.context);
  }
}

/**
 * @param id - Host-qualified command identity from the packaged plugin.
 * @returns The registered callback, failing immediately if packaging lost a command.
 */
function command(id: string): () => Promise<void> {
  const callback = obsidian.host.commands.get(id)?.callback;
  if (!callback) throw new Error("Expected a registered command callback");
  return async () => {
    await callback();
  };
}

/**
 * Installs strict active-writer state/preferences without importing source codecs.
 * @param paths - Exact content-free durable path records.
 */
function configureActiveWriter(
  paths: readonly ArtifactLivePathState[] = [],
): void {
  obsidian.host.localStorage.set(
    STATE_KEY,
    JSON.stringify({
      format: "obsidian-ai-bridge-device-state",
      version: 5,
      deviceId: DEVICE_ID,
      lifecycle: {
        kind: "active",
        associationId: ASSOCIATION_ID,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths,
      stagedHandoff: null,
      reconciliationGapGroupReviews: [],
      reconciliationReviews: [],
      reconciliationOperations: [],
    }),
  );
  obsidian.host.loadData.mockResolvedValue({
    format: "obsidian-ai-bridge-preferences",
    version: 1,
    origin: "https://bridge.example",
    loopbackHttpOrigin: null,
    secretReference: SECRET_REFERENCE,
  });
  obsidian.host.secrets.set(SECRET_REFERENCE, BEARER);
}

/**
 * Installs one exact live acknowledgement for packaged M4 qualification.
 * @param contentSha256 - Exact local or historical baseline text digest.
 */
function configureLiveBaseline(contentSha256: string): void {
  configureActiveWriter([
    {
      path: NOTE_PATH,
      acknowledgement: {
        kind: "live",
        revision: REVISION,
        contentSha256,
      },
      unresolvedMutation: null,
      desired: { kind: "none" },
      blockedReason: null,
    },
  ]);
}

/**
 * @param content - Exact saved text to expose through the host.
 * @returns One eligible saved file in the host double.
 */
function addSavedNote(content = NOTE_BODY): TFile {
  const file = new TFile();
  file.path = NOTE_PATH;
  file.stat = {
    size: new TextEncoder().encode(content).byteLength,
    mtime: 1_000,
    ctime: 1_000,
  };
  obsidian.host.files.set(file.path, file);
  obsidian.host.contents.set(file, content);
  return file;
}

/**
 * @param value - Exact packaged request body to fingerprint.
 * @returns Hex SHA-256 matching the Worker's receipt contract.
 */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * @param value - JSON-compatible response payload.
 * @param status - HTTP response status.
 * @param headers - Additional operation-specific response headers.
 * @returns A typed JSON response with the API media type.
 */
function json(
  value: object,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

interface CapturedRequest {
  readonly url: URL;
  readonly init: RequestInit;
}

interface ReviewServer {
  readonly fetch: (url: URL, init: RequestInit) => Promise<Response>;
  readonly requests: CapturedRequest[];
  setRemote(revision: string, content: string): void;
  resolvePendingMutation(): Promise<void>;
}

/**
 * Creates one stateful v2 server double used only through packaged Fetch calls.
 * @param pendingMutation - Whether the reviewed PUT remains unsettled until replacement.
 * @returns Captured v2 server behavior and mutation controls.
 */
async function createReviewServer(
  pendingMutation = false,
): Promise<ReviewServer> {
  let remoteRevision = REMOTE_REVISION;
  let parentRevision = REVISION;
  let remoteContent = MALICIOUS_REMOTE_BODY;
  let receiptOperationId = REMOTE_OPERATION_ID;
  let pendingRequest: CapturedRequest | null = null;
  const pending = pendingMutation ? Promise.withResolvers<Response>() : null;
  const requests: CapturedRequest[] = [];

  /**
   * Builds the exact acknowledgement for one captured conditional update.
   * @param request - Captured reviewed PUT.
   * @returns Exact format-2 acknowledgement response.
   */
  const mutationResponse = async (request: CapturedRequest) => {
    const headers = new Headers(request.init.headers);
    const operationId = headers.get("Bridge-Operation-Id");
    if (operationId === null || typeof request.init.body !== "string") {
      return json(
        { error: { code: "invalid_request", message: "Invalid request." } },
        400,
      );
    }
    const contentSha256 = await sha256(request.init.body);
    remoteContent = request.init.body;
    parentRevision = remoteRevision;
    receiptOperationId = operationId;
    remoteRevision = RESOLVED_REVISION;
    return json(
      {
        path: NOTE_PATH,
        revision: remoteRevision,
        receipt: {
          action: "update",
          associationId: ASSOCIATION_ID,
          operationId,
          precondition: {
            kind: "matching-revision",
            revision: parentRevision,
          },
          contentSha256,
        },
      },
      200,
      { ETag: `"m3-${remoteRevision}"` },
    );
  };

  const fetch = async (url: URL, init: RequestInit): Promise<Response> => {
    const request = { url, init };
    requests.push(request);
    if (url.pathname === "/api/v2/mirror") {
      return json({
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION_ID,
        writerId: DEVICE_ID,
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      });
    }
    if (url.pathname === "/api/v2/notes") {
      return json({ notes: [NOTE_PATH], nextCursor: null });
    }
    if (url.pathname === "/api/v2/recovery") {
      return json({ recoveries: [], nextCursor: null });
    }
    if (url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}/state`) {
      const contentSha256 = await sha256(remoteContent);
      return json(
        {
          kind: "live",
          path: NOTE_PATH,
          revision: remoteRevision,
          contentSha256,
          receipt: {
            action: "update",
            associationId: ASSOCIATION_ID,
            operationId: receiptOperationId,
            precondition: {
              kind: "matching-revision",
              revision: parentRevision,
            },
            contentSha256,
          },
        },
        200,
        { ETag: `"m3-${remoteRevision}"` },
      );
    }
    if (
      url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}` &&
      init.method === "GET"
    ) {
      return new Response(remoteContent, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Bridge-Note-Format": "2",
          ETag: `"m3-${remoteRevision}"`,
        },
      });
    }
    if (
      url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}` &&
      init.method === "PUT"
    ) {
      if (
        new Headers(init.headers).get("If-Match") !== `"m3-${remoteRevision}"`
      ) {
        return json(
          { error: { code: "precondition_failed", message: "Stale." } },
          412,
        );
      }
      if (pending !== null) {
        pendingRequest = request;
        return pending.promise;
      }
      return mutationResponse(request);
    }
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  };

  return {
    fetch,
    requests,
    setRemote: (revision, content) => {
      parentRevision = remoteRevision;
      receiptOperationId = REMOTE_OPERATION_ID;
      remoteRevision = revision;
      remoteContent = content;
    },
    resolvePendingMutation: async () => {
      if (pending === null || pendingRequest === null) {
        throw new Error("Expected one pending packaged mutation.");
      }
      pending.resolve(await mutationResponse(pendingRequest));
    },
  };
}

/**
 * Creates an exact read-only tombstone/recovery server for packaged restore.
 * @returns Captured server behavior and requests.
 */
async function createRecoveryServer() {
  const contentSha256 = await sha256(RECOVERY_BODY);
  const requests: CapturedRequest[] = [];
  const metadata = {
    kind: "prepared",
    id: RECOVERY_ID,
    associationId: ASSOCIATION_ID,
    path: NOTE_PATH,
    revision: RECOVERY_REVISION,
    sourceRevision: REVISION,
    contentSha256,
  };
  const fetch = async (url: URL, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    if (url.pathname === "/api/v2/mirror") {
      return json({
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION_ID,
        writerId: DEVICE_ID,
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      });
    }
    if (url.pathname === "/api/v2/notes") {
      return json({ notes: [], nextCursor: null });
    }
    if (url.pathname === "/api/v2/recovery") {
      return json({ recoveries: [metadata], nextCursor: null });
    }
    if (url.pathname === `/api/v2/recovery/${RECOVERY_ID}/content`) {
      return new Response(RECOVERY_BODY, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Bridge-Note-Format": "2",
          ETag: `"m3-${RECOVERY_REVISION}"`,
        },
      });
    }
    if (url.pathname === `/api/v2/recovery/${RECOVERY_ID}`) {
      return json(metadata, 200, {
        ETag: `"m3-${RECOVERY_REVISION}"`,
      });
    }
    if (url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}/state`) {
      return json(
        {
          kind: "tombstone",
          path: NOTE_PATH,
          revision: REMOTE_REVISION,
          deletedRevision: REVISION,
          recoveryId: RECOVERY_ID,
          receipt: {
            action: "tombstone",
            associationId: ASSOCIATION_ID,
            operationId: RECOVERY_ID,
            precondition: {
              kind: "matching-revision",
              revision: REVISION,
            },
          },
        },
        200,
        { ETag: `"m3-${REMOTE_REVISION}"` },
      );
    }
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  };
  return { fetch, requests };
}

/** Physical effects retained separately from the Vault index in the artifact host double. */
interface VaultMutationHostEvidence {
  readonly physicalFolders: ReadonlyMap<string, TFolder>;
  readonly physicalFiles: ReadonlyMap<string, TFile>;
}

/** @returns Official create/folder/process behavior plus physical effects hidden from the Vault index. */
function installVaultMutationHost(): VaultMutationHostEvidence {
  const folders = new Map<string, TFolder>();
  const physicalFolders = new Map<string, TFolder>();
  const physicalFiles = new Map<string, TFile>();
  obsidian.host.vault.getAbstractFileByPath.mockImplementation(
    (path) => obsidian.host.files.get(path) ?? folders.get(path) ?? null,
  );
  obsidian.host.vault.createFolder.mockImplementation(async (path) => {
    if (physicalFiles.has(path) || physicalFolders.has(path)) {
      throw new Error("Path collision");
    }
    const folder = new TFolder();
    folder.path = path;
    physicalFolders.set(path, folder);
    if (!path.split("/").some((segment: string) => segment.startsWith("."))) {
      folders.set(path, folder);
    }
    return folder;
  });
  obsidian.host.vault.create.mockImplementation(async (path, content) => {
    if (physicalFiles.has(path) || physicalFolders.has(path)) {
      throw new Error("Path collision");
    }
    const file = new TFile();
    file.path = path;
    file.stat = {
      size: new TextEncoder().encode(content).byteLength,
      mtime: 2_000,
      ctime: 2_000,
    };
    physicalFiles.set(path, file);
    if (!path.split("/").some((segment: string) => segment.startsWith("."))) {
      obsidian.host.files.set(path, file);
      obsidian.host.contents.set(file, content);
    }
    return file;
  });
  obsidian.host.vault.process.mockImplementation(async (file, update) => {
    const next = update(obsidian.host.contents.get(file) ?? "");
    obsidian.host.contents.set(file, next);
    file.stat.size = new TextEncoder().encode(next).byteLength;
    return next;
  });
  return { physicalFolders, physicalFiles };
}

/** @returns One visible modal or fails when the packaged command did not open it. */
function visibleModal(): obsidian.Modal {
  const modal = [...obsidian.host.modals].at(-1);
  if (modal === undefined) throw new Error("Expected a visible modal.");
  return modal;
}

/**
 * @param modal - Visible packaged modal.
 * @param label - Exact text-only control label.
 * @returns Matching immediate button.
 */
function modalButton(modal: obsidian.Modal, label: string) {
  const button = modal.contentEl
    .querySelectorAll("button")
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing modal button: ${label}`);
  return button;
}

/** @returns Verification of current association/designation through packaged settings. */
async function verifyPackagedServerIdentity(): Promise<void> {
  const settings = [...obsidian.host.settingsTabs][0];
  if (settings === undefined) throw new Error("Expected packaged settings.");
  const identity = findSetting(
    settings.settingItems,
    "Authenticated server identity",
  );
  if (identity.action === undefined) {
    throw new Error("Expected server identity action.");
  }
  Reflect.apply(identity.action, undefined, [undefined, 0]);
  await vi.waitFor(() =>
    expect(obsidian.host.notices.at(-1)?.message).toBe(
      "Server association and writer designation verified.",
    ),
  );
}

/**
 * Loads a tracked packaged writer and opens one exact remote-ahead review.
 * @param server - Stateful v2 server double.
 * @returns Packaged realm, host identities, modal, and saved note.
 */
async function openPackagedReview(server: ReviewServer) {
  configureLiveBaseline(await sha256(NOTE_BODY));
  installVaultMutationHost();
  const file = addSavedNote();
  let now = 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const realm = new ArtifactRealm({
    fetch: server.fetch,
    performance: { now: () => now },
    window: {
      setTimeout: (callback: TimerHandler) => {
        if (typeof callback !== "function") {
          throw new Error("Expected a callback timer.");
        }
        const handle = nextTimer++;
        timers.set(handle, () => Reflect.apply(callback, undefined, []));
        return handle;
      },
      clearTimeout: (handle?: number) => {
        if (handle !== undefined) timers.delete(handle);
      },
    },
  });
  const app = new App();
  const plugin = await realm.load(app);
  obsidian.host.becomeLayoutReady();
  await vi.waitFor(() => expect(timers.size).toBeGreaterThan(0));
  now = 1_000;
  const wakes = [...timers.values()];
  timers.clear();
  for (const wake of wakes) wake();
  await vi.waitFor(() =>
    expect(obsidian.host.localStorage.get(STATE_KEY)).toContain(
      '"blockedReason":"diverged"',
    ),
  );
  await verifyPackagedServerIdentity();
  await command("ai-bridge:review-remote-divergence")();
  await vi.waitFor(() => expect(obsidian.host.modals.size).toBe(1));
  const modal = visibleModal();
  modalButton(modal, NOTE_PATH).click();
  await vi.waitFor(() =>
    expect(
      modal.contentEl
        .querySelectorAll("button")
        .some((candidate) => candidate.textContent === "keep-local"),
    ).toBe(true),
  );
  return { app, file, modal, plugin, realm };
}

/**
 * Finds one nested modern declarative setting by its stable label.
 * @param items - Current packaged settings definition tree.
 * @param name - Exact setting label to find.
 * @returns The matching leaf definition.
 * @throws When packaging omitted the expected definition.
 */
function findSetting(
  items: readonly SettingDefinitionItem[],
  name: string,
): SettingDefinition {
  for (const item of items) {
    if ("name" in item && item.name === name && !("items" in item)) return item;
    if ("items" in item && Array.isArray(item.items)) {
      try {
        return findSetting(item.items, name);
      } catch {}
    }
  }
  throw new Error(`Missing setting definition: ${name}`);
}

beforeEach(obsidian.resetHost);

describe("packaged Obsidian main.js", () => {
  it("models physical dot-folder creation without Vault-index visibility", async () => {
    const evidence = installVaultMutationHost();

    await obsidian.host.vault.createFolder(".ai-bridge-conflicts");

    expect(evidence.physicalFolders.has(".ai-bridge-conflicts")).toBe(true);
    expect(
      obsidian.host.vault.getAbstractFileByPath(".ai-bridge-conflicts"),
    ).toBeNull();
  });

  it("stages a browser CommonJS artifact with only the intended Obsidian external and no fixture, secret, or machine leakage", () => {
    expect(manifestText).toBe(
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
    );
    expect(JSON.parse(manifestText)).toMatchObject({
      id: "ai-bridge",
      minAppVersion: "1.13.0",
      isDesktopOnly: false,
    });
    const requires = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map(
      (match) => match[1],
    );
    expect(requires.length).toBeGreaterThan(0);
    expect(new Set(requires)).toEqual(new Set(["obsidian"]));
    expect(bundle).not.toMatch(
      /\b(?:Buffer|Bun|__dirname|__filename)\b|\bprocess\.(?:env|cwd|argv|versions)\b|node:|import\s*\(/,
    );
    expect(bundle).not.toContain(BEARER);
    expect(bundle).not.toContain("OBSIDIAN_BRIDGE_TOKEN");
    expect(bundle).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(bundle).not.toContain(NOTE_BODY);
    expect(bundle).not.toContain(MALICIOUS_REMOTE_BODY);
    expect(bundle).not.toContain(RECOVERY_BODY);
    expect(bundle).not.toMatch(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:\\Users\\|\bDeno\.|\.adapter\.(?:read|write|remove|rename)\b/,
    );
  });

  it("loads inertly, exposes native settings and reviewed commands, and cleans up official host registrations", async () => {
    const plugin = await new ArtifactRealm().load();
    expect(
      [...obsidian.host.commands].map(([id, entry]) => [id, entry.name]),
    ).toEqual([
      ["ai-bridge:inspect-local-notes", "Inspect local Markdown notes"],
      ["ai-bridge:inspect-active-note", "Inspect active Markdown note"],
      ["ai-bridge:show-mirror-status", "Show mirror status"],
      ["ai-bridge:check-mirror-now", "Check mirror now"],
      ["ai-bridge:retry-mirror-failures", "Retry mirror failures"],
      ["ai-bridge:pause-mirror", "Pause mirror"],
      ["ai-bridge:resume-mirror", "Resume mirror"],
      ["ai-bridge:prepare-writer-handoff", "Prepare writer handoff"],
      ["ai-bridge:review-remote-divergence", "Review remote divergence"],
      ["ai-bridge:restore-recovery-snapshot", "Restore recovery snapshot"],
      ["ai-bridge:review-observation-gaps", "Review observation gaps"],
    ]);
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    expect(obsidian.host.getActiveFile).not.toHaveBeenCalled();
    expect(obsidian.host.loadData).toHaveBeenCalledTimes(1);
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
    expect(obsidian.host.vaultListeners.size).toBe(0);
    expect(obsidian.host.onLayoutReady).toHaveBeenCalledOnce();
    obsidian.host.becomeLayoutReady();
    expect(obsidian.host.vaultListeners.get("create")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("modify")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("delete")).toHaveLength(1);
    expect(obsidian.host.vaultListeners.get("rename")).toHaveLength(1);

    const settings = [...obsidian.host.settingsTabs][0];
    if (settings === undefined) throw new Error("Expected a settings tab");
    const secret = findSetting(
      settings.settingItems,
      "Bearer secret reference",
    );
    if (secret.render === undefined) {
      throw new Error("Expected a declarative SecretComponent setting");
    }
    Reflect.apply(secret.render, undefined, [
      Reflect.construct(Setting, []),
      {},
    ]);
    expect(obsidian.host.secretComponents).toHaveLength(1);
    expect(obsidian.host.getSecret).not.toHaveBeenCalled();

    const file = new TFile();
    file.path = "100% 雪.md";
    file.stat = { size: 3, mtime: 1_000, ctime: 1_000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.contents.set(file, "雪");
    obsidian.host.active = file;
    await command("ai-bridge:inspect-local-notes")();
    expect(obsidian.host.vault.read).not.toHaveBeenCalled();
    const [modal] = [...obsidian.host.modals];
    if (!modal) throw new Error("Expected a visible metadata modal");
    expect(
      modal.contentEl.children.map((child) => child.textContent),
    ).toContain("100% 雪.md — 3 bytes");
    await command("ai-bridge:inspect-active-note")();
    expect(obsidian.host.vault.read).toHaveBeenCalledExactlyOnceWith(file);
    expect(obsidian.host.notices.at(-1)?.message).toBe(
      "Saved note: 100% 雪.md\nUTF-8 bytes: 3\nSaved vault text only. Save and retry to include unsaved changes.",
    );

    plugin.unload();
    expect(obsidian.host.commands.size).toBe(0);
    expect(obsidian.host.settingsTabs.size).toBe(0);
    expect(obsidian.host.vaultListeners.size).toBe(4);
    expect(
      [...obsidian.host.vaultListeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
    expect(obsidian.host.modals.size).toBe(0);
    expect(modal.contentEl.children).toEqual([]);
    expect(obsidian.host.notices.every((notice) => notice.hidden)).toBe(true);
    expect(obsidian.host.contents.get(file)).toBe("雪");
    expect(obsidian.host.saveData).not.toHaveBeenCalled();
  });

  it("turns an official saved-file event into one real v2 conditional request with canonical addressing and privileged identity", async () => {
    configureActiveWriter();
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const contentHash = await sha256(NOTE_BODY);
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname === "/api/v2/mirror") {
          return json({
            protocol: "obsidian-ai-bridge-mirror-v2",
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            maxNoteSizeBytes: 1024 * 1024,
            maxPageSize: 50,
            recoveryRetentionSeconds: 2_592_000,
          });
        }
        if (url.pathname === "/api/v2/notes") {
          return json({ notes: [], nextCursor: null });
        }
        if (url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}/state`) {
          return json({ kind: "absent", path: NOTE_PATH });
        }
        const headers = new Headers(init.headers);
        const operationId = headers.get("Bridge-Operation-Id");
        if (
          url.pathname === `/api/v2/notes/${ENCODED_NOTE_PATH}` &&
          init.method === "PUT" &&
          operationId !== null
        ) {
          return json(
            {
              path: NOTE_PATH,
              revision: REVISION,
              receipt: {
                action: "create",
                associationId: ASSOCIATION_ID,
                operationId,
                precondition: { kind: "absent" },
                contentSha256: contentHash,
              },
            },
            201,
            { ETag: `"m3-${REVISION}"` },
          );
        }
        return json(
          { error: { code: "not_found", message: "Not found." } },
          404,
        );
      },
    );
    const realm = new ArtifactRealm({
      fetch,
      performance: { now: () => now },
      window: {
        setTimeout: (callback: TimerHandler) => {
          if (typeof callback !== "function") {
            throw new Error("Expected a callback timer");
          }
          const handle = nextTimer++;
          timers.set(handle, () => Reflect.apply(callback, undefined, []));
          return handle;
        },
        clearTimeout: (handle?: number) => {
          if (handle !== undefined) timers.delete(handle);
        },
      },
    });
    const plugin = await realm.load();
    expect(fetch).not.toHaveBeenCalled();
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    expect(obsidian.host.vault.on).not.toHaveBeenCalled();
    const layoutReadyRegistrationOrder =
      obsidian.host.onLayoutReady.mock.invocationCallOrder[0] ?? 0;

    obsidian.host.becomeLayoutReady();
    expect(obsidian.host.vault.on.mock.invocationCallOrder[0]).toBeGreaterThan(
      layoutReadyRegistrationOrder,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const file = addSavedNote();
    obsidian.host.emitVault("modify", file);
    await vi.waitFor(() => expect(timers.size).toBe(1));
    now = 1_000;
    const wake = [...timers.values()][0];
    timers.clear();
    wake?.();

    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([, init]) => init.method === "PUT")).toBe(
        true,
      ),
    );
    const mutation = fetch.mock.calls.find(([, init]) => init.method === "PUT");
    if (mutation === undefined) throw new Error("Expected a packaged PUT");
    const [url, init] = mutation;
    const headers = new Headers(init.headers);
    expect(url.pathname).toBe(`/api/v2/notes/${ENCODED_NOTE_PATH}`);
    expect(url.pathname).not.toContain("/api/v1/");
    expect(init.body).toBe(NOTE_BODY);
    expect(headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Bridge-Association-Id")).toBe(ASSOCIATION_ID);
    expect(headers.get("Bridge-Writer-Id")).toBe(DEVICE_ID);
    expect(headers.get("Bridge-Operation-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(headers.get("If-None-Match")).toBe("*");
    expect(headers.has("If-Match")).toBe(false);
    expect(
      fetch.mock.calls.every(([request]) =>
        request.pathname.startsWith("/api/v2/"),
      ),
    ).toBe(true);
    expect(obsidian.host.getSecret).toHaveBeenCalledWith(SECRET_REFERENCE);
    expect(obsidian.host.request).not.toHaveBeenCalled();
    expect(obsidian.host.requestUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(obsidian.host.loadData.mock.results)).not.toContain(
      BEARER,
    );
    expect([...obsidian.host.localStorage.values()].join("\n")).not.toContain(
      NOTE_BODY,
    );
    plugin.unload();
  });

  it("reuses the actual same-realm owner across bundle replacement while a packaged mutation remains in flight", async () => {
    configureActiveWriter();
    const file = addSavedNote();
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const contentHash = await sha256(NOTE_BODY);
    const pendingInventory = Promise.withResolvers<Response>();
    const pendingMutation = Promise.withResolvers<Response>();
    let inventoryRequests = 0;
    const fetch = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname === "/api/v2/mirror") {
          return json({
            protocol: "obsidian-ai-bridge-mirror-v2",
            associationId: ASSOCIATION_ID,
            writerId: DEVICE_ID,
            maxNoteSizeBytes: 1024 * 1024,
            maxPageSize: 50,
            recoveryRetentionSeconds: 2_592_000,
          });
        }
        if (url.pathname === "/api/v2/notes") {
          inventoryRequests += 1;
          return inventoryRequests === 1
            ? pendingInventory.promise
            : json({ notes: [], nextCursor: null });
        }
        if (url.pathname.endsWith("/state")) {
          return json({ kind: "absent", path: NOTE_PATH });
        }
        if (init.method === "PUT") return pendingMutation.promise;
        return json(
          { error: { code: "not_found", message: "Not found." } },
          404,
        );
      },
    );
    const realm = new ArtifactRealm({
      fetch,
      performance: { now: () => now },
      window: {
        setTimeout: (callback: TimerHandler) => {
          if (typeof callback !== "function") {
            throw new Error("Expected a callback timer");
          }
          const handle = nextTimer++;
          timers.set(handle, () => Reflect.apply(callback, undefined, []));
          return handle;
        },
        clearTimeout: (handle?: number) => {
          if (handle !== undefined) timers.delete(handle);
        },
      },
    });
    const app = new App();
    const runtimeA = await realm.load(app);
    obsidian.host.becomeLayoutReady();
    await vi.waitFor(() => expect(timers.size).toBe(2));
    now = 1_000;
    const wakeEntry = [...timers.entries()].at(-1);
    if (wakeEntry === undefined) throw new Error("Expected a wake timer");
    timers.delete(wakeEntry[0]);
    wakeEntry[1]();
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
      ).toHaveLength(1),
    );

    const localLoadsBeforeReplacement =
      obsidian.host.loadLocalStorage.mock.calls.length;
    expect(localLoadsBeforeReplacement).toBeGreaterThan(0);
    runtimeA.unload();
    const runtimeB = await realm.load(app);
    expect(obsidian.host.loadLocalStorage).toHaveBeenCalledTimes(
      localLoadsBeforeReplacement,
    );
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname === "/api/v2/mirror"),
    ).toHaveLength(1);
    expect(obsidian.host.vault.getFiles).toHaveBeenCalledTimes(1);
    const pendingPut = fetch.mock.calls.find(
      ([, init]) => init.method === "PUT",
    );
    const operationId = new Headers(pendingPut?.[1].headers).get(
      "Bridge-Operation-Id",
    );
    if (operationId === null) {
      throw new Error("Expected the retained packaged operation identity");
    }
    pendingMutation.resolve(
      json(
        {
          path: NOTE_PATH,
          revision: REVISION,
          receipt: {
            action: "create",
            associationId: ASSOCIATION_ID,
            operationId,
            precondition: { kind: "absent" },
            contentSha256: contentHash,
          },
        },
        201,
        { ETag: `"m3-${REVISION}"` },
      ),
    );
    pendingInventory.resolve(json({ notes: [], nextCursor: null }));
    await vi.waitFor(() => {
      const persisted = obsidian.host.localStorage.get(STATE_KEY);
      if (typeof persisted !== "string") {
        throw new Error("Expected persisted packaged runtime state");
      }
      expect(persisted).toContain(operationId);
      expect(persisted).toContain('"phase":"evidence-required"');
    });
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === "PUT"),
    ).toHaveLength(1);
    expect(obsidian.host.contents.get(file)).toBe(NOTE_BODY);
    runtimeB.unload();
  });

  it("renders untrusted Markdown literally and retains one reviewed preservation resolution across compatible replacement", async () => {
    const server = await createReviewServer(true);
    const { app, modal, plugin, realm } = await openPackagedReview(server);

    modalButton(modal, "Show remote text preview").click();
    const preview = modal.contentEl
      .querySelectorAll("pre")
      .find((candidate) => candidate.textContent === MALICIOUS_REMOTE_BODY);
    expect(preview?.textContent).toBe(MALICIOUS_REMOTE_BODY);
    expect(preview?.children).toEqual([]);
    expect(Reflect.get(globalThis, "compromised")).toBeUndefined();

    modalButton(modal, "keep-local").click();
    await vi.waitFor(() =>
      expect(
        server.requests.filter(({ init }) => init.method === "PUT"),
      ).toHaveLength(1),
    );
    const mutation = server.requests.find(({ init }) => init.method === "PUT");
    if (mutation === undefined) throw new Error("Expected reviewed v2 PUT.");
    const headers = new Headers(mutation.init.headers);
    const operationId = headers.get("Bridge-Operation-Id");
    if (operationId === null)
      throw new Error("Expected reviewed operation ID.");
    expect(mutation.url.pathname).toBe(`/api/v2/notes/${ENCODED_NOTE_PATH}`);
    expect(mutation.init.body).toBe(NOTE_BODY);
    expect(headers.get("Authorization")).toBe(`Bearer ${BEARER}`);
    expect(headers.get("Bridge-Association-Id")).toBe(ASSOCIATION_ID);
    expect(headers.get("Bridge-Writer-Id")).toBe(DEVICE_ID);
    expect(headers.get("If-Match")).toBe(`"m3-${REMOTE_REVISION}"`);
    expect(headers.has("If-None-Match")).toBe(false);
    expect(
      server.requests.every(({ url }) => url.pathname.startsWith("/api/v2/")),
    ).toBe(true);
    const preservationPath = `ai-bridge-conflicts/${operationId}/remote.md`;
    const preservation = obsidian.host.files.get(preservationPath);
    expect(preservation).toBeDefined();
    expect(
      preservation === undefined
        ? undefined
        : obsidian.host.contents.get(preservation),
    ).toBe(MALICIOUS_REMOTE_BODY);

    const loadsBeforeReplacement =
      obsidian.host.loadLocalStorage.mock.calls.length;
    plugin.unload();
    const replacement = await realm.load(app);
    expect(obsidian.host.loadLocalStorage).toHaveBeenCalledTimes(
      loadsBeforeReplacement,
    );
    expect(
      server.requests.filter(({ init }) => init.method === "PUT"),
    ).toHaveLength(1);

    await server.resolvePendingMutation();
    await vi.waitFor(() => {
      const persisted = obsidian.host.localStorage.get(STATE_KEY);
      if (typeof persisted !== "string") {
        throw new Error("Expected persisted reviewed operation.");
      }
      expect(persisted).toContain(operationId);
      expect(persisted).toContain('"phase":"evidence-required"');
      expect(persisted).toContain('"remoteEffect":"unknown"');
    });
    expect(
      server.requests.filter(({ init }) => init.method === "PUT"),
    ).toHaveLength(1);
    const original = obsidian.host.files.get(NOTE_PATH);
    if (original === undefined) throw new Error("Expected original note.");
    expect(obsidian.host.contents.get(original)).toBe(NOTE_BODY);
    replacement.unload();
  });

  it.each(["session", "local-event", "remote-revision"] as const)(
    "rejects a stale %s review before packaged mutation",
    async (staleDimension) => {
      const server = await createReviewServer();
      const { file, modal, plugin } = await openPackagedReview(server);
      const keepLocal = modalButton(modal, "keep-local");

      if (staleDimension === "session") {
        plugin.unload();
        keepLocal.disabled = false;
      }
      if (staleDimension === "local-event") {
        obsidian.host.emitVault("modify", file);
        await Promise.resolve();
        await Promise.resolve();
      }
      if (staleDimension === "remote-revision") {
        server.setRemote(
          RESOLVED_REVISION,
          `${MALICIOUS_REMOTE_BODY}\nchanged`,
        );
      }
      keepLocal.click();

      await vi.waitFor(() =>
        expect(
          modal.contentEl.children.map((child) => child.textContent).join("\n"),
        ).toContain("stale or unavailable"),
      );
      expect(
        server.requests.filter(({ init }) => init.method === "PUT"),
      ).toHaveLength(0);
      expect(obsidian.host.vault.create).not.toHaveBeenCalled();
      if (staleDimension !== "session") plugin.unload();
    },
  );

  it("restores exact recovery bytes locally without remote mutation and keeps reviewed pending ownership", async () => {
    configureLiveBaseline(await sha256(RECOVERY_BODY));
    installVaultMutationHost();
    const server = await createRecoveryServer();
    const plugin = await new ArtifactRealm({ fetch: server.fetch }).load();
    obsidian.host.becomeLayoutReady();
    await vi.waitFor(() =>
      expect(
        [...obsidian.host.statusBars].some((item) =>
          item.textContent.includes("0 pending"),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        server.requests.some(({ url }) => url.pathname === "/api/v2/notes"),
      ).toBe(true),
    );

    await verifyPackagedServerIdentity();
    await command("ai-bridge:restore-recovery-snapshot")();
    await vi.waitFor(() => expect(obsidian.host.modals.size).toBe(1));
    const modal = visibleModal();
    modalButton(modal, `${NOTE_PATH} — prepared`).click();
    await vi.waitFor(() =>
      expect(
        modal.contentEl
          .querySelectorAll("button")
          .some(
            (candidate) => candidate.textContent === "Confirm recovery restore",
          ),
      ).toBe(true),
    );
    const confirmation = modal.contentEl.querySelectorAll("input")[0];
    if (confirmation === undefined) {
      throw new Error("Expected exact recovery destination confirmation.");
    }
    confirmation.value = NOTE_PATH;
    modalButton(modal, "Confirm recovery restore").click();

    await vi.waitFor(() => {
      const restored = obsidian.host.files.get(NOTE_PATH);
      expect(restored).toBeDefined();
      expect(
        restored === undefined
          ? undefined
          : obsidian.host.contents.get(restored),
      ).toBe(RECOVERY_BODY);
      const persisted = obsidian.host.localStorage.get(STATE_KEY);
      if (typeof persisted !== "string") {
        throw new Error("Expected persisted restore fence.");
      }
      expect(persisted).toContain('"phase":"restored-pending-review"');
    });
    expect(
      server.requests.filter(({ init }) =>
        ["PUT", "DELETE", "POST"].includes(init.method ?? "GET"),
      ),
    ).toHaveLength(0);
    expect(
      server.requests.every(({ url }) => url.pathname.startsWith("/api/v2/")),
    ).toBe(true);
    plugin.unload();
  });

  it("fails closed when the generated bundle encounters an incompatible registry version", async () => {
    const realm = new ArtifactRealm();
    realm.installIncompatibleRegistry();
    const plugin = await realm.load();
    expect([...obsidian.host.commands.keys()]).toEqual([
      "ai-bridge:inspect-local-notes",
      "ai-bridge:inspect-active-note",
      "ai-bridge:show-mirror-status",
    ]);
    expect(obsidian.host.settingsTabs.size).toBe(0);
    expect(obsidian.host.vaultListeners.size).toBe(0);
    expect(obsidian.host.loadLocalStorage).not.toHaveBeenCalled();
    expect(obsidian.host.vault.getFiles).not.toHaveBeenCalled();
    plugin.unload();
  });

  it("serializes a pending M2 read across unload and re-enable without stale UI", async () => {
    const realm = new ArtifactRealm();
    const plugin = await realm.load();
    const file = new TFile();
    file.path = "active.md";
    file.stat = { size: 0, mtime: 1_000, ctime: 1_000 };
    obsidian.host.files.set(file.path, file);
    obsidian.host.active = file;
    const pending = Promise.withResolvers<string>();
    obsidian.host.vault.read.mockReturnValue(pending.promise);
    const inspect = command("ai-bridge:inspect-active-note");
    const work = inspect();
    plugin.unload();
    await inspect();
    await plugin.load();
    const replacement = plugin;
    await command("ai-bridge:inspect-local-notes")();
    const currentNotice = obsidian.host.notices.at(-1);
    const listCallsBeforeSettle =
      obsidian.host.vault.getFiles.mock.calls.length;
    const modalCountBeforeSettle = obsidian.host.modals.size;
    pending.resolve("");
    await work;
    expect(obsidian.host.vault.read).toHaveBeenCalledTimes(1);
    expect(listCallsBeforeSettle).toBe(0);
    expect(modalCountBeforeSettle).toBe(0);
    expect(currentNotice?.message).toBe("An inspection is already running.");
    expect(obsidian.host.notices).toEqual([currentNotice]);
    expect(obsidian.host.modals.size).toBe(0);
    await command("ai-bridge:inspect-local-notes")();
    expect(obsidian.host.vault.getFiles).toHaveBeenCalledTimes(1);
    expect(obsidian.host.modals.size).toBe(1);
    replacement.unload();
    expect(currentNotice?.hidden).toBe(true);
  });
});
