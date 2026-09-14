import { resolveWorkerMirrorServices } from "@worker/composition";
import {
  MemoryMirrorBucket,
  TEST_ASSOCIATION_ID,
  TEST_WRITER_ID,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";

describe("Worker mirror composition", () => {
  it("validates canonical designation IDs at the composition boundary", () => {
    const services = resolveWorkerMirrorServices({
      VAULT_BUCKET: new MemoryMirrorBucket(),
      MIRROR_ASSOCIATION_ID: TEST_ASSOCIATION_ID,
      MIRROR_WRITER_ID: TEST_WRITER_ID,
    });
    expect(services.designation).toEqual({
      associationId: TEST_ASSOCIATION_ID,
      writerId: TEST_WRITER_ID,
    });
  });

  it.each([
    {},
    {
      MIRROR_ASSOCIATION_ID: "NOT-CANONICAL",
      MIRROR_WRITER_ID: TEST_WRITER_ID,
    },
    { MIRROR_ASSOCIATION_ID: TEST_ASSOCIATION_ID, MIRROR_WRITER_ID: "invalid" },
  ])("fails malformed or missing designation closed", (configuration) => {
    expect(
      resolveWorkerMirrorServices({
        VAULT_BUCKET: new MemoryMirrorBucket(),
        ...configuration,
      }).designation,
    ).toBeNull();
  });
});
