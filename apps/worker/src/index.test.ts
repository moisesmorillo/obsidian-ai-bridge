import type { NotePath, VaultRepository } from "@obsidian-ai-bridge/core";
import {
  encodeNotePath,
  MAX_NOTE_SIZE_BYTES,
  normalizeNotePath,
  VaultNoteService,
} from "@obsidian-ai-bridge/core";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  noteListResponseSchema,
  noteWriteResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { createWorkerApp } from "@worker/app";
import type { Logger } from "@worker/logging/logger.types";
import { describe, expect, it } from "vitest";

class InMemoryVaultRepository implements VaultRepository {
  private readonly notes = new Map<NotePath, string>();

  list(): Promise<readonly NotePath[]> {
    return Promise.resolve([...this.notes.keys()]);
  }

  exists(path: NotePath): Promise<boolean> {
    return Promise.resolve(this.notes.has(path));
  }

  read(path: NotePath): Promise<string | null> {
    return Promise.resolve(this.notes.get(path) ?? null);
  }

  write(path: NotePath, content: string): Promise<void> {
    this.notes.set(path, content);
    return Promise.resolve();
  }

  delete(path: NotePath): Promise<void> {
    this.notes.delete(path);
    return Promise.resolve();
  }
}

class TestLogger implements Logger {
  readonly entries: Parameters<Logger["info"]>[] = [];

  info(entry: Parameters<Logger["info"]>[0]): void {
    this.entries.push([entry]);
  }
}

const TOKEN = "secret-token";

function normalizedPath(path: string): NotePath {
  const normalized = normalizeNotePath(path);
  if (normalized === undefined) {
    throw new Error(`Invalid test path: ${path}`);
  }

  return normalized;
}

function noteRoute(path: string): string {
  return `/api/v1/notes/${encodeNotePath(normalizedPath(path))}`;
}

function makeRequest(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: BodyInit;
    readonly contentType?: string;
    readonly authorization?: string;
    readonly contentLength?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set("Authorization", options.authorization);
  }
  if (options.contentType !== undefined) {
    headers.set("Content-Type", options.contentType);
  }
  if (options.contentLength !== undefined) {
    headers.set("Content-Length", options.contentLength);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) {
    init.body = options.body;
  }

  return new Request(`https://example.test${path}`, init);
}

function app(repository: VaultRepository, logger = new TestLogger()) {
  return {
    application: createWorkerApp({
      logger,
      resolveNoteService: () => new VaultNoteService(repository),
      resolveToken: () => TOKEN,
    }),
    logger,
  };
}

async function request(
  repository: VaultRepository,
  path: string,
  options: Parameters<typeof makeRequest>[1] = {},
): Promise<Response> {
  return app(repository).application.fetch(makeRequest(path, options));
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("Worker API", () => {
  it("returns an unauthenticated health response", async () => {
    const response = await app(new InMemoryVaultRepository()).application.fetch(
      makeRequest("/health"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
    });
  });

  it("creates and reads a note", async () => {
    const repository = new InMemoryVaultRepository();
    const path = noteRoute("Homelab/DNS/Technitium.md");

    const putResponse = await request(repository, path, {
      method: "PUT",
      body: "# Technitium",
      contentType: "text/markdown; charset=utf-8",
      authorization: "Bearer secret-token",
    });
    expect(putResponse.status).toBe(201);
    expect(noteWriteResponseSchema.parse(await putResponse.json())).toEqual({
      path: "Homelab/DNS/Technitium.md",
      stored: true,
    });

    const getResponse = await request(repository, path, {
      authorization: "Bearer secret-token",
    });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await getResponse.text()).toBe("# Technitium");
  });

  it("returns 200 when replacing an existing note", async () => {
    const repository = new InMemoryVaultRepository();
    const path = noteRoute("Career/Applications/Company.md");
    const options = {
      method: "PUT",
      contentType: "text/plain",
      authorization: "Bearer secret-token",
    };

    expect(
      await request(repository, path, { ...options, body: "first" }),
    ).toHaveProperty("status", 201);
    expect(
      await request(repository, path, { ...options, body: "second" }),
    ).toHaveProperty("status", 200);
  });

  it("lists stored note paths without the vault prefix", async () => {
    const repository = new InMemoryVaultRepository();
    await request(repository, noteRoute("Zeta.md"), {
      method: "PUT",
      body: "zeta",
      authorization: "Bearer secret-token",
    });
    await request(repository, noteRoute("Alpha.md"), {
      method: "PUT",
      body: "alpha",
      authorization: "Bearer secret-token",
    });

    const response = await request(repository, "/api/v1/notes", {
      authorization: "Bearer secret-token",
    });
    expect(response.status).toBe(200);
    expect(noteListResponseSchema.parse(await response.json())).toEqual({
      notes: ["Alpha.md", "Zeta.md"],
    });
  });

  it("deletes notes idempotently", async () => {
    const repository = new InMemoryVaultRepository();
    const path = noteRoute("Alpha.md");

    await request(repository, path, {
      method: "PUT",
      body: "alpha",
      authorization: "Bearer secret-token",
    });
    expect(
      await request(repository, path, {
        method: "DELETE",
        authorization: "Bearer secret-token",
      }),
    ).toHaveProperty("status", 204);
    expect(
      await request(repository, path, {
        method: "DELETE",
        authorization: "Bearer secret-token",
      }),
    ).toHaveProperty("status", 204);
  });

  it("rejects unauthorized API requests", async () => {
    const repository = new InMemoryVaultRepository();

    const missing = await request(repository, "/api/v1/notes");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await errorCode(missing)).toBe("unauthorized");

    const invalid = await request(repository, "/api/v1/notes", {
      authorization: "Bearer wrong-token",
    });
    expect(invalid.status).toBe(401);
    expect(await errorCode(invalid)).toBe("unauthorized");
  });

  it("rejects invalid note paths", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      "/api/v1/notes/Li4vc2VjcmV0Lm1k",
      { authorization: "Bearer secret-token" },
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_path");
  });

  it("rejects hierarchical paths instead of treating them as note identifiers", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      "/api/v1/notes/Homelab/DNS/Technitium.md",
      { authorization: "Bearer secret-token" },
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_path");
  });

  it("rejects malformed note identifiers", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      "/api/v1/notes/not-base64!",
      { authorization: "Bearer secret-token" },
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_path");
  });

  it("returns 404 for unsupported methods on a valid note identifier", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Alpha.md"),
      {
        method: "POST",
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("rejects unsupported media types", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Alpha.md"),
      {
        method: "PUT",
        body: "{}",
        contentType: "application/json",
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(415);
    expect(await errorCode(response)).toBe("unsupported_media_type");
  });

  it("rejects oversized note payloads", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Alpha.md"),
      {
        method: "PUT",
        body: "a".repeat(MAX_NOTE_SIZE_BYTES + 1),
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
  });

  it("rejects a declared oversized payload before reading it", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Alpha.md"),
      {
        method: "PUT",
        body: "small",
        contentLength: String(MAX_NOTE_SIZE_BYTES + 1),
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("payload_too_large");
  });

  it("rejects malformed UTF-8 payloads", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Alpha.md"),
      {
        method: "PUT",
        body: new Uint8Array([0xc3, 0x28]),
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_body");
  });

  it("returns 404 for a missing note", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Missing.md"),
      { authorization: "Bearer secret-token" },
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("sanitizes unexpected repository failures", async () => {
    const repository: VaultRepository = {
      list: async () => [],
      exists: async () => false,
      read: async () => {
        throw new Error("storage credential details");
      },
      write: async () => undefined,
      delete: async () => undefined,
    };

    const response = await request(repository, noteRoute("Alpha.md"), {
      authorization: "Bearer secret-token",
    });

    expect(response.status).toBe(500);
    const responseBody = await response.text();
    expect(
      apiErrorResponseSchema.parse(JSON.parse(responseBody)).error.code,
    ).toBe("internal_error");
    expect(responseBody).not.toContain("storage credential details");
  });

  it("exposes the generated OpenAPI document and Scalar reference", async () => {
    const { application } = app(new InMemoryVaultRepository());

    const document = await application.fetch(makeRequest("/openapi.json"));
    const reference = await application.fetch(makeRequest("/docs"));

    expect(document.status).toBe(200);
    expect(await document.text()).toContain("/api/v1/notes/{path}");
    expect(reference.status).toBe(200);
    expect(reference.headers.get("Content-Type")).toContain("text/html");
    expect(await reference.text()).toContain("scalar");
  });

  it("logs request metadata without credentials or note content", async () => {
    const logger = new TestLogger();
    const { application } = app(new InMemoryVaultRepository(), logger);

    await application.fetch(
      makeRequest(noteRoute("Alpha.md"), {
        method: "PUT",
        body: "sensitive note content",
        authorization: "Bearer secret-token",
      }),
    );

    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.[0]).toMatchObject({
      operation: "http_request",
      method: "PUT",
      route: "/api/v1/notes/:path",
      status: 201,
    });
    expect(JSON.stringify(logger.entries)).not.toContain("secret-token");
    expect(JSON.stringify(logger.entries)).not.toContain(
      "sensitive note content",
    );
  });
});
