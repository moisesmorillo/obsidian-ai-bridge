import { MAX_NOTE_SIZE_BYTES } from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  apiErrorResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { LOG_OPERATION_CATEGORY } from "@worker/logging/logging.constants";
import {
  MCP_ENDPOINT_PATH,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_STREAM_CHUNKS,
  MCP_PROTOCOL_VERSION,
} from "@worker/mcp/mcp.constants";
import {
  createMcpTestWorker,
  HOSTILE_NOTE_TEXT,
  MCP_TEST_NOTE_PATH,
  seedMcpNote,
} from "@worker-tests/support/mcp-test-kit";
import { describe, expect, it } from "vitest";

const LEGACY_PROTOCOL_VERSION = "2025-11-25";

describe("Worker MCP authentication and data-safety boundary", () => {
  it("rejects missing and invalid bearers before resolving mirror services", async () => {
    const worker = await createMcpTestWorker();

    const missing = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "server/discover",
        },
        body: "{}",
      }),
    );
    const invalid = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid-mcp-token",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "server/discover",
        },
        body: "{}",
      }),
    );

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await missing.json()).error.code).toBe(
      API_ERROR_CODE.unauthorized,
    );
    expect(JSON.stringify(await invalid.json())).not.toContain(
      "invalid-mcp-token",
    );
    expect(worker.resolverCount()).toBe(0);
  });

  it("rejects initialize-era protocol traffic without creating an MCP session", async () => {
    const worker = await createMcpTestWorker();
    const response = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "legacy-test-client", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(response.status).not.toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(worker.resolverCount()).toBe(0);
  });

  it("returns bounded JSON for disabled subscription requests instead of opening SSE", async () => {
    const worker = await createMcpTestWorker();
    const response = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: { notifications: [] },
        }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream",
    );
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.json()).toHaveProperty("error");
    expect(worker.resolverCount()).toBe(0);
  });

  it("rejects cross-origin and malformed-origin requests before application resolution", async () => {
    const worker = await createMcpTestWorker();
    const origins = ["https://attacker.invalid", "null", "https://[invalid"];
    const responses = await Promise.all(
      origins.map((origin) =>
        Promise.resolve(
          worker.app.fetch(
            new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${worker.tokens.full}`,
                Origin: origin,
                "Content-Type": "application/json",
                "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
                "Mcp-Method": "server/discover",
              },
              body: "{}",
            }),
          ),
        ),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(worker.resolverCount()).toBe(0);
  });

  it("uses registry revocation and rotation for every independent MCP request", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);

    await worker.replaceCredentials([]);
    await expect(
      client.callTool({ name: "list_notes", arguments: {} }),
    ).rejects.toThrow();
    expect(worker.resolverCount()).toBe(0);
    await client.close();

    const rotatedToken = "mcp-test-rotated-token";
    await worker.replaceCredentials([
      {
        clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Rotated MCP test",
        token: rotatedToken,
        permissions: ["read", "write", "delete"],
      },
    ]);
    const rotatedClient = await worker.connect(rotatedToken);
    const result = await rotatedClient.callTool({
      name: "list_notes",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    await rotatedClient.close();
  });

  it("limits declared and actual request bytes without dispatching services", async () => {
    const worker = await createMcpTestWorker();
    const declaredOversize = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "application/json",
          "Content-Length": String(MCP_MAX_REQUEST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(declaredOversize.status).toBe(413);
    expect(worker.resolverCount()).toBe(0);

    const actualOversize = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "application/json",
        },
        body: " ".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
      }),
    );
    expect(actualOversize.status).toBe(413);

    let emittedChunks = 0;
    let streamCancelled = false;
    const emptyChunkStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const chunkRequestInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${worker.tokens.full}`,
        "Content-Type": "application/json",
      },
      body: emptyChunkStream,
      duplex: "half",
    };
    const chunkOversize = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, chunkRequestInit),
    );

    expect(chunkOversize.status).toBe(413);
    expect(streamCancelled).toBe(true);
    expect(emittedChunks).toBeGreaterThan(MCP_MAX_STREAM_CHUNKS);
    expect(worker.resolverCount()).toBe(0);
  });

  it("refuses unsupported media, malformed lengths, and failed body reads before dispatch", async () => {
    const worker = await createMcpTestWorker();
    const unsupportedMedia = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "text/plain",
        },
        body: "{}",
      }),
    );
    const malformedLength = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "application/json",
          "Content-Length": "not-a-length",
        },
        body: "{}",
      }),
    );

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private request-body detail"));
      },
    });
    const failedBodyInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${worker.tokens.full}`,
        "Content-Type": "application/json",
      },
      body: failedBody,
      duplex: "half",
    };
    const unreadableBody = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, failedBodyInit),
    );

    expect(unsupportedMedia.status).toBe(415);
    expect(malformedLength.status).toBe(400);
    expect(unreadableBody.status).toBe(400);
    expect(await unreadableBody.text()).not.toContain(
      "private request-body detail",
    );
    expect(worker.resolverCount()).toBe(0);
  });

  it("rejects malformed Unicode and oversized UTF-8 note text before service resolution", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);
    const malformedUnicode = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "\ud800",
        operationId: "60000000-0000-4000-8000-000000000021",
      },
    });
    const oversizedUtf8 = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "é".repeat(Math.floor(MAX_NOTE_SIZE_BYTES / 2) + 1),
        operationId: "60000000-0000-4000-8000-000000000022",
      },
    });

    expect(malformedUnicode.isError).toBe(true);
    expect(oversizedUtf8.isError).toBe(true);
    expect(worker.resolverCount()).toBe(0);
    expect(worker.bucket.putKeys).toHaveLength(0);
    await client.close();
  });

  it("keeps principal attribution and diagnostics content-free when storage fails", async () => {
    const worker = await createMcpTestWorker();
    await seedMcpNote(worker.services(), HOSTILE_NOTE_TEXT, 30);
    worker.bucket.throwOnGet = true;
    const client = await worker.connect(worker.tokens.read);

    const result = await client.callTool({
      name: "list_notes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private storage detail");
    await client.close();

    const log = worker.logger.entries.at(-1);
    expect(log).toMatchObject({
      operationCategory: LOG_OPERATION_CATEGORY.mcpRequest,
      route: MCP_ENDPOINT_PATH,
      clientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const serialized = JSON.stringify(worker.logger.entries);
    expect(serialized).not.toContain(worker.tokens.read);
    expect(serialized).not.toContain(HOSTILE_NOTE_TEXT);
    expect(serialized).not.toContain("MCP/Protocol.md");
    expect(serialized).not.toContain("private storage detail");
    expect(worker.resolverCount()).toBe(1);
    expect(MCP_TEST_NOTE_PATH).toBe("MCP/Protocol.md");
  });

  it("rejects an over-limit declared note body before storage and reports a sanitized tool error", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);

    const response = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.tokens.full}`,
          "Content-Type": "application/json",
          "Content-Length": String(MCP_MAX_REQUEST_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);

    const malformed = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "x".repeat(1024 * 1024 + 1),
        operationId: "60000000-0000-4000-8000-000000000001",
      },
    });
    expect(malformed.isError).toBe(true);
    expect(worker.resolverCount()).toBe(0);
    await client.close();
  });
});
