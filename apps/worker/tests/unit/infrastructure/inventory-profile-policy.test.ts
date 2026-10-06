import {
  profileHeadCount,
  profileWait,
} from "@worker-tests/runtime/fixtures/inventory-profile-policy";
import { describe, expect, it } from "vitest";

describe("local profile dispatch policy", () => {
  it("accepts the maximal requested head count without silently replacing it", () => {
    expect(profileHeadCount("10000")).toBe(10000);
  });
  it.each(["-1", "10001", "1.5", "", "NaN", "1e4"])(
    "rejects unsafe fixture size %s before seeding",
    (value) => {
      expect(() => profileHeadCount(value)).toThrow(RangeError);
    },
  );
  it("waits on the host until the exact known floor", () => {
    expect(profileWait(1000, 2100)).toBe(1100);
    expect(profileWait(2200, 2100)).toBe(0);
  });
  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("does not hide invalid floor %s behind a later clock", (floor) => {
    expect(() => profileWait(10000, floor)).toThrow(RangeError);
  });
});
