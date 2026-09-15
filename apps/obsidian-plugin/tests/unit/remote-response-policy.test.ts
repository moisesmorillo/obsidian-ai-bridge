import {
  classifyRemoteResponse,
  REMOTE_BRIDGE_OPERATION,
  remoteOperationMethod,
} from "@obsidian-plugin/remote/remote-response-policy";
import { describe, expect, it } from "vitest";

describe("remote response policy", () => {
  it.each([
    [REMOTE_BRIDGE_OPERATION.read.describe, "GET", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.read.listNotes, "GET", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.read.readNote, "GET", 404, "missing"],
    [REMOTE_BRIDGE_OPERATION.read.inspectNote, "GET", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.mutation.createNote, "PUT", 201, "primary"],
    [REMOTE_BRIDGE_OPERATION.mutation.updateNote, "PUT", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.mutation.recreateNote, "PUT", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.mutation.tombstoneNote, "DELETE", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.read.listRecovery, "GET", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.read.inspectRecovery, "GET", 404, "missing"],
    [
      REMOTE_BRIDGE_OPERATION.read.readRecoveryContent,
      "GET",
      410,
      "unavailable",
    ],
    [REMOTE_BRIDGE_OPERATION.mutation.sealRecovery, "POST", 200, "primary"],
    [REMOTE_BRIDGE_OPERATION.mutation.purgeRecovery, "POST", 200, "primary"],
  ] as const)(
    "owns %s as %s with status %i classified as %s",
    (operation, method, status, outcome) => {
      expect(remoteOperationMethod(operation)).toBe(method);
      expect(classifyRemoteResponse(operation, status)).toEqual({
        kind: "accepted",
        outcome,
      });
    },
  );

  it.each([
    [REMOTE_BRIDGE_OPERATION.read.describe, 401, "unauthenticated"],
    [REMOTE_BRIDGE_OPERATION.read.describe, 403, "forbidden"],
    [REMOTE_BRIDGE_OPERATION.read.describe, 404, "incompatible-protocol"],
    [REMOTE_BRIDGE_OPERATION.read.describe, 409, "malformed-response"],
    [REMOTE_BRIDGE_OPERATION.read.describe, 429, "rate-limited"],
    [REMOTE_BRIDGE_OPERATION.read.describe, 503, "server-failed"],
  ] as const)(
    "classifies read operation %s status %i as %s",
    (operation, status, failure) => {
      expect(classifyRemoteResponse(operation, status)).toEqual({
        kind: "failure",
        failure,
      });
    },
  );

  it.each([
    [
      REMOTE_BRIDGE_OPERATION.mutation.createNote,
      412,
      "precondition-failed",
      "definitely-refused",
    ],
    [
      REMOTE_BRIDGE_OPERATION.mutation.createNote,
      428,
      "precondition-required",
      "definitely-refused",
    ],
    [
      REMOTE_BRIDGE_OPERATION.mutation.createNote,
      404,
      "incompatible-protocol",
      "unknown",
    ],
    [
      REMOTE_BRIDGE_OPERATION.mutation.sealRecovery,
      404,
      "missing",
      "definitely-refused",
    ],
    [
      REMOTE_BRIDGE_OPERATION.mutation.sealRecovery,
      409,
      "conflict",
      "definitely-refused",
    ],
    [
      REMOTE_BRIDGE_OPERATION.mutation.sealRecovery,
      503,
      "server-failed",
      "unknown",
    ],
  ] as const)(
    "classifies mutation operation %s status %i as %s with %s effect",
    (operation, status, failure, effect) => {
      expect(classifyRemoteResponse(operation, status)).toEqual({
        kind: "failure",
        failure,
        effect,
      });
    },
  );
});
