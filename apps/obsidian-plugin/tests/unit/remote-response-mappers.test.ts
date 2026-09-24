import { normalizeNotePath } from "@obsidian-ai-bridge/core";
import type {
  CurrentNoteStateDto,
  MutationAcknowledgementDto,
  RecoverySnapshotStateDto,
} from "@obsidian-ai-bridge/protocol";
import {
  mapCurrentStateDto,
  mapMutationAcknowledgementDto,
  mapRecoveryStateDto,
} from "@obsidian-plugin/remote/remote-response-mappers";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const PARENT_REVISION = "44444444-4444-4444-8444-444444444444";
const RECOVERY_ID = "55555555-5555-4555-8555-555555555555";
const CONTENT_SHA_256 = "a3".repeat(32);
const PATH = required(normalizeNotePath("notes/example.md"));

const acknowledgementDto = {
  path: PATH,
  revision: REVISION,
  receipt: {
    action: "update",
    associationId: ASSOCIATION_ID,
    operationId: OPERATION_ID,
    precondition: { kind: "matching-revision", revision: PARENT_REVISION },
    contentSha256: CONTENT_SHA_256,
  },
} satisfies MutationAcknowledgementDto;

describe("remote response mappers", () => {
  it("maps coherent acknowledgement and current-state DTOs", () => {
    expect(mapMutationAcknowledgementDto(acknowledgementDto)).toMatchObject({
      path: "notes/example.md",
      revision: REVISION,
      receipt: { action: "update", contentSha256: CONTENT_SHA_256 },
    });

    const current = {
      kind: "live",
      path: acknowledgementDto.path,
      revision: REVISION,
      contentSha256: CONTENT_SHA_256,
      receipt: acknowledgementDto.receipt,
    } satisfies CurrentNoteStateDto;
    expect(mapCurrentStateDto(current)).toMatchObject({
      kind: "live",
      path: "notes/example.md",
      revision: REVISION,
    });
  });

  it("maps absence, tombstones, and sealed recovery without widening protocol state", () => {
    expect(mapCurrentStateDto({ kind: "absent", path: PATH })).toEqual({
      kind: "absent",
      path: PATH,
    });

    const tombstone = {
      kind: "tombstone",
      path: PATH,
      revision: REVISION,
      deletedRevision: REVISION,
      recoveryId: RECOVERY_ID,
      receipt: {
        action: "tombstone",
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: { kind: "matching-revision", revision: PARENT_REVISION },
      },
    } satisfies CurrentNoteStateDto;
    expect(mapCurrentStateDto(tombstone)).toMatchObject({
      kind: "tombstone",
      deletedRevision: REVISION,
      recoveryId: RECOVERY_ID,
    });

    const sealed: RecoverySnapshotStateDto = {
      kind: "sealed",
      id: RECOVERY_ID,
      associationId: ASSOCIATION_ID,
      path: PATH,
      revision: REVISION,
      sourceRevision: PARENT_REVISION,
      contentSha256: CONTENT_SHA_256,
      recoverUntil: "2030-01-01T00:00:00.000Z",
    };
    expect(mapRecoveryStateDto(sealed)).toMatchObject({
      kind: "sealed",
      recoverUntil: "2030-01-01T00:00:00.000Z",
    });
  });

  it("rejects DTO fields that cannot become branded application values", () => {
    expect(
      mapMutationAcknowledgementDto({
        ...acknowledgementDto,
        revision: "not-a-revision",
      }),
    ).toBeUndefined();
    expect(
      mapCurrentStateDto({
        kind: "live",
        path: PATH,
        revision: REVISION,
        contentSha256: "not-a-hash",
        receipt: acknowledgementDto.receipt,
      }),
    ).toBeUndefined();
    expect(
      mapMutationAcknowledgementDto({
        ...acknowledgementDto,
        receipt: {
          ...acknowledgementDto.receipt,
          associationId: "not-an-association",
        },
      }),
    ).toBeUndefined();

    const recovery = {
      kind: "prepared",
      id: RECOVERY_ID,
      associationId: ASSOCIATION_ID,
      path: acknowledgementDto.path,
      revision: REVISION,
      sourceRevision: PARENT_REVISION,
      contentSha256: CONTENT_SHA_256,
    } satisfies RecoverySnapshotStateDto;
    expect(mapRecoveryStateDto(recovery)).toMatchObject({
      kind: "prepared",
      id: RECOVERY_ID,
    });
    expect(
      mapRecoveryStateDto({ ...recovery, id: "not-a-recovery-id" }),
    ).toBeUndefined();
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected test fixture value.");
  return value;
}
