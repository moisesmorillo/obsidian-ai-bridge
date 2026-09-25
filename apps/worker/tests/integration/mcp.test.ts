import {
  createRecoverySnapshotId,
  encodeNotePath,
  isNormalizedNotePath,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@obsidian-ai-bridge/core";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import {
  MCP_ENDPOINT_PATH,
  MCP_OPERATION_PERMISSION,
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_FAILURE,
  MCP_TOOL_FAILURE_MESSAGE,
} from "@worker/mcp/mcp.constants";
import {
  createMcpTestWorker,
  expectMcpNoteState,
  HOSTILE_NOTE_TEXT,
  MCP_TEST_NOTE_PATH,
  seedMcpNote,
  seedMcpRecovery,
} from "@worker-tests/support/mcp-test-kit";
import { createTestMirrorServices } from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const MCP_NOTE_RESOURCE_URI = `obsidian-ai-bridge://note/${encodeNotePath(
  MCP_TEST_NOTE_PATH,
)}`;

const MCP_RECOVERY_ID = "30000000-0000-4000-8000-000000000021";

const structuredStringSchema = z.looseObject({
  recoveryId: z.string().optional(),
  revision: z.string().optional(),
  recoveryRevision: z.string().optional(),
  recoverUntil: z.string().nullable().optional(),
});

/** Reads a validated string field from an official SDK structured tool result.
 *
 * @param value - SDK tool result whose structured content is validated below.
 * @param property - Exact fixture field required by the test.
 * @returns The requested string field.
 * @throws {Error} When the field is absent, null, or not a string.
 */
function structuredString(
  value: { readonly structuredContent?: unknown },
  property: "recoveryId" | "revision" | "recoveryRevision" | "recoverUntil",
): string {
  const result = structuredStringSchema.parse(value.structuredContent)[
    property
  ];
  if (typeof result !== "string") {
    throw new Error(`Expected structured string field ${property}`);
  }
  return result;
}

describe("Worker MCP adapter", () => {
  it("defines one exhaustive independent permission for every exposed capability", () => {
    expect(MCP_OPERATION_PERMISSION).toEqual({
      list_notes: CLIENT_PERMISSION.read,
      inspect_note: CLIENT_PERMISSION.read,
      note_content: CLIENT_PERMISSION.read,
      list_recovery: CLIENT_PERMISSION.read,
      inspect_recovery: CLIENT_PERMISSION.read,
      recovery_content: CLIENT_PERMISSION.read,
      write_note: CLIENT_PERMISSION.write,
      seal_recovery: CLIENT_PERMISSION.write,
      delete_note: CLIENT_PERMISSION.delete,
      purge_recovery: CLIENT_PERMISSION.delete,
    });
  });

  it("serves current stateless Streamable HTTP discovery, tools, and resource templates", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getDiscoverResult()).toMatchObject({
      supportedVersions: [MCP_PROTOCOL_VERSION],
      instructions: expect.stringContaining("user confirmation"),
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
    const tools = await client.listTools();
    expect(
      tools.tools.every(({ outputSchema }) =>
        JSON.stringify(outputSchema)?.includes(
          MCP_TOOL_FAILURE.effectUncertain,
        ),
      ),
    ).toBe(true);
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "delete_note",
      "inspect_note",
      "inspect_recovery",
      "list_notes",
      "list_recovery",
      "purge_recovery",
      "seal_recovery",
      "write_note",
    ]);
    expect(
      tools.tools
        .filter(({ annotations }) => annotations?.destructiveHint === true)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["delete_note", "purge_recovery", "seal_recovery", "write_note"]);
    const resources = await client.listResources();
    expect(resources.resources).toEqual([]);
    const templates = await client.listResourceTemplates();
    expect(
      templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate),
    ).toEqual(
      expect.arrayContaining([
        "obsidian-ai-bridge://note/{encodedPath}",
        "obsidian-ai-bridge://recovery/{id}",
      ]),
    );
    expect(worker.resolverCount()).toBe(0);
    expect(worker.responseMetadata().length).toBeGreaterThan(0);
    expect(
      worker
        .responseMetadata()
        .every(
          ({ cacheControl, contentType }) =>
            cacheControl === "no-store" && contentType === "application/json",
        ),
    ).toBe(true);
    await client.close();

    const getResponse = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        headers: { Authorization: `Bearer ${worker.tokens.full}` },
      }),
    );
    const deleteResponse = await worker.app.fetch(
      new Request(`https://example.test${MCP_ENDPOINT_PATH}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${worker.tokens.full}` },
      }),
    );
    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(deleteResponse.headers.get("cache-control")).toBe("no-store");
    expect(worker.resolverCount()).toBe(0);
  });

  it("returns note content only from an explicit read resource as inert literal text", async () => {
    const worker = await createMcpTestWorker();
    const services = worker.services();
    await seedMcpNote(services, HOSTILE_NOTE_TEXT, 20);
    const client = await worker.connect(worker.tokens.read);

    const notePage = await client.callTool({
      name: "list_notes",
      arguments: {},
    });
    expect(notePage.isError).not.toBe(true);
    expect(notePage.structuredContent).toMatchObject({
      notes: [MCP_TEST_NOTE_PATH],
      nextCursor: null,
    });
    expect(JSON.stringify(notePage)).not.toContain(HOSTILE_NOTE_TEXT);

    const inspected = await client.callTool({
      name: "inspect_note",
      arguments: { path: MCP_TEST_NOTE_PATH },
    });
    expect(inspected.structuredContent).toMatchObject({
      kind: "live",
      path: MCP_TEST_NOTE_PATH,
    });
    expect(inspected.structuredContent).not.toHaveProperty("receipt");
    expect(inspected.structuredContent).not.toHaveProperty("contentSha256");
    expect(JSON.stringify(inspected)).not.toContain(HOSTILE_NOTE_TEXT);

    const content = await client.readResource({ uri: MCP_NOTE_RESOURCE_URI });
    expect(content.contents).toHaveLength(1);
    expect(content.contents[0]).toMatchObject({
      uri: MCP_NOTE_RESOURCE_URI,
      mimeType: "text/markdown",
      text: HOSTILE_NOTE_TEXT,
    });
    expect(
      worker.logger.entries.some((entry) =>
        JSON.stringify(entry).includes(HOSTILE_NOTE_TEXT),
      ),
    ).toBe(false);
    expect(worker.resolverCount()).toBe(3);
    await client.close();
  });

  it("preserves a leading Unicode BOM as exact note content through the MCP client", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);
    const content = "\uFEFF# BOM-prefixed note";

    const result = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content,
        operationId: "50000000-0000-4000-8000-000000000099",
      },
    });

    expect(result.isError).not.toBe(true);
    await expect(
      worker.services().current.read(MCP_TEST_NOTE_PATH),
    ).resolves.toBe(content);
    await client.close();
  });

  it("preserves literal percent-encoded-looking note paths across tools and resources", async () => {
    const literalPath = "MCP/percent%20name.md";
    if (!isNormalizedNotePath(literalPath)) {
      throw new Error("Invalid literal-path fixture");
    }
    const worker = await createMcpTestWorker();
    await seedMcpNote(
      worker.services(),
      "literal percent path",
      21,
      literalPath,
    );
    const client = await worker.connect(worker.tokens.read);

    const inspection = await client.callTool({
      name: "inspect_note",
      arguments: { path: literalPath },
    });
    expect(inspection.structuredContent).toMatchObject({
      kind: "live",
      path: literalPath,
    });

    const uri = `obsidian-ai-bridge://note/${encodeNotePath(literalPath)}`;
    const content = await client.readResource({ uri });
    expect(content.contents[0]).toMatchObject({
      uri,
      text: "literal percent path",
    });
    await client.close();
  });

  it("uses exact read, write, and delete permissions without deriving one from another", async () => {
    const worker = await createMcpTestWorker();
    const readClient = await worker.connect(worker.tokens.read);
    const writeClient = await worker.connect(worker.tokens.write);
    const deleteClient = await worker.connect(worker.tokens.delete);

    const readTools = await readClient.listTools();
    expect(readTools.tools).toHaveLength(8);
    const writeOnlyRead = await writeClient.callTool({
      name: "list_notes",
      arguments: {},
    });
    expect(writeOnlyRead.isError).toBe(true);
    const deleteOnlyRead = await deleteClient.callTool({
      name: "list_recovery",
      arguments: {},
    });
    expect(deleteOnlyRead.isError).toBe(true);

    const beforeDenials = worker.resolverCount();
    const deniedWrite = await readClient.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "not dispatched",
        operationId: "40000000-0000-4000-8000-000000000001",
      },
    });
    const deniedDelete = await writeClient.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: "40000000-0000-4000-8000-000000000002",
        operationId: "40000000-0000-4000-8000-000000000003",
      },
    });
    const deniedSeal = await deleteClient.callTool({
      name: "seal_recovery",
      arguments: {
        id: MCP_RECOVERY_ID,
        expectedRevision: "40000000-0000-4000-8000-000000000004",
        operationId: "40000000-0000-4000-8000-000000000005",
      },
    });
    expect(deniedWrite.isError).toBe(true);
    expect(deniedWrite.structuredContent).toMatchObject({
      error: { code: MCP_TOOL_FAILURE.permissionDenied },
    });
    expect(deniedDelete.isError).toBe(true);
    expect(deniedSeal.isError).toBe(true);
    expect(worker.resolverCount()).toBe(beforeDenials);

    let resourceDenied = false;
    try {
      await writeClient.readResource({ uri: MCP_NOTE_RESOURCE_URI });
    } catch {
      resourceDenied = true;
    }
    expect(resourceDenied).toBe(true);
    expect(worker.resolverCount()).toBe(beforeDenials);

    await readClient.close();
    await writeClient.close();
    await deleteClient.close();
  });

  it("returns an error when a current-write effect is unknown and never leaks storage details", async () => {
    const worker = await createMcpTestWorker();
    worker.bucket.afterConditionalPut = async (key) => {
      if (key === `vault/${MCP_TEST_NOTE_PATH}`) {
        throw new Error("private storage detail");
      }
    };
    const client = await worker.connect(worker.tokens.full);
    const result = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "may have committed",
        operationId: "50000000-0000-4000-8000-000000000011",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: MCP_TOOL_FAILURE.effectUncertain },
    });
    expect(JSON.stringify(result)).toContain(
      "The mutation outcome could not be confirmed.",
    );
    expect(JSON.stringify(result)).not.toContain("private storage detail");
    expect(JSON.stringify(result)).not.toContain("may have committed");
    await expect(
      worker.services().current.read(MCP_TEST_NOTE_PATH),
    ).resolves.toBe("may have committed");
    expect(worker.bucket.putKeys).toHaveLength(1);
    await client.close();
  });

  it("reuses conditional note writes and recovery services for explicit remote mutations", async () => {
    const worker = await createMcpTestWorker();
    const client = await worker.connect(worker.tokens.full);

    const created = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "created through MCP",
        operationId: "50000000-0000-4000-8000-000000000001",
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      action: "create",
      path: MCP_TEST_NOTE_PATH,
    });
    const liveRevision = structuredString(created, "revision");

    const updated = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "updated through MCP",
        expectedRevision: liveRevision,
        operationId: "50000000-0000-4000-8000-000000000002",
      },
    });
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).toMatchObject({ action: "update" });
    const updatedRevision = structuredString(updated, "revision");

    const stale = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "must not replace the winner",
        expectedRevision: liveRevision,
        operationId: "50000000-0000-4000-8000-000000000003",
      },
    });
    expect(stale.isError).toBe(true);
    expect(await worker.services().current.read(MCP_TEST_NOTE_PATH)).toBe(
      "updated through MCP",
    );

    const deleted = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: updatedRevision,
        operationId: "50000000-0000-4000-8000-000000000004",
      },
    });
    expect(deleted.isError).not.toBe(true);
    expect(deleted.structuredContent).toMatchObject({
      recoveryId: "50000000-0000-4000-8000-000000000004",
      recoveryKind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
      recoverUntil: null,
      sealing: MUTATION_EFFECT_CERTAINTY.confirmed,
    });
    expect(await worker.services().current.read(MCP_TEST_NOTE_PATH)).toBeNull();
    const tombstoneInspection = await client.callTool({
      name: "inspect_note",
      arguments: { path: MCP_TEST_NOTE_PATH },
    });
    expect(tombstoneInspection.structuredContent).toMatchObject({
      kind: "tombstone",
      path: MCP_TEST_NOTE_PATH,
      recoveryId: "50000000-0000-4000-8000-000000000004",
    });

    const recoveryId = structuredString(deleted, "recoveryId");
    const recoveryRevision = structuredString(deleted, "recoveryRevision");
    const recoveryUri = `obsidian-ai-bridge://recovery/${recoveryId}`;
    const recoveryContent = await client.readResource({ uri: recoveryUri });
    expect(recoveryContent.contents[0]).toMatchObject({
      uri: recoveryUri,
      mimeType: "text/markdown",
      text: "updated through MCP",
    });

    const recoveries = await client.callTool({
      name: "list_recovery",
      arguments: {},
    });
    expect(recoveries.structuredContent).toMatchObject({
      recoveries: [
        {
          id: recoveryId,
          kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        },
      ],
    });
    const inspection = await client.callTool({
      name: "inspect_recovery",
      arguments: { id: recoveryId },
    });
    expect(inspection.structuredContent).toMatchObject({
      kind: "found",
      recovery: { id: recoveryId, kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed },
    });
    expect(inspection.structuredContent).not.toHaveProperty("contentSha256");
    expect(inspection.structuredContent).not.toHaveProperty("associationId");

    const sealedReplay = await client.callTool({
      name: "seal_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: recoveryRevision,
        operationId: recoveryId,
      },
    });
    expect(sealedReplay.isError).not.toBe(true);
    const sealedRevision = structuredString(sealedReplay, "revision");
    const recoverUntil = structuredString(sealedReplay, "recoverUntil");

    worker.replaceServices(
      createTestMirrorServices(worker.bucket, { now: new Date(recoverUntil) }),
    );
    await expect(client.readResource({ uri: recoveryUri })).rejects.toThrow();
    const purged = await client.callTool({
      name: "purge_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: sealedRevision,
        operationId: "50000000-0000-4000-8000-000000000005",
      },
    });
    expect(purged.isError).not.toBe(true);
    expect(purged.structuredContent).toMatchObject({
      id: recoveryId,
      kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
    });
    await expect(
      worker.services().recovery.retrieve(requiredRecoveryId(recoveryId)),
    ).resolves.toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
    });

    await client.close();
  });

  it("recreates only the exact tombstone revision while preserving deleted recovery content", async () => {
    const worker = await createMcpTestWorker();
    const live = await seedMcpNote(worker.services(), "recovery source", 90);
    const client = await worker.connect(worker.tokens.full);
    const deleted = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000090",
      },
    });
    expect(deleted.isError).not.toBe(true);
    const recoveryId = structuredString(deleted, "recoveryId");
    const tombstoneRevision = structuredString(deleted, "revision");

    const recreated = await client.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "new generation",
        expectedRevision: tombstoneRevision,
        operationId: "50000000-0000-4000-8000-000000000091",
      },
    });
    expect(recreated.isError).not.toBe(true);
    expect(recreated.structuredContent).toMatchObject({
      action: "recreate",
      path: MCP_TEST_NOTE_PATH,
    });
    expect(await worker.services().current.read(MCP_TEST_NOTE_PATH)).toBe(
      "new generation",
    );
    await expect(
      worker.services().recovery.retrieve(requiredRecoveryId(recoveryId)),
    ).resolves.toMatchObject({
      kind: "recoverable",
      content: "recovery source",
    });
    await client.close();
  });

  it("maps unavailable explicit resource reads without exposing storage details", async () => {
    const absentWorker = await createMcpTestWorker();
    const absentClient = await absentWorker.connect(absentWorker.tokens.read);
    const absent = await absentClient.callTool({
      name: "inspect_note",
      arguments: { path: MCP_TEST_NOTE_PATH },
    });
    expect(absent.structuredContent).toMatchObject({ kind: "absent" });
    const missingNote = await absentClient
      .readResource({ uri: MCP_NOTE_RESOURCE_URI })
      .then(
        () => "",
        (error: unknown) => String(error),
      );
    expect(missingNote).not.toContain(HOSTILE_NOTE_TEXT);
    expect(absentWorker.resolverCount()).toBe(2);
    await absentClient.close();

    const noteWorker = await createMcpTestWorker();
    await seedMcpNote(noteWorker.services(), HOSTILE_NOTE_TEXT, 61);
    noteWorker.bucket.throwOnGet = true;
    const noteClient = await noteWorker.connect(noteWorker.tokens.read);
    const unavailableNote = await noteClient
      .readResource({ uri: MCP_NOTE_RESOURCE_URI })
      .then(
        () => "",
        (error: unknown) => String(error),
      );
    expect(unavailableNote).not.toContain("private storage detail");
    expect(unavailableNote).not.toContain(HOSTILE_NOTE_TEXT);
    await noteClient.close();

    const recoveryWorker = await createMcpTestWorker();
    const recoveryId = await seedMcpRecovery(
      recoveryWorker.services(),
      62,
      HOSTILE_NOTE_TEXT,
    );
    recoveryWorker.bucket.throwOnGet = true;
    const recoveryClient = await recoveryWorker.connect(
      recoveryWorker.tokens.read,
    );
    const unavailableRecovery = await recoveryClient
      .readResource({
        uri: `obsidian-ai-bridge://recovery/${recoveryId}`,
      })
      .then(
        () => "",
        (error: unknown) => String(error),
      );
    expect(unavailableRecovery).not.toContain("private storage detail");
    expect(unavailableRecovery).not.toContain(HOSTILE_NOTE_TEXT);
    await recoveryClient.close();
  });

  it("fails closed when mutation designation or initial storage observation is unavailable", async () => {
    const unconfiguredWorker = await createMcpTestWorker();
    unconfiguredWorker.replaceServices({
      ...unconfiguredWorker.services(),
      designation: null,
    });
    const unconfiguredClient = await unconfiguredWorker.connect(
      unconfiguredWorker.tokens.full,
    );
    const unconfigured = await unconfiguredClient.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "must not be dispatched",
        operationId: "50000000-0000-4000-8000-000000000021",
      },
    });
    expect(unconfigured.isError).toBe(true);
    expect(JSON.stringify(unconfigured)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.invalidState],
    );
    expect(unconfiguredWorker.bucket.putKeys).toHaveLength(0);
    await unconfiguredClient.close();

    const unavailableWorker = await createMcpTestWorker();
    unavailableWorker.bucket.throwOnGet = true;
    const unavailableClient = await unavailableWorker.connect(
      unavailableWorker.tokens.full,
    );
    const unavailable = await unavailableClient.callTool({
      name: "write_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        content: "storage observation failed",
        operationId: "50000000-0000-4000-8000-000000000022",
      },
    });
    expect(unavailable.isError).toBe(true);
    expect(JSON.stringify(unavailable)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.unavailable],
    );
    expect(JSON.stringify(unavailable)).not.toContain("private storage detail");
    expect(unavailableWorker.bucket.putKeys).toHaveLength(0);
    await unavailableClient.close();
  });

  it("preserves deletion stage and certainty across preparation and tombstone refusals", async () => {
    const worker = await createMcpTestWorker();
    const live = await seedMcpNote(worker.services(), "preserve this note", 71);
    const client = await worker.connect(worker.tokens.full);

    worker.bucket.throwOnGet = true;
    const observationFailure = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000071",
      },
    });
    expect(JSON.stringify(observationFailure)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.unavailable],
    );
    expect(worker.bucket.putKeys).toHaveLength(1);
    worker.bucket.throwOnGet = false;

    worker.bucket.refusedPutCalls.add(worker.bucket.putKeys.length + 1);
    const preparationRefusal = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000072",
      },
    });
    expect(JSON.stringify(preparationRefusal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.invalidState],
    );
    await expectMcpNoteState(worker.services(), "live");

    worker.bucket.throwBeforePut = true;
    const preparationFailure = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000073",
      },
    });
    worker.bucket.throwBeforePut = false;
    expect(JSON.stringify(preparationFailure)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.effectUncertain],
    );
    await expectMcpNoteState(worker.services(), "live");

    worker.bucket.refusedPutCalls.add(worker.bucket.putKeys.length + 2);
    const tombstoneRefusal = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000074",
      },
    });
    expect(JSON.stringify(tombstoneRefusal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.staleRevision],
    );
    await expectMcpNoteState(worker.services(), "live");

    worker.bucket.afterConditionalPut = async (key) => {
      if (key === `vault/${MCP_TEST_NOTE_PATH}`) {
        throw new Error("private storage detail");
      }
    };
    const uncertainTombstone = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000075",
      },
    });
    expect(JSON.stringify(uncertainTombstone)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.effectUncertain],
    );
    expect(JSON.stringify(uncertainTombstone)).not.toContain(
      "private storage detail",
    );
    await expectMcpNoteState(worker.services(), "tombstone");
    await client.close();
  });

  it("maps stale, conflicting, undispatched, and uncertain recovery maintenance safely", async () => {
    const worker = await createMcpTestWorker();
    const live = await seedMcpNote(
      worker.services(),
      "retain for recovery",
      81,
    );
    worker.bucket.refusedPutCalls.add(worker.bucket.putKeys.length + 3);
    const client = await worker.connect(worker.tokens.full);

    const deletion = await client.callTool({
      name: "delete_note",
      arguments: {
        path: MCP_TEST_NOTE_PATH,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000081",
      },
    });
    expect(deletion.structuredContent).toMatchObject({
      recoveryKind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
      sealing: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      recoverUntil: null,
    });
    const recoveryId = structuredString(deletion, "recoveryId");
    const recoveryRevision = structuredString(deletion, "recoveryRevision");

    const prepared = await client.callTool({
      name: "inspect_recovery",
      arguments: { id: recoveryId },
    });
    expect(prepared.structuredContent).toMatchObject({
      kind: "found",
      recovery: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        recoverUntil: null,
      },
    });

    const prematurePurge = await client.callTool({
      name: "purge_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: recoveryRevision,
        operationId: "50000000-0000-4000-8000-000000000082",
      },
    });
    expect(JSON.stringify(prematurePurge)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.invalidState],
    );

    const staleSeal = await client.callTool({
      name: "seal_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000083",
      },
    });
    expect(JSON.stringify(staleSeal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.staleRevision],
    );

    const missingSeal = await client.callTool({
      name: "seal_recovery",
      arguments: {
        id: "40000000-0000-4000-8000-000000000084",
        expectedRevision: live.revision,
        operationId: "50000000-0000-4000-8000-000000000084",
      },
    });
    expect(JSON.stringify(missingSeal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.invalidState],
    );

    worker.bucket.throwOnGet = true;
    const undispatchedSeal = await client.callTool({
      name: "seal_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: recoveryRevision,
        operationId: "50000000-0000-4000-8000-000000000085",
      },
    });
    expect(JSON.stringify(undispatchedSeal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.unavailable],
    );
    worker.bucket.throwOnGet = false;

    worker.bucket.afterConditionalPut = async (key) => {
      if (key.startsWith("recovery/")) {
        throw new Error("private storage detail");
      }
    };
    const uncertainSeal = await client.callTool({
      name: "seal_recovery",
      arguments: {
        id: recoveryId,
        expectedRevision: recoveryRevision,
        operationId: "50000000-0000-4000-8000-000000000086",
      },
    });
    expect(JSON.stringify(uncertainSeal)).toContain(
      MCP_TOOL_FAILURE_MESSAGE[MCP_TOOL_FAILURE.effectUncertain],
    );
    expect(JSON.stringify(uncertainSeal)).not.toContain(
      "private storage detail",
    );
    await expect(
      worker.services().recovery.inspect(requiredRecoveryId(recoveryId)),
    ).resolves.toMatchObject({ kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed });
    await client.close();
  });
});

/** Converts a canonical test UUID into the branded recovery identity used by core services.
 *
 * @param value - Synthetic recovery snapshot UUID.
 * @returns Branded recovery snapshot identity.
 * @throws {Error} When the fixture UUID is invalid.
 */
function requiredRecoveryId(value: string) {
  const recoveryId = createRecoverySnapshotId(value);
  if (recoveryId === undefined) throw new Error("Invalid recovery fixture");
  return recoveryId;
}
