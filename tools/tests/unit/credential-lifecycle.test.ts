import { spawnSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_PERMISSION,
  CREDENTIAL_REGISTRY_VERSION,
  MAX_ACTIVE_CREDENTIALS,
} from "@worker/auth/auth.constants";
import type {
  CredentialRegistry,
  CredentialRegistryEntry,
} from "@worker/auth/auth.types";
import {
  decodeCredentialRegistry,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_LIFECYCLE_FAILURE,
  CREDENTIAL_TOKEN_BYTES,
  type CredentialGenerationDependencies,
  createCredential,
  createEmptyCredentialRegistry,
  replaceEntireRegistry,
  replaceLostCredential,
  revokeCredential,
  rotateCredential,
} from "#tools/credentials/credential-lifecycle";

function deterministicGeneration(start = 1): CredentialGenerationDependencies {
  let sequence = start;
  return {
    fillRandom: (target) => {
      target.fill(sequence);
    },
    randomUuid: () =>
      `00000000-0000-4000-8000-${(sequence++).toString(16).padStart(12, "0")}`,
    digestToken: async (token) =>
      Array.from(new TextEncoder().encode(token))
        .reduce((sum, byte) => sum + byte, 0)
        .toString(16)
        .padStart(64, "0"),
  };
}

function entry(sequence: number): CredentialRegistryEntry {
  return {
    clientId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    name: `Client ${sequence}`,
    permissions: [CLIENT_PERMISSION.read],
    tokenDigest: sequence.toString(16).padStart(64, "0"),
  };
}

function registry(
  credentials: readonly CredentialRegistryEntry[],
): CredentialRegistry {
  return { version: CREDENTIAL_REGISTRY_VERSION, credentials };
}

const WRITER_METADATA = {
  name: "Desktop writer",
  permissions: [
    CLIENT_PERMISSION.read,
    CLIENT_PERMISSION.write,
    CLIENT_PERMISSION.delete,
  ],
} as const;

describe("offline credential lifecycle", () => {
  it("creates a valid digest-only entry from exactly 256 random bits", async () => {
    let randomByteLength = 0;
    const dependencies = deterministicGeneration();
    const created = await createCredential(
      createEmptyCredentialRegistry(),
      WRITER_METADATA,
      {
        ...dependencies,
        fillRandom: (target) => {
          randomByteLength = target.byteLength;
          dependencies.fillRandom(target);
        },
      },
    );

    expect(created.kind).toBe("success");
    if (created.kind !== "success") return;
    expect(randomByteLength).toBe(CREDENTIAL_TOKEN_BYTES);
    expect(created.value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.value.registry.credentials).toEqual([
      {
        clientId: created.value.clientId,
        name: WRITER_METADATA.name,
        permissions: WRITER_METADATA.permissions,
        tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const serialized = serializeCredentialRegistry(created.value.registry);
    expect(serialized).not.toContain(created.value.token);
    expect(decodeCredentialRegistry(serialized).kind).toBe("valid");
  });

  it.each([
    [{ name: "", permissions: [CLIENT_PERMISSION.read] }, "empty name"],
    [{ name: "Client", permissions: [] }, "empty permissions"],
    [{ name: "Client", permissions: ["admin"] }, "unknown permission"],
    [
      {
        name: "Client",
        permissions: [CLIENT_PERMISSION.read, CLIENT_PERMISSION.read],
      },
      "duplicate permission",
    ],
  ] as const)(
    "deterministically rejects invalid metadata: %s",
    async (metadata, _label) => {
      await expect(
        createCredential(
          createEmptyCredentialRegistry(),
          metadata,
          deterministicGeneration(),
        ),
      ).resolves.toEqual({
        kind: "failure",
        reason: CREDENTIAL_LIFECYCLE_FAILURE.invalidMetadata,
      });
    },
  );

  it("fails closed when secure randomness is unavailable", async () => {
    const dependencies = deterministicGeneration();
    await expect(
      createCredential(createEmptyCredentialRegistry(), WRITER_METADATA, {
        ...dependencies,
        fillRandom: () => {
          throw new Error("unavailable");
        },
      }),
    ).resolves.toEqual({
      kind: "failure",
      reason: CREDENTIAL_LIFECYCLE_FAILURE.secureRandomUnavailable,
    });
  });

  it("rotates to a distinct client and keeps bounded overlap until explicit revoke", async () => {
    const original = registry([entry(1)]);
    const rotated = await rotateCredential(
      original,
      entry(1).clientId,
      { ...WRITER_METADATA, name: "Desktop writer next" },
      deterministicGeneration(2),
    );

    expect(rotated.kind).toBe("success");
    if (rotated.kind !== "success") return;
    expect(rotated.value.clientId).not.toBe(entry(1).clientId);
    expect(rotated.value.registry.credentials[0]).toEqual(entry(1));
    expect(rotated.value.registry.credentials).toHaveLength(2);

    const revoked = revokeCredential(rotated.value.registry, entry(1).clientId);
    expect(revoked).toEqual({
      kind: "success",
      value: registry([rotated.value.registry.credentials[1] ?? entry(99)]),
    });
  });

  it("refuses rotation when no overlap slot remains", async () => {
    const full = registry(
      Array.from({ length: MAX_ACTIVE_CREDENTIALS }, (_, index) =>
        entry(index + 1),
      ),
    );
    await expect(
      rotateCredential(
        full,
        entry(1).clientId,
        { ...WRITER_METADATA, name: "Replacement" },
        deterministicGeneration(17),
      ),
    ).resolves.toEqual({
      kind: "failure",
      reason: CREDENTIAL_LIFECYCLE_FAILURE.capacityExceeded,
    });
  });

  it("revokes only the exact client and refuses unknown or malformed updates", () => {
    const original = registry([entry(1), entry(2), entry(3)]);
    expect(revokeCredential(original, entry(2).clientId)).toEqual({
      kind: "success",
      value: registry([entry(1), entry(3)]),
    });
    expect(revokeCredential(original, entry(9).clientId)).toEqual({
      kind: "failure",
      reason: CREDENTIAL_LIFECYCLE_FAILURE.credentialNotFound,
    });
    expect(
      revokeCredential(registry([entry(1), entry(1)]), entry(1).clientId),
    ).toEqual({
      kind: "failure",
      reason: CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry,
    });
  });

  it("replaces a lost credential without preserving its overlap or digest", async () => {
    const original = registry([entry(1), entry(2)]);
    const replaced = await replaceLostCredential(
      original,
      entry(1).clientId,
      { ...WRITER_METADATA, name: "Recovered writer" },
      deterministicGeneration(3),
    );

    expect(replaced.kind).toBe("success");
    if (replaced.kind !== "success") return;
    expect(
      replaced.value.registry.credentials.some(
        (credential) => credential.clientId === entry(1).clientId,
      ),
    ).toBe(false);
    expect(replaced.value.registry.credentials).toContainEqual(entry(2));
    expect(replaced.value.registry.credentials).toHaveLength(2);
  });

  it("creates an all-new registry atomically for total registry loss", async () => {
    const replacement = await replaceEntireRegistry(
      [
        WRITER_METADATA,
        { name: "Read client", permissions: [CLIENT_PERMISSION.read] },
      ],
      deterministicGeneration(10),
    );

    expect(replacement.kind).toBe("success");
    if (replacement.kind !== "success") return;
    expect(replacement.value.registry.credentials).toHaveLength(2);
    expect(replacement.value.credentials).toHaveLength(2);
    for (const generated of replacement.value.credentials) {
      expect(
        serializeCredentialRegistry(replacement.value.registry),
      ).not.toContain(generated.token);
    }
  });

  it("refuses duplicate replacement metadata without returning a partial registry", async () => {
    await expect(
      replaceEntireRegistry(
        [WRITER_METADATA, WRITER_METADATA],
        deterministicGeneration(10),
      ),
    ).resolves.toEqual({
      kind: "failure",
      reason: CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry,
    });
  });
});

describe("credential lifecycle CLI boundaries", () => {
  it("rejects raw-token arguments without echoing their value", () => {
    const secret = "must-not-be-echoed";
    const result = runCli([
      "revoke",
      "--registry",
      join(tmpdir(), "credential-cli-registry.json"),
      "--client-id",
      "00000000-0000-4000-8000-000000000001",
      "--token",
      secret,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported option --token");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("rejects repository registry paths even when invoked from a subdirectory", () => {
    const repositoryRoot = process.cwd();
    const registryPath = join(
      repositoryRoot,
      "credential-registry-forbidden.json",
    );
    const result = runCli(
      [
        "revoke",
        "--registry",
        registryPath,
        "--client-id",
        "00000000-0000-4000-8000-000000000001",
      ],
      join(repositoryRoot, "tools"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Credential registries must be stored outside the repository",
    );
    expect(existsSync(registryPath)).toBe(false);
  });

  it("rejects outside paths whose canonical parent resolves into the repository", () => {
    const linkPath = join(
      tmpdir(),
      `credential-cli-link-${crypto.randomUUID()}`,
    );
    symlinkSync(process.cwd(), linkPath, "dir");

    try {
      const result = runCli([
        "revoke",
        "--registry",
        join(linkPath, "credential-registry-forbidden.json"),
        "--client-id",
        "00000000-0000-4000-8000-000000000001",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Credential registries must be stored outside the repository",
      );
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  it("refuses non-interactive raw-token display before creating a registry file", () => {
    const registryPath = join(
      tmpdir(),
      `credential-cli-${crypto.randomUUID()}.json`,
    );
    const result = runCli([
      "create",
      "--registry",
      registryPath,
      "--name",
      "Writer",
      "--permissions",
      "read,write,delete",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Raw-token display requires an interactive terminal",
    );
    expect(existsSync(registryPath)).toBe(false);
    rmSync(registryPath, { force: true });
  });
});

/**
 * Runs the offline CLI through the pinned mise/Bun toolchain with captured non-interactive output.
 *
 * @param arguments_ - Credential CLI arguments.
 * @param workingDirectory - Caller-controlled invocation directory.
 * @returns Sanitized process result for boundary assertions.
 */
function runCli(
  arguments_: readonly string[],
  workingDirectory = process.cwd(),
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const scriptPath = join(process.cwd(), "tools/credentials/cli.ts");
  const result = spawnSync(
    "mise",
    ["exec", "--", "bun", scriptPath, ...arguments_],
    { cwd: workingDirectory, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
