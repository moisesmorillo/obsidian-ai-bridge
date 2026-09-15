import {
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorWriterId,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorDeviceState,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import { validateMirrorEndpoint } from "@obsidian-plugin/configuration/mirror-endpoint";
import {
  decodeMirrorPreferences,
  encodeMirrorPreferences,
  MIRROR_PREFERENCES_FORMAT,
  type MirrorPreferences,
  ObsidianPluginDataStore,
} from "@obsidian-plugin/configuration/mirror-preferences";
import { ObsidianSecretReferenceStore } from "@obsidian-plugin/configuration/obsidian-secret-store";
import {
  encodeMirrorDeviceState,
  MIRROR_DEVICE_STATE_STORAGE_KEY,
} from "@obsidian-plugin/state/device-state-codec";
import {
  createHandoffRecord,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import { ObsidianMirrorStateStore } from "@obsidian-plugin/state/obsidian-mirror-state-store";
import { describe, expect, it, vi } from "vitest";

const preferences: MirrorPreferences = {
  origin: "https://bridge.example",
  loopbackHttpOrigin: null,
  secretReference: "ai-bridge-token",
};

describe("mirror endpoint and synced preferences", () => {
  it.each([
    "https://bridge.example/path",
    "https://user@bridge.example",
    "https://bridge.example?query=1",
    "https://bridge.example#fragment",
    String.raw`https://bridge.example\path`,
    "ftp://bridge.example",
    " https://bridge.example",
  ])("rejects a non-origin endpoint without fallback: %s", (value) => {
    expect(validateMirrorEndpoint(value, false).kind).toBe("invalid");
  });

  it("requires HTTPS except explicit exact loopback HTTP before canonicalization", () => {
    expect(validateMirrorEndpoint("https://bridge.example/", false)).toEqual({
      kind: "valid",
      origin: "https://bridge.example",
    });
    expect(
      validateMirrorEndpoint("http://localhost:8787", false),
    ).toMatchObject({
      kind: "invalid",
      reason: "loopback-opt-in-required",
    });
    for (const value of [
      "http://localhost:8787",
      "http://127.0.0.1",
      "http://[::1]:8787",
    ]) {
      expect(validateMirrorEndpoint(value, true).kind).toBe("valid");
    }
    expect(
      validateMirrorEndpoint("http://localhost:99999", true),
    ).toMatchObject({
      kind: "invalid",
      reason: "malformed",
    });
    for (const value of [
      "http://localhost.example",
      "http://127.0.0.2",
      "http://127.1",
      "http://2130706433",
      "http://192.168.1.2",
      "http://[::ffff:127.0.0.1]",
    ]) {
      expect(validateMirrorEndpoint(value, true)).toMatchObject({
        kind: "invalid",
        reason: "insecure",
      });
    }
  });

  it("encodes only preferences and a native secret reference, never local authority or bearer", () => {
    const encoded = encodeMirrorPreferences(preferences);
    expect(encoded).toEqual({
      format: MIRROR_PREFERENCES_FORMAT,
      version: 1,
      ...preferences,
    });
    const text = JSON.stringify(encoded);
    expect(text).not.toMatch(
      /deviceId|activation|ledger|acknowledgement|unresolvedMutation|bearer/i,
    );
    expect(text).not.toContain("PRIVATE_BEARER_VALUE");
    expect(decodeMirrorPreferences(encoded)).toEqual({
      kind: "valid",
      preferences,
    });
  });

  it("distinguishes missing, corrupt, future, and unknown preferences without merging defaults", () => {
    expect(decodeMirrorPreferences(null)).toEqual({ kind: "missing" });
    expect(decodeMirrorPreferences({})).toEqual({ kind: "corrupt" });
    expect(
      decodeMirrorPreferences({
        format: MIRROR_PREFERENCES_FORMAT,
        version: 2,
      }),
    ).toEqual({ kind: "unsupported-version", version: 2 });
    expect(
      decodeMirrorPreferences({
        ...encodeMirrorPreferences(preferences),
        activation: true,
      }),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeMirrorPreferences({
        ...encodeMirrorPreferences(preferences),
        loopbackHttpOrigin: "http://localhost:8787",
      }),
    ).toEqual({ kind: "corrupt" });
  });

  it("rejects oversized, unserializable, noncanonical, and unbound-loopback preferences", () => {
    const circular: { self?: object } = {};
    circular.self = circular;
    expect(decodeMirrorPreferences(circular)).toEqual({ kind: "corrupt" });
    expect(
      decodeMirrorPreferences({
        ...encodeMirrorPreferences(preferences),
        secretReference: "x".repeat(70_000),
      }),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeMirrorPreferences({
        ...encodeMirrorPreferences(preferences),
        origin: "https://BRIDGE.example",
      }),
    ).toEqual({ kind: "corrupt" });
    expect(() =>
      encodeMirrorPreferences({
        ...preferences,
        loopbackHttpOrigin: "http://localhost:8787",
      }),
    ).toThrow("not bound");
    expect(() =>
      encodeMirrorPreferences({
        ...preferences,
        origin: "https://bridge.example:443",
      }),
    ).toThrow("Invalid mirror endpoint");
    expect(() =>
      encodeMirrorPreferences({ ...preferences, secretReference: "" }),
    ).toThrow("Invalid mirror preference fields");
    expect(() =>
      encodeMirrorPreferences({
        ...preferences,
        secretReference: "x".repeat(129),
      }),
    ).toThrow("Invalid mirror preference fields");
  });

  it("fails closed when synced data changes an approved loopback origin or port", () => {
    const approved = encodeMirrorPreferences({
      origin: "http://localhost:8787",
      loopbackHttpOrigin: "http://localhost:8787",
      secretReference: "ai-bridge-token",
    });
    expect(decodeMirrorPreferences(approved).kind).toBe("valid");
    for (const changedOrigin of [
      "http://localhost:8788",
      "http://127.0.0.1:8787",
    ]) {
      expect(
        decodeMirrorPreferences({ ...approved, origin: changedOrigin }),
      ).toEqual({ kind: "corrupt" });
    }
  });

  it("loads and saves valid plugin preferences through the narrow host", async () => {
    const host = {
      loadData: vi.fn(
        async (): Promise<unknown> => encodeMirrorPreferences(preferences),
      ),
      saveData: vi.fn(async (_data: object): Promise<void> => {}),
    };
    const store = new ObsidianPluginDataStore(host);
    expect(await store.load()).toEqual({ kind: "valid", preferences });
    expect(await store.save(preferences)).toEqual({ kind: "saved" });
  });

  it("surfaces plugin-data load/save failures without clearing or plaintext fallback", async () => {
    const host = {
      loadData: vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new Error("private")),
      saveData: vi
        .fn<(data: object) => Promise<void>>()
        .mockRejectedValue(new Error("quota")),
    };
    const store = new ObsidianPluginDataStore(host);
    expect(await store.load()).toEqual({ kind: "unavailable" });
    expect(await store.save(preferences)).toEqual({ kind: "failed" });
    expect(host.saveData).toHaveBeenCalledWith(
      encodeMirrorPreferences(preferences),
    );
  });
});

describe("native secret and host-local state adapters", () => {
  it("fails stale/missing secret references safely without exposing the token", () => {
    const getSecret = vi.fn((reference: string): string | null =>
      reference === "present" ? "PRIVATE_BEARER_VALUE" : null,
    );
    const adapter = new ObsidianSecretReferenceStore({ getSecret });
    expect(new ObsidianSecretReferenceStore({}).check("present")).toEqual({
      kind: "unavailable",
    });
    expect(adapter.check(null)).toEqual({ kind: "missing" });
    expect(adapter.check("stale")).toEqual({ kind: "missing" });
    expect(adapter.check("present")).toEqual({ kind: "available" });
    getSecret.mockReturnValueOnce("");
    expect(adapter.check("empty")).toEqual({ kind: "missing" });
    getSecret.mockImplementationOnce(() => {
      throw new Error("host unavailable");
    });
    expect(adapter.check("broken")).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(adapter.check("present"))).not.toContain(
      "PRIVATE_BEARER_VALUE",
    );
  });

  it("uses only App local storage for device identity/state and leaves corrupt data untouched", async () => {
    const deviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    const state = createDisabledMirrorState(deviceId);
    const host = {
      loadLocalStorage: vi.fn((): unknown => "{malformed"),
      saveLocalStorage: vi.fn<(key: string, data: string | null) => void>(),
    };
    const store = new ObsidianMirrorStateStore(host);
    expect(await store.load()).toEqual({ kind: "corrupt" });
    expect(host.saveLocalStorage).not.toHaveBeenCalled();
    expect(await store.save(state)).toEqual({ kind: "saved" });
    expect(host.saveLocalStorage).toHaveBeenCalledWith(
      MIRROR_DEVICE_STATE_STORAGE_KEY,
      encodeMirrorDeviceState(state),
    );
  });

  it("refuses to persist staged ACK metadata under a stale handoff checksum", async () => {
    const integrity = new WebCryptoHandoffIntegrity();
    const deviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    const associationId = required(
      createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
    );
    const revision = required(
      createApplicationRevision("33333333-3333-4333-8333-333333333333"),
    );
    const path = required(normalizeNotePath("notes/example.md"));
    const contentSha256 = required(createContentSha256("ab".repeat(32)));
    const record = await createHandoffRecord(
      {
        associationId,
        origin: "https://bridge.example",
        entries: [
          {
            path,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision,
              contentSha256,
            },
          },
        ],
      },
      integrity,
    );
    const staged: MirrorDeviceState = {
      deviceId,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
        associationId,
        origin: "https://bridge.example",
      },
      globalBlockReason: null,
      paths: [],
      stagedHandoff: {
        associationId,
        origin: "https://bridge.example",
        checksum: record.checksum,
        entries: record.entries.map((entry) => ({
          ...entry,
          localAlignment: "pending",
          remoteVerification: "pending",
          observationGeneration: 0,
        })),
      },
    };
    const saveLocalStorage = vi.fn();
    const store = new ObsidianMirrorStateStore(
      { loadLocalStorage: () => null, saveLocalStorage },
      integrity,
    );
    expect(await store.save(staged)).toEqual({ kind: "saved" });
    if (staged.stagedHandoff === null) {
      throw new Error("Missing staged handoff fixture.");
    }
    const stagedHandoff = staged.stagedHandoff;
    const stagedEntry = required(stagedHandoff.entries[0]);
    const changed: MirrorDeviceState = {
      ...staged,
      stagedHandoff: {
        ...stagedHandoff,
        entries: [
          {
            ...stagedEntry,
            acknowledgement: {
              kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
              revision,
              contentSha256: required(createContentSha256("cd".repeat(32))),
            },
          },
        ],
      },
    };
    expect(await store.save(changed)).toEqual({
      kind: "failed",
      reason: "quota-or-storage-error",
    });
    expect(saveLocalStorage).toHaveBeenCalledTimes(1);
  });

  it("maps unavailable capabilities and quota/save failures to closed outcomes", async () => {
    const unavailable = new ObsidianMirrorStateStore({});
    expect(await unavailable.load()).toEqual({ kind: "unavailable" });
    const unavailableDeviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    expect(
      await unavailable.save(createDisabledMirrorState(unavailableDeviceId)),
    ).toEqual({ kind: "failed", reason: "unavailable" });
    const host = {
      loadLocalStorage: vi.fn((): unknown => {
        throw new Error("unavailable private");
      }),
      saveLocalStorage: vi.fn<(key: string, data: string | null) => void>(
        () => {
          throw new Error("quota private");
        },
      ),
    };
    const store = new ObsidianMirrorStateStore(host);
    expect(await store.load()).toEqual({ kind: "unavailable" });
    const deviceId = required(
      createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
    );
    expect(await store.save(createDisabledMirrorState(deviceId))).toEqual({
      kind: "failed",
      reason: "quota-or-storage-error",
    });
    const encodeFailureStore = new ObsidianMirrorStateStore({
      loadLocalStorage: () => null,
      saveLocalStorage: vi.fn(),
    });
    expect(
      await encodeFailureStore.save({
        ...createDisabledMirrorState(deviceId),
        lifecycle: {
          kind: "handoff-staged",
          associationId: required(
            createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
          ),
          origin: "https://bridge.example",
        },
      }),
    ).toEqual({ kind: "failed", reason: "quota-or-storage-error" });
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture value.");
  return value;
}
