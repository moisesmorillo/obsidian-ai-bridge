import {
  encodeNotePath,
  type NotePath,
  NotePayloadTooLargeError,
  type NoteService,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  apiErrorResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import type { WorkerHonoEnvironment } from "@worker/http/hono.types";
import {
  createDeleteNoteHandler,
  createGetNoteHandler,
  createPutNoteHandler,
} from "@worker/http/note.handlers";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

function normalizedPath(value: string): NotePath {
  const path = normalizeNotePath(value);
  if (path === undefined) {
    throw new Error(`Invalid test path: ${value}`);
  }

  return path;
}

function routeFor(path: string): string {
  return `/notes/${encodeNotePath(normalizedPath(path))}`;
}

function mockNoteService(): {
  readonly noteService: NoteService;
  readonly read: ReturnType<typeof vi.fn<NoteService["read"]>>;
  readonly write: ReturnType<typeof vi.fn<NoteService["write"]>>;
  readonly delete: ReturnType<typeof vi.fn<NoteService["delete"]>>;
} {
  const read = vi.fn<NoteService["read"]>().mockResolvedValue(null);
  const write = vi
    .fn<NoteService["write"]>()
    .mockResolvedValue({ created: false });
  const remove = vi.fn<NoteService["delete"]>().mockResolvedValue(undefined);

  return {
    noteService: {
      list: vi.fn<NoteService["list"]>().mockResolvedValue([]),
      read,
      write,
      delete: remove,
    },
    read,
    write,
    delete: remove,
  };
}

function application(noteService: NoteService): Hono<WorkerHonoEnvironment> {
  const app = new Hono<WorkerHonoEnvironment>();
  app.use("*", (context, next) => {
    context.set("noteService", noteService);
    return next();
  });
  app.get("/notes/:path", createGetNoteHandler());
  app.put("/notes/:path", createPutNoteHandler());
  app.delete("/notes/:path", createDeleteNoteHandler());
  return app;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.test${path}`, init);
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("note handlers", () => {
  it("rejects an invalid path before calling the service", async () => {
    const mock = mockNoteService();
    const response = await application(mock.noteService).fetch(
      request("/notes/not-base64!"),
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.invalidPath);
    expect(mock.read).not.toHaveBeenCalled();
  });

  it("maps a missing note to 404", async () => {
    const mock = mockNoteService();
    const response = await application(mock.noteService).fetch(
      request(routeFor("Missing.md")),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.notFound);
    expect(mock.read).toHaveBeenCalledOnce();
  });

  it.each([
    [{ created: true }, 201],
    [{ created: false }, 200],
  ] as const)("maps a %j write result to %i", async (result, status) => {
    const mock = mockNoteService();
    mock.write.mockResolvedValue(result);

    const response = await application(mock.noteService).fetch(
      request(routeFor("Alpha.md"), { method: "PUT", body: "alpha" }),
    );

    expect(response.status).toBe(status);
    expect(mock.write).toHaveBeenCalledOnce();
  });

  it("maps an oversized service error to 413", async () => {
    const mock = mockNoteService();
    mock.write.mockRejectedValue(new NotePayloadTooLargeError());

    const response = await application(mock.noteService).fetch(
      request(routeFor("Alpha.md"), { method: "PUT", body: "alpha" }),
    );

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.payloadTooLarge);
  });

  it("delegates deletion exactly once", async () => {
    const mock = mockNoteService();
    const path = normalizedPath("Alpha.md");

    const response = await application(mock.noteService).fetch(
      request(routeFor("Alpha.md"), { method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect(mock.delete).toHaveBeenCalledOnce();
    expect(mock.delete).toHaveBeenCalledWith(path);
  });

  it("rejects unsupported media types before calling the service", async () => {
    const mock = mockNoteService();

    const response = await application(mock.noteService).fetch(
      request(routeFor("Alpha.md"), {
        method: "PUT",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(415);
    expect(await errorCode(response)).toBe(API_ERROR_CODE.unsupportedMediaType);
    expect(mock.write).not.toHaveBeenCalled();
  });
});
