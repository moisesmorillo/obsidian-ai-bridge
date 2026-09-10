import {
  MAX_NOTE_SIZE_BYTES,
  encodeNotePath,
  normalizeNotePath,
  type NotePath,
  type VaultRepository,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";
import { handleRequest } from "./index";

class InMemoryVaultRepository implements VaultRepository {
  private readonly notes = new Map<string, string>();

  list(): Promise<readonly NotePath[]> {
    return Promise.resolve(
      [...this.notes.keys()].map((path) => normalizeNotePath(path) as NotePath),
    );
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

const token = "secret-token";

function noteRoute(path: string): string {
  const normalizedPath = normalizeNotePath(path);
  if (normalizedPath === undefined) {
    throw new Error(`Invalid test path: ${path}`);
  }

  return `/api/v1/notes/${encodeNotePath(normalizedPath)}`;
}

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string;
    authorization?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set("Authorization", options.authorization);
  }
  if (options.contentType !== undefined) {
    headers.set("Content-Type", options.contentType);
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

function handler(repository: VaultRepository): Promise<Response> {
  return handleRequest(makeRequest("/health"), {
    repository,
    token,
    logger: () => undefined,
  });
}

async function request(
  repository: VaultRepository,
  path: string,
  options: {
    method?: string;
    body?: string;
    contentType?: string;
    authorization?: string;
  } = {},
): Promise<Response> {
  return handleRequest(makeRequest(path, options), {
    repository,
    token,
    logger: () => undefined,
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("Worker API", () => {
  it("returns an unauthenticated health response", async () => {
    const response = await handler(new InMemoryVaultRepository());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
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
    expect(await putResponse.json()).toEqual({
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
    expect(await response.json()).toEqual({ notes: ["Alpha.md", "Zeta.md"] });
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

  it("returns 404 for a missing note", async () => {
    const response = await request(
      new InMemoryVaultRepository(),
      noteRoute("Missing.md"),
      {
        authorization: "Bearer secret-token",
      },
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });
});
