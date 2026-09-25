import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root resolved from the checker's location, not the caller's directory. */
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Stable semantic version grammar used for every release identity field. */
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
/** Root, plugin, lockfile, and staged version sources compared by the gate. */
const VERSION_SOURCES = [
  {
    path: "package.json",
    field: "version",
    releasePleaseJsonPath: "$.version",
    select: (document) => property(document, "version"),
  },
  {
    path: ".release-please-manifest.json",
    field: '"."',
    select: (document) => property(document, "."),
  },
  {
    path: "apps/obsidian-plugin/package.json",
    field: "version",
    releasePleaseJsonPath: "$.version",
    select: (document) => property(document, "version"),
  },
  {
    path: "apps/obsidian-plugin/manifest.json",
    field: "version",
    releasePleaseJsonPath: "$.version",
    select: (document) => property(document, "version"),
  },
  {
    path: "bun.lock",
    field: 'workspaces["apps/obsidian-plugin"].version',
    select: (document) =>
      property(
        property(property(document, "workspaces"), "apps/obsidian-plugin"),
        "version",
      ),
  },
  {
    path: "apps/obsidian-plugin/dist/manifest.json",
    field: "version",
    select: (document) => property(document, "version"),
  },
];

/**
 * Checks that the single-product Release Please configuration and staged Obsidian
 * artifact all identify the same semantic version.
 *
 * @param repositoryRoot - Repository root to inspect, used by the canonical task and fixtures.
 * @returns Diagnostics explaining each missing or inconsistent release identity.
 */
export function checkReleaseIdentity(repositoryRoot) {
  const diagnostics = [];
  const documents = new Map();

  for (const source of VERSION_SOURCES) {
    const document = readDocument(
      repositoryRoot,
      source.path,
      diagnostics,
      source.path === "bun.lock",
    );
    documents.set(source.path, document);
  }
  const releasePleaseConfig = readDocument(
    repositoryRoot,
    "release-please-config.json",
    diagnostics,
  );
  checkReleasePleaseConfiguration(releasePleaseConfig, diagnostics);

  const versions = VERSION_SOURCES.map((source) => {
    const document = documents.get(source.path);
    if (document === undefined) return null;
    const version = source.select(document);
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
      diagnostics.push(
        `${source.path} must provide a semantic version at ${source.field}.`,
      );
      return null;
    }
    return { path: source.path, version };
  });
  const canonicalVersion = versions[0]?.version;
  if (canonicalVersion !== null && canonicalVersion !== undefined) {
    for (const version of versions) {
      if (version !== null && version.version !== canonicalVersion) {
        diagnostics.push(
          `${version.path} reports ${version.version}; expected ${canonicalVersion} from package.json.`,
        );
      }
    }
  }

  return {
    diagnostics,
    version: canonicalVersion ?? null,
  };
}

/**
 * Reads and parses one JSON document, optionally accepting Bun lockfile trailing commas.
 *
 * @param repositoryRoot - Repository root containing the document.
 * @param path - Repository-relative document path.
 * @param diagnostics - Shared errors accumulated by the identity check.
 * @param allowTrailingCommas - Whether to normalize Bun's generated lockfile syntax.
 * @returns Parsed JSON data or undefined when reading or parsing fails.
 */
function readDocument(
  repositoryRoot,
  path,
  diagnostics,
  allowTrailingCommas = false,
) {
  try {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    return JSON.parse(
      allowTrailingCommas ? stripTrailingCommas(source) : source,
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unreadable document";
    diagnostics.push(`${path} could not be read as JSON: ${reason}`);
    return undefined;
  }
}

/**
 * Removes only syntactic trailing commas outside JSON strings before strict parsing.
 *
 * @param source - Bun-generated lockfile text.
 * @returns JSON text with object/array trailing commas removed.
 */
function stripTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(source[nextIndex] ?? "")) nextIndex += 1;
      if (source[nextIndex] === "}" || source[nextIndex] === "]") continue;
    }
    output += character;
  }

  return output;
}

/**
 * Returns an own property from a parsed JSON object without following its prototype.
 *
 * @param value - Parsed JSON value to inspect.
 * @param key - Property name to select.
 * @returns The property's value, or undefined for non-objects and absent fields.
 */
function property(value, key) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Ensures Release Please remains a single root product with explicit version extra-files.
 *
 * @param config - Parsed Release Please configuration.
 * @param diagnostics - Shared errors accumulated by the identity check.
 */
function checkReleasePleaseConfiguration(config, diagnostics) {
  if (
    property(config, "release-type") !== "simple" ||
    property(config, "include-component-in-tag") !== false
  ) {
    diagnostics.push(
      "release-please-config.json must retain one simple product without component tags.",
    );
  }

  const packages = property(config, "packages");
  if (
    typeof packages !== "object" ||
    packages === null ||
    Array.isArray(packages) ||
    Object.keys(packages).length !== 1 ||
    !Object.hasOwn(packages, ".")
  ) {
    diagnostics.push(
      "release-please-config.json must define only the root product.",
    );
  }

  const extraFiles = property(config, "extra-files");
  const requiredExtraFiles = VERSION_SOURCES.filter(
    (source) => source.releasePleaseJsonPath !== undefined,
  );
  for (const required of requiredExtraFiles) {
    const configured =
      Array.isArray(extraFiles) &&
      extraFiles.some(
        (entry) =>
          property(entry, "type") === "json" &&
          property(entry, "path") === required.path &&
          property(entry, "jsonpath") === required.releasePleaseJsonPath,
      );
    if (!configured) {
      diagnostics.push(
        `release-please-config.json must update ${required.path} at ${required.releasePleaseJsonPath}.`,
      );
    }
  }
}

/**
 * Runs the identity check from the canonical task or a temporary test fixture.
 *
 * @param arguments_ - Optional `--root <path>` fixture selector.
 * @returns Process status code.
 */
function main(arguments_) {
  let repositoryRoot = REPOSITORY_ROOT;
  if (arguments_.length > 0) {
    if (arguments_.length !== 2 || arguments_[0] !== "--root") {
      process.stderr.write("Usage: check.mjs [--root <repository-root>]\n");
      return 2;
    }
    repositoryRoot = resolve(arguments_[1]);
  }

  const result = checkReleaseIdentity(repositoryRoot);
  if (result.diagnostics.length > 0) {
    process.stderr.write(
      `Release identity check failed:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Release identity is synchronized at ${result.version}.\n`,
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
