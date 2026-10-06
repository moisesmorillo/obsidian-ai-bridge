import {
  PROFILE_IDS,
  profileReplySchema,
  profileStateSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile.contract";
import {
  advanceProfileState,
  observeProfileFailure,
} from "@worker-tests/runtime/fixtures/inventory-profile-state";
import { expect, it } from "vitest";

it("persists the maximum known uncertainty floor without advancing work", () => {
  const response = { action: "failed", retryAfterEpochMs: 2100, metrics };
  expect(profileReplySchema.safeParse(response).success).toBe(true);
  const failed = profileReplySchema.parse(response);
  expect(observeProfileFailure(state, failed, 2200)).toMatchObject({
    phase: "seed",
    notBeforeMs: 3300,
    offset: 0,
  });
});

it("keeps continuation scheduling after an observed LIST without granting completion authority", () => {
  const scanning = profileStateSchema.parse({
    ...state,
    phase: "scan",
    offset: 1,
  });
  const listed = profileReplySchema.parse({
    action: "inventory",
    result: {
      kind: "inventory_in_progress",
      ...PROFILE_IDS,
      retryAfterEpochMs: 2100,
    },
    metrics: { ...metrics, calls: { get: 1, list: 1, put: 1 } },
  });
  const continued = advanceProfileState(
    scanning,
    { action: "continue" },
    listed,
  );
  expect(continued).toMatchObject({
    phase: "scan",
    hasListed: true,
    handle: null,
    notBeforeMs: 2100,
  });
  const deferred = profileReplySchema.parse({
    action: "inventory",
    result: { kind: "inventory_in_progress", ...PROFILE_IDS },
    metrics: { ...metrics, calls: { get: 1, list: 0, put: 0 } },
  });
  expect(
    advanceProfileState(continued, { action: "continue" }, deferred),
  ).toMatchObject({ phase: "scan", hasListed: true, handle: null });
});

const metrics = {
  calls: { get: 2, put: 2, list: 0 },
  readBytes: 0,
  writtenBytes: 900,
  wallMs: 1,
  cpu: "unavailable",
  memory: "unavailable",
  clock: "real",
  preflightCpuAllowanceMs: 20,
};
const state = profileStateSchema.parse({
  headCount: 1,
  phase: "seed",
  offset: 0,
  handle: null,
  cursor: "",
  seen: [],
  notBeforeMs: 0,
  startedAtMs: 1000,
  scanStartedAtMs: null,
  maxHeadBytes: 0,
});
it("starts only after the confirmed fixture batch", () => {
  const reply = profileReplySchema.parse({
    action: "seed",
    nextOffset: 1,
    maxHeadBytes: 900,
    metrics,
  });
  expect(
    advanceProfileState(
      state,
      { action: "seed", headCount: 1, offset: 0 },
      reply,
    ),
  ).toMatchObject({ phase: "start", offset: 1, maxHeadBytes: 900 });
});
it("retains a known progress floor in the crash checkpoint", () => {
  const started = profileStateSchema.parse({
    ...state,
    phase: "start",
    offset: 1,
  });
  const reply = profileReplySchema.parse({
    action: "inventory",
    result: {
      kind: "inventory_in_progress",
      ...PROFILE_IDS,
      retryAfterEpochMs: 2100,
    },
    metrics,
  });
  expect(
    advanceProfileState(started, { action: "start" }, reply),
  ).toMatchObject({ phase: "scan", notBeforeMs: 2100 });
});
it("does not checkpoint success after a refused or uncertain store response", () => {
  expect(() =>
    advanceProfileState(
      state,
      { action: "seed", headCount: 1, offset: 0 },
      profileReplySchema.parse({ action: "failed", metrics }),
    ),
  ).toThrow();
  expect(state.phase).toBe("seed");
});
it("rejects a wrong action rather than adopting its apparently valid reply", () => {
  expect(() =>
    advanceProfileState(
      state,
      { action: "start" },
      profileReplySchema.parse({
        action: "seed",
        nextOffset: 1,
        maxHeadBytes: 900,
        metrics,
      }),
    ),
  ).toThrow();
});
