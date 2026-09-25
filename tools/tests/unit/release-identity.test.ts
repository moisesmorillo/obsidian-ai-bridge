import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const RELEASE_CHECK = fileURLToPath(
  new URL("../../release-identity/check.mjs", import.meta.url),
);
const VERSION = "1.0.1";
const temporaryRoots: string[] = [];

describe("release identity check", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts one synchronized product including the Bun lock workspace", () => {
    const root = createFixture();

    const result = runCheck(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Release identity is synchronized at ${VERSION}.`,
    );
    expect(result.stderr).toBe("");
  });

  it("reports source, lockfile, staged, and release-manifest drift", () => {
    const root = createFixture();
    writeJson(root, "apps/obsidian-plugin/package.json", {
      name: "@obsidian-ai-bridge/obsidian-plugin",
      version: "0.1.0",
    });
    writeJson(root, "apps/obsidian-plugin/manifest.json", { version: "0.1.0" });
    writeJson(root, "apps/obsidian-plugin/dist/manifest.json", {
      version: "0.1.0",
    });
    writeJson(root, ".release-please-manifest.json", { ".": "0.1.0" });
    writeFileSync(
      join(root, "bun.lock"),
      '{"workspaces":{"apps/obsidian-plugin":{"version":"0.1.0",},},}',
    );

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/obsidian-plugin/package.json");
    expect(result.stderr).toContain("apps/obsidian-plugin/manifest.json");
    expect(result.stderr).toContain("apps/obsidian-plugin/dist/manifest.json");
    expect(result.stderr).toContain(".release-please-manifest.json");
    expect(result.stderr).toContain("bun.lock");
  });

  it("requires explicit Release Please updates for both plugin version files", () => {
    const root = createFixture();
    const config = {
      "release-type": "simple",
      "include-component-in-tag": false,
      "extra-files": [
        {
          type: "json",
          path: "package.json",
          jsonpath: "$.version",
        },
      ],
      packages: { ".": { "package-name": "obsidian-ai-bridge" } },
    };
    writeJson(root, "release-please-config.json", config);

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release-please-config.json must update apps/obsidian-plugin/package.json at $.version",
    );
    expect(result.stderr).toContain(
      "release-please-config.json must update apps/obsidian-plugin/manifest.json at $.version",
    );
  });
});

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "release-identity-check-"));
  temporaryRoots.push(root);
  for (const directory of [
    "apps/obsidian-plugin/dist",
    "apps/obsidian-plugin",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeJson(root, "package.json", {
    name: "obsidian-ai-bridge",
    version: VERSION,
  });
  writeJson(root, ".release-please-manifest.json", { ".": VERSION });
  writeJson(root, "apps/obsidian-plugin/package.json", {
    name: "@obsidian-ai-bridge/obsidian-plugin",
    version: VERSION,
  });
  writeJson(root, "apps/obsidian-plugin/manifest.json", { version: VERSION });
  writeJson(root, "apps/obsidian-plugin/dist/manifest.json", {
    version: VERSION,
  });
  writeJson(root, "release-please-config.json", {
    "release-type": "simple",
    "include-component-in-tag": false,
    "extra-files": [
      { type: "json", path: "package.json", jsonpath: "$.version" },
      {
        type: "json",
        path: "apps/obsidian-plugin/package.json",
        jsonpath: "$.version",
      },
      {
        type: "json",
        path: "apps/obsidian-plugin/manifest.json",
        jsonpath: "$.version",
      },
    ],
    packages: { ".": { "package-name": "obsidian-ai-bridge" } },
  });
  writeFileSync(
    join(root, "bun.lock"),
    `{
      "ignored": "literal,}",
      "workspaces": {
        "apps/obsidian-plugin": { "version": "${VERSION}", },
      },
    }`,
  );
  return root;
}

function writeJson(root: string, path: string, value: object): void {
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [RELEASE_CHECK, "--root", resolve(root)], {
    encoding: "utf8",
  });
}
