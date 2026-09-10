import { vi } from "vitest";

const logTape = vi.hoisted(() => {
  const info = vi.fn();
  return {
    getLogger: vi.fn(() => ({ info })),
    info,
  };
});

vi.mock("@logtape/logtape", () => ({ getLogger: logTape.getLogger }));

import type { RequestLogEntry } from "@worker/logging/logger.types";
import {
  LOG_OPERATION,
  WORKER_LOG_CATEGORY,
} from "@worker/logging/logging.constants";
import { createWorkerLogger } from "@worker/logging/logtape-logger";
import { describe, expect, it } from "vitest";

describe("createWorkerLogger", () => {
  it("passes request metadata as LogTape structured properties", () => {
    const entry: RequestLogEntry = {
      operation: LOG_OPERATION.httpRequest,
      method: "GET",
      route: "/api/v1/notes/:path",
      status: 200,
      durationMs: 1.25,
    };

    createWorkerLogger().info(entry);

    expect(logTape.getLogger).toHaveBeenCalledWith(WORKER_LOG_CATEGORY);
    expect(logTape.info).toHaveBeenCalledWith("HTTP request completed.", entry);
    expect(logTape.info.mock.calls[0]?.[1]).not.toHaveProperty("properties");
  });
});
