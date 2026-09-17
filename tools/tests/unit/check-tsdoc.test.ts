import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDocumentation,
  discoverProductionFiles,
} from "#tools/tsdoc/check-tsdoc";
import { runDocumentationCheck } from "#tools/tsdoc/cli";

/** Temporary repositories allocated by a test and removed regardless of its outcome. */
const roots: string[] = [];

/**
 * Creates isolated compiler input with production roots and no ambient library dependency.
 *
 * @returns The temporary repository root, registered for cleanup.
 */
function repository(files: ReadonlyMap<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tsdoc-check-"));
  roots.push(root);
  mkdirSync(join(root, "apps"));
  mkdirSync(join(root, "packages"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noLib: true, target: "esnext" },
      include: ["apps/**/*.ts", "packages/**/*.ts"],
    }),
  );
  for (const [file, text] of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("documentation presence", () => {
  it.each([
    ["function", "function save() {}", "save"],
    ["function", "export async function save() {}", "save"],
    ["function", "function* values() {}", "values"],
    ["class", "class Owner {}", "Owner"],
    ["class", "const Owner = class {};", "Owner"],
    ["class", "const Owner = (class Internal {});", "Owner"],
    ["interface", "interface Port {}", "Port"],
    ["type alias", "type Identity = string;", "Identity"],
    ["enum", "enum Phase { Ready }", "Phase"],
    ["function binding", "const save = () => {};", "save"],
    ["function binding", "const save = function() {};", "save"],
    ["function binding", "const save = function implementation() {};", "save"],
    [
      "function binding",
      "const save = (function implementation() {}) as (() => void);",
      "save",
    ],
    [
      "function binding",
      "const save = (() => {}) satisfies (() => void);",
      "save",
    ],
    ["function binding", "const save = (() => {}) as (() => void);", "save"],
    ["function binding", "const save = <(() => void)>(() => {});", "save"],
  ])("detects and accepts documented %s: %s", (kind, declaration, name) => {
    const root = repository(
      new Map([
        ["apps/example/src/missing.ts", declaration],
        [
          "packages/example/src/documented.ts",
          `/** Persists the exact admitted generation before publication. */\n${declaration}`,
        ],
      ]),
    );
    expect(checkDocumentation(root)).toEqual({
      files: 2,
      diagnostics: [
        { file: "apps/example/src/missing.ts", line: 1, kind, name },
      ],
    });
  });

  it.each([
    "public",
    "protected",
    "private",
    "",
    "static",
    "override",
    "abstract",
  ])("requires separate docs for %s methods", (modifier) => {
    const declaration = `${modifier} save() ${modifier === "abstract" ? ";" : "{}"}`;
    const root = repository(
      new Map([
        [
          "apps/example/src/methods.ts",
          `/** Owns persistence. */\nabstract class Owner {\n${declaration}\n/** Saves one generation. */\n${modifier} documented() ${modifier === "abstract" ? ";" : "{}"}\n}`,
        ],
      ]),
    );
    expect(checkDocumentation(root).diagnostics).toEqual([
      {
        file: "apps/example/src/methods.ts",
        line: 3,
        kind: "method/accessor",
        name: "save",
      },
    ]);
  });

  it("covers constructors, private names, accessors, computed methods, signatures and arrow properties", () => {
    const root = repository(
      new Map([
        [
          "apps/example/src/members.ts",
          `/** Owns a lifecycle. */
class Owner {
  constructor() {}
  #save() {}
  get phase() { return 0; }
  set phase(value: number) {}
  [Symbol.dispose]() {}
  private run = () => {};
  /** Saves privately. */
  #documented() {}
}
/** Outbound capability. */
interface Port { save(): void; }
`,
        ],
      ]),
    );
    expect(
      checkDocumentation(root).diagnostics.map(({ kind, name }) => [
        kind,
        name,
      ]),
    ).toEqual([
      ["constructor", "constructor"],
      ["method/accessor", "#save"],
      ["method/accessor", "phase"],
      ["method/accessor", "phase"],
      ["method/accessor", "[Symbol.dispose]"],
      ["function property", "run"],
      ["method/accessor", "save"],
    ]);
  });

  it("exempts anonymous callbacks, inline object methods and ordinary locals but not named helpers", () => {
    const root = repository(
      new Map([
        [
          "apps/example/src/callbacks.ts",
          `/** Processes a sample. */
function processSample() {
  const value = 1;
  const { length } = [];
  for (const item of []) {}
  [].map(() => value);
  consume({ run() {}, get value() { return 1; } });
  it("example", () => {});
  test("example", () => {});
  describe("example", () => {});
  function helper() {}
  const named = () => {};
}
`,
        ],
      ]),
    );
    expect(
      checkDocumentation(root).diagnostics.map(({ name }) => name),
    ).toEqual(["helper", "named"]);
  });

  it("does not pretend to classify semantic constants, schema factories or data members", () => {
    const root = repository(
      new Map([
        [
          "packages/example/src/manual.ts",
          `const limit = 10;
const schema = z.object({});
/** Port configuration. */
interface Options { limit: number; }
`,
        ],
      ]),
    );
    expect(checkDocumentation(root).diagnostics).toEqual([]);
  });

  it("associates docs before decorators/modifiers, not detached, ordinary or earlier declarations' comments", () => {
    const root = repository(
      new Map([
        [
          "apps/example/src/association.ts",
          `/** Owns lifecycle. */
@decorator
export class Owner {
  /** Saves state. */
  @decorator
  private save() {}
}
/** Orphan. */
;
function missing() {}
/* Ordinary comment. */
function ordinary() {}
/** Earlier docs. */
const value = 1;
function later() {}
/** Interrupted docs. */
// Non-doc last comment.
function interrupted() {}
/** First overload. */
function overloaded(value: string): void;
function overloaded(value: number): void;
/** Implementation contract. */
function overloaded(value: string | number) {}
`,
        ],
      ]),
    );
    expect(
      checkDocumentation(root).diagnostics.map(({ name }) => name),
    ).toEqual(["missing", "ordinary", "later", "interrupted", "overloaded"]);
  });

  it("documents standalone named expressions without requiring docs for anonymous callbacks", () => {
    const root = repository(
      new Map([
        [
          "apps/example/src/expressions.ts",
          `consume(function named() {});
consume(/** Owns callback completion. */ function documented() {});
consume(function() {});
consume(class Named {});
consume(/** Owns inline instance lifecycle. */ class Documented {});`,
        ],
      ]),
    );
    expect(
      checkDocumentation(root).diagnostics.map(({ name }) => name),
    ).toEqual(["named", "Named"]);
  });

  it("checks only presence, leaving empty or misleading prose to semantic review", () => {
    const root = repository(
      new Map([["apps/example/src/presence.ts", "/** */\nfunction save() {}"]]),
    );
    expect(checkDocumentation(root).diagnostics).toEqual([]);
  });

  it("exempts explicit generated headers, but not marker strings or comments after code", () => {
    const root = repository(
      new Map([
        [
          "apps/example/src/generated-file.ts",
          "/** @generated by fixture compiler */\nfunction generated() {}",
        ],
        [
          "apps/example/src/not-generated.ts",
          'const text = "@generated";\n/** @generated */\nfunction checked() {}\nfunction missing() {}',
        ],
      ]),
    );
    expect(
      checkDocumentation(root).diagnostics.map(({ name }) => name),
    ).toEqual(["missing"]);
  });

  it("discovers all workspaces deterministically and excludes non-production trees, ambient declarations and symlinks", () => {
    const paths = [
      "apps/z/src/nested/z.ts",
      "packages/a/src/a.ts",
      "apps/z/src/ambient.d.ts",
      ...[
        "generated",
        "dist",
        "build",
        "out",
        "vendor",
        "node_modules",
        "tests",
        "__tests__",
        "fixtures",
        "__fixtures__",
        ".wrangler",
      ].map((directory) => `apps/z/src/${directory}/excluded.ts`),
      "apps/z/tests/unit/excluded.ts",
      "apps/no-source/README.md",
      "fixtures/link-target/src/excluded.ts",
    ];
    const root = repository(
      new Map(paths.map((path) => [path, "function missing() {}\n"])),
    );
    symlinkSync(
      join(root, "packages/a/src/a.ts"),
      join(root, "apps/z/src/link.ts"),
    );
    mkdirSync(join(root, "apps/linked"));
    symlinkSync(
      join(root, "fixtures/link-target/src"),
      join(root, "apps/linked/src"),
    );
    symlinkSync(
      join(root, "fixtures/link-target"),
      join(root, "apps/linked-workspace"),
    );
    expect(discoverProductionFiles(root)).toEqual([
      join(root, "apps/z/src/nested/z.ts"),
      join(root, "packages/a/src/a.ts"),
    ]);
    expect(
      checkDocumentation(root).diagnostics.map(({ file }) => file),
    ).toEqual(["apps/z/src/nested/z.ts", "packages/a/src/a.ts"]);
  });

  it("fails loudly when discovered production files are missing from the compiler project", () => {
    const root = repository(
      new Map([["apps/example/src/source.ts", "function missing() {}"]]),
    );
    writeFileSync(join(root, "tsconfig.json"), '{"files":[]}');
    expect(() => checkDocumentation(root)).toThrow(
      "Documentation check could not parse",
    );
  });

  it.each([
    ["function missing() {}", 1],
    ["/** Preserves generation identity. */\nfunction documented() {}", 0],
  ])(
    "reports diagnostics and a meaningful exit code for %s",
    (source, expectedCode) => {
      const root = repository(
        new Map([["apps/example/src/source.ts", source]]),
      );
      const output = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const errors = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      expect(runDocumentationCheck(root)).toBe(expectedCode);
      expect(output).toHaveBeenCalledExactlyOnceWith(
        `TSDoc presence: ${expectedCode} violations across 1 production files.\n`,
      );
      expect(errors.mock.calls.map(([message]) => message)).toEqual(
        expectedCode === 1
          ? [
              "apps/example/src/source.ts:1: missing TSDoc for function missing\n",
            ]
          : [],
      );
    },
  );

  it("exits nonzero with deterministic file/line/kind/name diagnostics and zero for a clean tree", () => {
    const cli = resolve(import.meta.dirname, "../../tsdoc/cli.ts");
    const invalid = repository(
      new Map([["apps/example/src/source.ts", "\nfunction missing() {}"]]),
    );
    const failed = spawnSync(process.execPath, [cli], {
      cwd: invalid,
      encoding: "utf8",
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe(
      "apps/example/src/source.ts:2: missing TSDoc for function missing\n",
    );
    const valid = repository(
      new Map([
        [
          "apps/example/src/source.ts",
          "/** Preserves generation identity. */\nfunction documented() {}",
        ],
      ]),
    );
    expect(
      execFileSync(process.execPath, [cli], { cwd: valid, encoding: "utf8" }),
    ).toBe("TSDoc presence: 0 violations across 1 production files.\n");
  });
});
