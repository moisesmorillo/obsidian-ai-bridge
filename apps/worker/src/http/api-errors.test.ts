import { API_ERROR_CODES } from "@obsidian-ai-bridge/protocol";
import {
  createApiErrorResponse,
  getApiErrorDefinition,
} from "@worker/http/api-errors";
import { describe, expect, it } from "vitest";

describe("API error mapping", () => {
  it("maps every stable protocol error code to a public HTTP definition", () => {
    for (const code of API_ERROR_CODES) {
      const definition = getApiErrorDefinition(code);

      expect(definition.code).toBe(code);
      expect(definition.message).not.toBe("");
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(createApiErrorResponse(code)).toEqual({
        error: { code, message: definition.message },
      });
    }
  });
});
