import { CONDITIONAL_MUTATION_PRECONDITION_KIND } from "@obsidian-ai-bridge/core";
import {
  CONDITIONAL_REQUEST_RESULT_KIND,
  parseConditionalRequest,
} from "@worker/http/conditional-request";
import { describe, expect, it } from "vitest";

const REVISION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAG = `"m3-${REVISION}"`;

describe("v2 conditional request parser", () => {
  it("accepts only exact create and matching-generation forms", () => {
    expect(
      parseConditionalRequest(new Headers({ "If-None-Match": "*" }), "put"),
    ).toEqual({
      kind: CONDITIONAL_REQUEST_RESULT_KIND.valid,
      precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
    });
    expect(
      parseConditionalRequest(new Headers({ "If-Match": ETAG }), "matching"),
    ).toEqual({
      kind: CONDITIONAL_REQUEST_RESULT_KIND.valid,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: REVISION,
      },
    });
  });

  it("distinguishes a missing required condition", () => {
    expect(parseConditionalRequest(new Headers(), "put")).toEqual({
      kind: CONDITIONAL_REQUEST_RESULT_KIND.missing,
    });
  });

  it.each([
    { "If-Match": `W/${ETAG}` },
    { "If-Match": "*" },
    { "If-Match": `${ETAG}, ${ETAG}` },
    { "If-Match": '"other"' },
    { "If-None-Match": ETAG },
    { "If-None-Match": "*, other" },
    { "If-Match": ETAG, "If-None-Match": "*" },
    {
      "If-Match": ETAG,
      "If-Unmodified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
    },
    { "If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT" },
  ])(
    "rejects malformed, weak, wildcard, list, mixed, and date forms: %j",
    (values) => {
      expect(parseConditionalRequest(new Headers(values), "put")).toEqual({
        kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid,
      });
    },
  );

  it("rejects absence conditions for matching-only routes", () => {
    expect(
      parseConditionalRequest(
        new Headers({ "If-None-Match": "*" }),
        "matching",
      ),
    ).toEqual({ kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid });
  });
});
