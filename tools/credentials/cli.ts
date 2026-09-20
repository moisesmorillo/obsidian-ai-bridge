import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CredentialRegistry } from "@worker/auth/auth.types";
import {
  decodeCredentialRegistry,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import {
  type CredentialLifecycleResult,
  createCredential,
  createEmptyCredentialRegistry,
  type GeneratedCredential,
  type NewCredentialMetadata,
  type RegistryReplacement,
  replaceEntireRegistry,
  replaceLostCredential,
  revokeCredential,
  rotateCredential,
} from "#tools/credentials/credential-lifecycle";

/** Repository root derived from the tool location rather than caller-controlled cwd. */
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Closed command contract accepted by the offline credential lifecycle CLI. */
type CredentialCommand =
  | {
      readonly kind: "create";
      readonly registryPath: string;
      readonly metadata: NewCredentialMetadata;
    }
  | {
      readonly kind: "rotate";
      readonly registryPath: string;
      readonly clientId: string;
      readonly metadata: NewCredentialMetadata;
    }
  | {
      readonly kind: "revoke";
      readonly registryPath: string;
      readonly clientId: string;
    }
  | {
      readonly kind: "replace-lost";
      readonly registryPath: string;
      readonly clientId: string;
      readonly metadata: NewCredentialMetadata;
    }
  | {
      readonly kind: "replace-registry";
      readonly registryPath: string;
      readonly clients: readonly NewCredentialMetadata[];
    };

/** Parsed option bags preserve repeated total-replacement client declarations. */
interface ParsedOptions {
  /** Single-value options keyed by their long flag. */
  readonly values: ReadonlyMap<string, string>;
  /** Repeated `--client` values used only by total replacement. */
  readonly clients: readonly string[];
}

/** Sanitized command failure safe for operator display. */
class CredentialCliError extends Error {
  /**
   * @param message - Operator-safe failure without raw token or verifier material.
   */
  constructor(message: string) {
    super(message);
    this.name = "CredentialCliError";
  }
}

/**
 * Runs one offline lifecycle command without making network or deployment calls.
 *
 * @param arguments_ - Command arguments excluding runtime and script names.
 */
async function main(arguments_: readonly string[]): Promise<void> {
  const command = parseCommand(arguments_);
  await assertRegistryPathOutsideRepository(command.registryPath);

  switch (command.kind) {
    case "create": {
      assertInteractiveSecretOutput();
      const registry = await readRegistry(command.registryPath, true);
      const created = await createCredential(registry, command.metadata);
      await commitGeneratedCredential(command.registryPath, created);
      return;
    }
    case "rotate": {
      assertInteractiveSecretOutput();
      const registry = await readRegistry(command.registryPath, false);
      const rotated = await rotateCredential(
        registry,
        command.clientId,
        command.metadata,
      );
      await commitGeneratedCredential(command.registryPath, rotated);
      return;
    }
    case "revoke": {
      const registry = await readRegistry(command.registryPath, false);
      const revoked = revokeCredential(registry, command.clientId);
      const replacement = requireSuccess(revoked);
      await writeRegistry(command.registryPath, replacement);
      process.stdout.write(`Revoked client ${command.clientId}.\n`);
      return;
    }
    case "replace-lost": {
      assertInteractiveSecretOutput();
      const registry = await readRegistry(command.registryPath, false);
      const replaced = await replaceLostCredential(
        registry,
        command.clientId,
        command.metadata,
      );
      await commitGeneratedCredential(command.registryPath, replaced);
      return;
    }
    case "replace-registry": {
      assertInteractiveSecretOutput();
      const replacement = await replaceEntireRegistry(command.clients);
      await commitRegistryReplacement(command.registryPath, replacement);
      return;
    }
  }
}

/**
 * Parses bounded command metadata and rejects unknown, duplicate, or missing options.
 *
 * @param arguments_ - CLI arguments excluding runtime and script names.
 * @returns Closed lifecycle command.
 */
function parseCommand(arguments_: readonly string[]): CredentialCommand {
  const [kind, ...optionArguments] = arguments_;
  if (
    kind !== "create" &&
    kind !== "rotate" &&
    kind !== "revoke" &&
    kind !== "replace-lost" &&
    kind !== "replace-registry"
  ) {
    throw new CredentialCliError(usage());
  }

  const options = parseOptions(optionArguments);
  const registryPath = requiredOption(options, "--registry");
  if (kind === "revoke") {
    assertOnlyOptions(options, ["--registry", "--client-id"]);
    return {
      kind,
      registryPath,
      clientId: requiredOption(options, "--client-id"),
    };
  }
  if (kind === "replace-registry") {
    assertOnlyOptions(options, ["--registry", "--client"]);
    if (options.clients.length === 0) {
      throw new CredentialCliError(
        "Total replacement requires at least one --client declaration.",
      );
    }
    return {
      kind,
      registryPath,
      clients: options.clients.map(parseClientDeclaration),
    };
  }

  const metadata = parseMetadata(options);
  if (kind === "create") {
    assertOnlyOptions(options, ["--registry", "--name", "--permissions"]);
    return { kind, registryPath, metadata };
  }

  assertOnlyOptions(options, [
    "--registry",
    "--client-id",
    "--name",
    "--permissions",
  ]);
  return {
    kind,
    registryPath,
    clientId: requiredOption(options, "--client-id"),
    metadata,
  };
}

/**
 * Parses long options while retaining repeated client declarations.
 *
 * @param arguments_ - Alternating `--flag value` arguments.
 * @returns Parsed single-value and repeated options.
 */
function parseOptions(arguments_: readonly string[]): ParsedOptions {
  if (arguments_.length % 2 !== 0) {
    throw new CredentialCliError("Every option requires one value.");
  }

  const values = new Map<string, string>();
  const clients: string[] = [];
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new CredentialCliError("Malformed command options.");
    }
    if (flag === "--client") {
      clients.push(value);
      continue;
    }
    if (values.has(flag)) {
      throw new CredentialCliError(`Duplicate option ${flag}.`);
    }
    values.set(flag, value);
  }

  return { values, clients };
}

/**
 * Restricts each command to its documented option surface.
 *
 * @param options - Parsed options.
 * @param allowed - Exact flags accepted by the selected command.
 */
function assertOnlyOptions(
  options: ParsedOptions,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const flag of options.values.keys()) {
    if (!allowedSet.has(flag)) {
      throw new CredentialCliError(`Unsupported option ${flag}.`);
    }
  }
  if (options.clients.length > 0 && !allowedSet.has("--client")) {
    throw new CredentialCliError(
      "--client is valid only for replace-registry.",
    );
  }
}

/**
 * Reads one required option without interpreting its value.
 *
 * @param options - Parsed command options.
 * @param flag - Required long option name.
 * @returns Nonempty option value.
 */
function requiredOption(options: ParsedOptions, flag: string): string {
  const value = options.values.get(flag);
  if (value === undefined || value === "") {
    throw new CredentialCliError(`Missing required option ${flag}.`);
  }
  return value;
}

/**
 * Parses one name and comma-separated exact permission set.
 *
 * @param options - Parsed command options.
 * @returns Untrusted metadata passed to the shared lifecycle validator.
 */
function parseMetadata(options: ParsedOptions): NewCredentialMetadata {
  return {
    name: requiredOption(options, "--name"),
    permissions: requiredOption(options, "--permissions").split(","),
  };
}

/**
 * Parses `name=permission,permission` for all-new registry reprovisioning.
 *
 * @param declaration - One repeated client declaration.
 * @returns Untrusted metadata passed to the shared lifecycle validator.
 */
function parseClientDeclaration(declaration: string): NewCredentialMetadata {
  const separator = declaration.indexOf("=");
  if (separator <= 0 || separator === declaration.length - 1) {
    throw new CredentialCliError(
      "Client declarations use name=read,write,delete syntax.",
    );
  }
  return {
    name: declaration.slice(0, separator),
    permissions: declaration.slice(separator + 1).split(","),
  };
}

/**
 * Refuses lexical and symlink-resolved verifier locations inside the repository.
 *
 * @param registryPath - Operator-selected confidential registry path.
 */
async function assertRegistryPathOutsideRepository(
  registryPath: string,
): Promise<void> {
  const target = resolve(registryPath);
  const repositoryRoot = await realpath(REPOSITORY_ROOT);
  assertPathOutsideRepository(target, repositoryRoot);

  let existingPath = target;
  let searching = true;
  while (searching) {
    try {
      const canonicalPath = await realpath(existingPath);
      assertPathOutsideRepository(canonicalPath, repositoryRoot);
      searching = false;
    } catch (error) {
      if (!(error instanceof Error) || !isMissingFileError(error)) {
        throw error;
      }
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        throw new CredentialCliError(
          "Credential registry path could not be validated.",
        );
      }
      existingPath = parent;
    }
  }
}

/**
 * Rejects a lexical or canonical path contained by the repository root.
 *
 * @param candidate - Absolute path or resolved existing ancestor.
 * @param repositoryRoot - Canonical repository root.
 */
function assertPathOutsideRepository(
  candidate: string,
  repositoryRoot: string,
): void {
  const fromRepository = relative(repositoryRoot, candidate);
  if (
    fromRepository === "" ||
    (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
  ) {
    throw new CredentialCliError(
      "Credential registries must be stored outside the repository working tree.",
    );
  }
}

/** Refuses secret generation when stdout could silently capture a raw token. */
function assertInteractiveSecretOutput(): void {
  if (process.stdout.isTTY !== true) {
    throw new CredentialCliError(
      "Raw-token display requires an interactive terminal; redirection is refused.",
    );
  }
}

/**
 * Loads and strictly validates one digest-only registry.
 *
 * @param registryPath - Confidential file outside the repository.
 * @param allowMissing - Whether absence means a new empty registry.
 * @returns Complete validated registry.
 */
async function readRegistry(
  registryPath: string,
  allowMissing: boolean,
): Promise<CredentialRegistry> {
  let serialized: string;
  try {
    serialized = await readFile(resolve(registryPath), "utf8");
  } catch (error) {
    if (allowMissing && error instanceof Error && isMissingFileError(error)) {
      return createEmptyCredentialRegistry();
    }
    throw new CredentialCliError("Credential registry could not be read.");
  }

  const decoded = decodeCredentialRegistry(serialized);
  if (decoded.kind !== "valid") {
    throw new CredentialCliError("Credential registry is malformed.");
  }
  return decoded.registry;
}

/**
 * Atomically writes only canonical digest-only registry configuration with owner-only mode.
 *
 * @param registryPath - Confidential output path outside the repository.
 * @param registry - Fully validated replacement registry.
 */
async function writeRegistry(
  registryPath: string,
  registry: CredentialRegistry,
): Promise<void> {
  const target = resolve(registryPath);
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertRegistryPathOutsideRepository(target);
  try {
    await writeFile(temporary, `${serializeCredentialRegistry(registry)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new CredentialCliError("Credential registry replacement failed.");
  }
}

/**
 * Commits a create/rotate/lost-token result before displaying its raw token once.
 *
 * @param registryPath - Confidential registry path.
 * @param result - Lifecycle result containing no partial update on failure.
 */
async function commitGeneratedCredential(
  registryPath: string,
  result: CredentialLifecycleResult<GeneratedCredential>,
): Promise<void> {
  const generated = requireSuccess(result);
  await writeRegistry(registryPath, generated.registry);
  process.stdout.write(
    `Client ID: ${generated.clientId}\nRaw token (displayed once): ${generated.token}\n`,
  );
}

/**
 * Commits a total replacement before displaying each unrelated fresh token once.
 *
 * @param registryPath - Confidential registry path.
 * @param result - Atomic all-new registry result.
 */
async function commitRegistryReplacement(
  registryPath: string,
  result: CredentialLifecycleResult<RegistryReplacement>,
): Promise<void> {
  const replacement = requireSuccess(result);
  await writeRegistry(registryPath, replacement.registry);
  replacement.credentials.forEach((credential) => {
    process.stdout.write(
      `Client: ${credential.name}\nClient ID: ${credential.clientId}\nRaw token (displayed once): ${credential.token}\n`,
    );
  });
}

/**
 * Unwraps a lifecycle success or maps its closed reason to a sanitized CLI failure.
 *
 * @param result - Shared lifecycle result.
 * @returns Successful value.
 */
function requireSuccess<Value>(
  result: CredentialLifecycleResult<Value>,
): Value {
  if (result.kind === "success") {
    return result.value;
  }
  throw new CredentialCliError(
    `Credential operation refused: ${result.reason}.`,
  );
}

/**
 * Recognizes only the platform missing-file code without exposing the raw exception.
 *
 * @param error - Untrusted filesystem exception.
 * @returns Whether the registry file is absent.
 */
function isMissingFileError(error: object): boolean {
  return "code" in error && error.code === "ENOENT";
}

/** @returns Concise offline CLI usage without credential examples. */
function usage(): string {
  return [
    "Usage:",
    "  credentials create --registry <outside-repo-path> --name <name> --permissions <set>",
    "  credentials rotate --registry <path> --client-id <uuid> --name <name> --permissions <set>",
    "  credentials revoke --registry <path> --client-id <uuid>",
    "  credentials replace-lost --registry <path> --client-id <uuid> --name <name> --permissions <set>",
    "  credentials replace-registry --registry <path> --client <name=permission,...> [--client ...]",
  ].join("\n");
}

main(process.argv.slice(2)).catch((error: object) => {
  const message =
    error instanceof CredentialCliError
      ? error.message
      : "Credential operation failed closed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
