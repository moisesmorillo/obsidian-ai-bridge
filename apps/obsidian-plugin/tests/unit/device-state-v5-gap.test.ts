import {
  createApplicationRevision,
  createContentSha256,
  createDisabledMirrorState,
  createMirrorAssociationId,
  createMirrorWriterId,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  RECONCILIATION_OBSERVATION_COVERAGE,
} from "@obsidian-ai-bridge/core";
import {
  decodeMirrorDeviceState,
  encodeMirrorDeviceState,
} from "@obsidian-plugin/state/device-state-codec";
import { migrateMirrorDeviceStateV4ToV5 } from "@obsidian-plugin/state/device-state-migration";
import {
  decodeMirrorDeviceStateV4,
  encodeMirrorDeviceStateV4,
  MAX_MIRROR_DEVICE_STATE_BYTES,
} from "@obsidian-plugin/state/device-state-v4.codec";
import type { HandoffIntegrity } from "@obsidian-plugin/state/handoff-codec";
import { describe, expect, it } from "vitest";

const deviceId = createMirrorWriterId("00000000-0000-4000-8000-000000000001");
const associationId = createMirrorAssociationId(
  "00000000-0000-4000-8000-000000000002",
);
const revision = createApplicationRevision(
  "00000000-0000-4000-8000-000000000003",
);
const checksum = createContentSha256("ab".repeat(32));
const mismatchedChecksum = createContentSha256("cd".repeat(32));
if (
  deviceId === undefined ||
  associationId === undefined ||
  revision === undefined ||
  checksum === undefined ||
  mismatchedChecksum === undefined
) {
  throw new Error("Invalid test identity");
}

function stagedHandoffState(
  stagedChecksum: string,
  transferable = true,
): string {
  return JSON.stringify({
    format: "obsidian-ai-bridge-device-state",
    version: 4,
    deviceId,
    lifecycle: {
      kind: MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged,
      associationId,
      origin: "https://bridge.example",
    },
    globalBlockReason: null,
    paths: [],
    stagedHandoff: {
      associationId,
      origin: "https://bridge.example",
      checksum: stagedChecksum,
      entries: [
        {
          path: "notes/staged.md",
          acknowledgement: transferable
            ? {
                kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
                revision,
                contentSha256: checksum,
              }
            : { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
          localAlignment: "matched",
          remoteVerification: "matched",
          observationGeneration: 1,
        },
      ],
    },
    reconciliationReviews: [],
    reconciliationOperations: [],
  });
}

describe("ADR 0013 strict cold migration", () => {
  it("migrates empty v4 reconciliation state without inventing operations or reviews", async () => {
    const state = createDisabledMirrorState(deviceId);
    const v4 = JSON.stringify({
      format: "obsidian-ai-bridge-device-state",
      version: 4,
      deviceId: state.deviceId,
      lifecycle: state.lifecycle,
      globalBlockReason: state.globalBlockReason,
      paths: state.paths,
      stagedHandoff: state.stagedHandoff,
      reconciliationReviews: state.reconciliationReviews,
      reconciliationOperations: [],
    });
    expect((await decodeMirrorDeviceStateV4(v4)).kind).toBe("valid");
    const projected = migrateMirrorDeviceStateV4ToV5(state);
    expect(projected.reconciliationOperations).toEqual([]);
    expect(projected.reconciliationReviews).toEqual([]);
    const encoded = encodeMirrorDeviceState(projected);
    expect((await decodeMirrorDeviceState(encoded)).kind).toBe("valid");
    expect((await decodeMirrorDeviceStateV4(encoded)).kind).toBe(
      "unsupported-version",
    );
  });

  it("round-trips staged handoff integrity without activating its baseline", async () => {
    const integrity: HandoffIntegrity = {
      digest: async () => checksum,
    };
    const decoded = await decodeMirrorDeviceStateV4(
      stagedHandoffState(checksum),
      integrity,
    );
    expect(decoded.kind).toBe("valid");
    if (decoded.kind !== "valid") throw new Error("Staged fixture is invalid.");

    const encoded = encodeMirrorDeviceStateV4(decoded.state);
    expect((await decodeMirrorDeviceStateV4(encoded, integrity)).kind).toBe(
      "valid",
    );
    expect(
      await decodeMirrorDeviceStateV4(
        stagedHandoffState(mismatchedChecksum),
        integrity,
      ),
    ).toEqual({ kind: "corrupt" });
    await expect(
      decodeMirrorDeviceStateV4(stagedHandoffState(checksum, false), integrity),
    ).resolves.toEqual({ kind: "corrupt" });
    await expect(
      decodeMirrorDeviceState(
        stagedHandoffState(checksum, false).replace(
          '"version":4',
          '"version":5',
        ),
        integrity,
      ),
    ).resolves.toEqual({ kind: "corrupt" });
  });

  it("classifies frozen v4 storage boundaries without repairing malformed fields", async () => {
    const state = createDisabledMirrorState(deviceId);
    const valid = JSON.stringify({
      format: "obsidian-ai-bridge-device-state",
      version: 4,
      deviceId: state.deviceId,
      lifecycle: state.lifecycle,
      globalBlockReason: state.globalBlockReason,
      paths: state.paths,
      stagedHandoff: state.stagedHandoff,
      reconciliationReviews: state.reconciliationReviews,
      reconciliationOperations: [],
    });
    await expect(decodeMirrorDeviceStateV4(null)).resolves.toEqual({
      kind: "missing",
    });
    await expect(decodeMirrorDeviceStateV4(42)).resolves.toEqual({
      kind: "corrupt",
    });
    await expect(decodeMirrorDeviceStateV4("{")).resolves.toEqual({
      kind: "corrupt",
    });
    await expect(
      decodeMirrorDeviceStateV4("x".repeat(MAX_MIRROR_DEVICE_STATE_BYTES + 1)),
    ).resolves.toEqual({ kind: "corrupt" });
    await expect(
      decodeMirrorDeviceStateV4(
        JSON.stringify({
          format: "obsidian-ai-bridge-device-state",
          version: 99,
        }),
      ),
    ).resolves.toEqual({ kind: "unsupported-version", version: 99 });
    await expect(
      decodeMirrorDeviceStateV4(`${valid.slice(0, -1)},"unexpected":true}`),
    ).resolves.toEqual({ kind: "corrupt" });
    await expect(
      decodeMirrorDeviceStateV4(
        valid.replace(`"deviceId":"${deviceId}"`, '"deviceId":"invalid"'),
      ),
    ).resolves.toEqual({ kind: "corrupt" });
  });

  it("rejects a v5 operation with an unrecognized coverage rather than treating it as continuous", async () => {
    const state = migrateMirrorDeviceStateV4ToV5(
      createDisabledMirrorState(deviceId),
    );
    const encoded = encodeMirrorDeviceState(state);
    const parsed = JSON.parse(encoded);
    parsed.reconciliationOperations = [{ observationCoverage: "no-gap" }];
    expect((await decodeMirrorDeviceState(JSON.stringify(parsed))).kind).toBe(
      "corrupt",
    );
    expect(RECONCILIATION_OBSERVATION_COVERAGE.gapReviewRequired).toBe(
      "gap-review-required",
    );
  });
});
