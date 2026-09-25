import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalContentWriteRequest,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createMirrorOperationId,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  createTestMirrorServices,
  MemoryMirrorBucket,
  TEST_ASSOCIATION_ID,
  TEST_WRITER_ID,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";

const PATH = required(normalizeNotePath("MCP/Conditional.md"));

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture");
  return value;
}

function operationId(sequence: number) {
  return required(
    createMirrorOperationId(
      `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    ),
  );
}

function writeRequest(
  sequence: number,
  content: string,
  precondition: ConditionalContentWriteRequest["precondition"],
): ConditionalContentWriteRequest {
  return {
    associationId: TEST_ASSOCIATION_ID,
    writerId: TEST_WRITER_ID,
    operationId: operationId(sequence),
    path: PATH,
    precondition,
    content,
  };
}

describe("CurrentGenerationService.writeConditionally", () => {
  it("shares create, live update, and tombstone recreation selection as one application policy", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = createTestMirrorServices(bucket);

    const created = await current.writeConditionally(
      writeRequest(1, "created remotely", {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      }),
    );
    expect(created).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        path: PATH,
        receipt: {
          action: MUTATION_ACTION.create,
          operationId: operationId(1),
        },
      },
    });
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed create");
    }

    const updated = await current.writeConditionally(
      writeRequest(2, "updated remotely", {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: created.confirmed.revision,
      }),
    );
    expect(updated).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        receipt: {
          action: MUTATION_ACTION.update,
          operationId: operationId(2),
        },
      },
    });
    if (updated.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed update");
    }

    const deleted = await current.tombstone({
      action: MUTATION_ACTION.tombstone,
      associationId: TEST_ASSOCIATION_ID,
      writerId: TEST_WRITER_ID,
      operationId: operationId(3),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: updated.confirmed.revision,
      },
    });
    expect(deleted.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    if (deleted.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed tombstone");
    }

    const recreated = await current.writeConditionally(
      writeRequest(4, "recreated remotely", {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: deleted.confirmed.acknowledgement.revision,
      }),
    );
    expect(recreated).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        receipt: {
          action: MUTATION_ACTION.recreate,
          operationId: operationId(4),
        },
      },
    });
    await expect(current.read(PATH)).resolves.toBe("recreated remotely");
    expect(
      bucket.putKeys.filter((key) => key === `vault/${PATH}`),
    ).toHaveLength(4);
  });

  it("refuses stale revisions, absence, and legacy objects without replacement writes", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = createTestMirrorServices(bucket);
    const created = await current.writeConditionally(
      writeRequest(5, "original", {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      }),
    );
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed create");
    }
    const writesBefore = bucket.putKeys.length;

    await expect(
      current.writeConditionally(
        writeRequest(6, "stale replacement", {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: required(
            createApplicationRevision("10000000-0000-4000-8000-000000000099"),
          ),
        }),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    expect(bucket.putKeys).toHaveLength(writesBefore);
    await expect(current.read(PATH)).resolves.toBe("original");

    const absentBucket = new MemoryMirrorBucket();
    const absent = createTestMirrorServices(absentBucket);
    await expect(
      absent.current.writeConditionally(
        writeRequest(7, "must not create", {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: required(
            createApplicationRevision("10000000-0000-4000-8000-000000000008"),
          ),
        }),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    expect(absentBucket.putKeys).toHaveLength(0);

    const legacyBucket = new MemoryMirrorBucket();
    legacyBucket.seed(`vault/${PATH}`, "legacy text");
    const legacy = createTestMirrorServices(legacyBucket);
    await expect(
      legacy.current.writeConditionally(
        writeRequest(9, "must not replace legacy", {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: required(
            createApplicationRevision("10000000-0000-4000-8000-000000000010"),
          ),
        }),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    expect(legacyBucket.putKeys).toHaveLength(0);
    await expect(legacy.current.inspect(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.legacy,
    });
  });

  it("preserves a leading Unicode BOM as exact valid note content", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = createTestMirrorServices(bucket);
    const content = "\uFEFF# BOM-prefixed note";

    const written = await current.writeConditionally(
      writeRequest(12, content, {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      }),
    );

    expect(written.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    await expect(current.read(PATH)).resolves.toBe(content);
  });

  it("fails closed before dispatch for malformed Unicode or content above the note bound", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = createTestMirrorServices(bucket);

    await expect(
      current.writeConditionally(
        writeRequest(10, "\ud800", {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        }),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      current.writeConditionally(
        writeRequest(11, "x".repeat(MAX_NOTE_SIZE_BYTES + 1), {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        }),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    expect(bucket.getCount).toBe(0);
    expect(bucket.putKeys).toHaveLength(0);
  });
});
