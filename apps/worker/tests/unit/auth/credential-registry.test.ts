import {
  CLIENT_PERMISSION,
  CREDENTIAL_REGISTRY_VERSION,
  MAX_ACTIVE_CREDENTIALS,
} from "@worker/auth/auth.constants";
import type {
  ClientPermission,
  CredentialRegistry,
  CredentialRegistryEntry,
} from "@worker/auth/auth.types";
import {
  CREDENTIAL_DIGEST_DOMAIN,
  decodeCredentialRegistry,
  digestCredentialToken,
  resolveCredentialPrincipal,
  serializeCredentialRegistry,
  validateCredentialRegistry,
} from "@worker/auth/credential-registry";
import { describe, expect, it, vi } from "vitest";

const FULL_PERMISSIONS = [
  CLIENT_PERMISSION.read,
  CLIENT_PERMISSION.write,
  CLIENT_PERMISSION.delete,
] as const;

function credential(
  sequence: number,
  name = `Client ${sequence}`,
  permissions: readonly ClientPermission[] = FULL_PERMISSIONS,
): CredentialRegistryEntry {
  return {
    clientId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    name,
    permissions,
    tokenDigest: sequence.toString(16).padStart(64, "0"),
  };
}

function registry(
  credentials: readonly CredentialRegistryEntry[],
): CredentialRegistry {
  return { version: CREDENTIAL_REGISTRY_VERSION, credentials };
}

describe("credential registry validation", () => {
  it("accepts one, multiple, and exactly sixteen valid clients", () => {
    for (const count of [1, 3, MAX_ACTIVE_CREDENTIALS]) {
      const candidate = registry(
        Array.from({ length: count }, (_, index) => credential(index + 1)),
      );
      expect(validateCredentialRegistry(candidate)).toEqual({
        kind: "valid",
        registry: candidate,
      });
    }
  });

  it("rejects a seventeenth active client", () => {
    expect(
      validateCredentialRegistry(
        registry(
          Array.from({ length: MAX_ACTIVE_CREDENTIALS + 1 }, (_, index) =>
            credential(index + 1),
          ),
        ),
      ),
    ).toEqual({ kind: "invalid" });
  });

  it.each([
    [
      "duplicate client ID",
      [credential(1), { ...credential(2), clientId: credential(1).clientId }],
    ],
    [
      "case-insensitive duplicate name",
      [credential(1, "Writer"), credential(2, "writer")],
    ],
    [
      "duplicate digest",
      [
        credential(1),
        { ...credential(2), tokenDigest: credential(1).tokenDigest },
      ],
    ],
  ] as const)("rejects %s", (_label, credentials) => {
    expect(validateCredentialRegistry(registry(credentials))).toEqual({
      kind: "invalid",
    });
  });

  it.each([
    [
      "uppercase UUID",
      { ...credential(1), clientId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ],
    [
      "non-v4 UUID",
      { ...credential(1), clientId: "00000000-0000-3000-8000-000000000001" },
    ],
    ["empty name", { ...credential(1), name: "" }],
    ["leading punctuation name", { ...credential(1), name: ".writer" }],
    ["trailing space name", { ...credential(1), name: "writer " }],
    ["overlong name", { ...credential(1), name: "a".repeat(65) }],
    ["uppercase digest", { ...credential(1), tokenDigest: "A".repeat(64) }],
    ["short digest", { ...credential(1), tokenDigest: "0".repeat(63) }],
    ["empty permissions", { ...credential(1), permissions: [] }],
    [
      "duplicate permissions",
      { ...credential(1), permissions: ["read", "read"] },
    ],
    ["unknown permission", { ...credential(1), permissions: ["admin"] }],
  ] as const)("rejects malformed entry metadata: %s", (_label, entry) => {
    expect(
      validateCredentialRegistry({
        version: CREDENTIAL_REGISTRY_VERSION,
        credentials: [entry],
      }),
    ).toEqual({ kind: "invalid" });
  });

  it.each([
    ["unsupported version", { version: 2, credentials: [credential(1)] }],
    [
      "unknown root field",
      {
        version: CREDENTIAL_REGISTRY_VERSION,
        credentials: [credential(1)],
        extra: true,
      },
    ],
    [
      "unknown entry field",
      {
        version: CREDENTIAL_REGISTRY_VERSION,
        credentials: [{ ...credential(1), token: "must-not-be-accepted" }],
      },
    ],
  ] as const)("rejects %s", (_label, candidate) => {
    expect(validateCredentialRegistry(candidate)).toEqual({ kind: "invalid" });
  });

  it("fails malformed serialized configuration closed without partial acceptance", () => {
    expect(decodeCredentialRegistry(undefined)).toEqual({ kind: "invalid" });
    expect(decodeCredentialRegistry("not-json")).toEqual({ kind: "invalid" });
    expect(
      decodeCredentialRegistry(
        JSON.stringify({
          version: CREDENTIAL_REGISTRY_VERSION,
          credentials: [credential(1), { ...credential(2), name: "Client 1" }],
        }),
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("serializes only canonical validated registry fields", () => {
    const candidate = registry([credential(1)]);
    expect(
      decodeCredentialRegistry(serializeCredentialRegistry(candidate)),
    ).toEqual({
      kind: "valid",
      registry: candidate,
    });
    expect(() =>
      serializeCredentialRegistry(registry([credential(1), credential(1)])),
    ).toThrow("Invalid credential registry.");
  });
});

describe("credential token verification", () => {
  it("uses a stable domain-separated SHA-256 digest representation", async () => {
    expect(CREDENTIAL_DIGEST_DOMAIN).toBe(
      "obsidian-ai-bridge:client-credential:v1\0",
    );
    const encoder = new TextEncoder();
    const input = encoder.encode(`${CREDENTIAL_DIGEST_DOMAIN}fixture-token`);
    const expectedBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", input),
    );
    const expected = Array.from(expectedBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const domainSeparated = await digestCredentialToken("fixture-token");
    expect(domainSeparated).toBe(expected);

    const rawBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode("fixture-token")),
    );
    const raw = Array.from(rawBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(domainSeparated).not.toBe(raw);
  });

  it("authenticates first, middle, and last entries and returns exact principal metadata", async () => {
    const tokens = ["first-token", "middle-token", "last-token"];
    const entries = await Promise.all(
      tokens.map(async (token, index) => ({
        ...credential(index + 1, ["First", "Middle", "Last"][index]),
        permissions:
          index === 1
            ? ([CLIENT_PERMISSION.read, CLIENT_PERMISSION.delete] as const)
            : FULL_PERMISSIONS,
        tokenDigest: await digestCredentialToken(token),
      })),
    );
    const candidate = registry(entries);

    for (const [index, token] of tokens.entries()) {
      await expect(
        resolveCredentialPrincipal(token, candidate),
      ).resolves.toEqual({
        clientId: entries[index]?.clientId,
        name: entries[index]?.name,
        permissions: entries[index]?.permissions,
      });
    }
    await expect(
      resolveCredentialPrincipal("wrong-token", candidate),
    ).resolves.toBeNull();
  });

  it("evaluates every configured digest even after an early match", async () => {
    const matches = vi.fn((left: string, right: string) => left === right);
    const candidate = registry([credential(1), credential(2), credential(3)]);

    await expect(
      resolveCredentialPrincipal("supplied", candidate, {
        digest: async () => candidate.credentials[0]?.tokenDigest ?? "",
        matches,
      }),
    ).resolves.toMatchObject({ clientId: credential(1).clientId });
    expect(matches).toHaveBeenCalledTimes(candidate.credentials.length);
    expect(matches.mock.calls.map((call) => call[1])).toEqual(
      candidate.credentials.map((entry) => entry.tokenDigest),
    );
  });
});
