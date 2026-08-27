import { describe, expect, test } from "bun:test";
import { createOperationHandler } from "../../src/mcp/handler";

describe("MCP operation handler", () => {
  test("classifies operation deadline failures as mcp.request.timeout", async () => {
    const events: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      info: (message: string, data?: unknown) => events.push({ level: "info", message, data }),
      warn: (message: string, data?: unknown) => events.push({ level: "warn", message, data }),
      error: (message: string, data?: unknown) => events.push({ level: "error", message, data }),
    };
    const handler = createOperationHandler({
      execute: async () => { throw new Error("Desktop Remote operation timed out after 20000ms"); },
    }, logger);

    const result = await handler("interact_with_process", { pid: 123 });

    expect(result).toEqual({
      content: [{ type: "text", text: "Desktop Remote operation timed out after 20000ms" }],
      isError: true,
    });
    expect(events.some((event) => event.message === "mcp.request.timeout")).toBe(true);
    expect(events.some((event) => event.message === "mcp.request.error")).toBe(false);
  });

  test("returns structured MCP content from the daemon operation executor", async () => {
    const handler = createOperationHandler({
      execute: async (name, input) => ({ name, input }),
    });

    await expect(handler("read_file", { path: "/tmp/example" })).resolves.toEqual({
      content: [{ type: "text", text: JSON.stringify({ name: "read_file", input: { path: "/tmp/example" } }) }],
      structuredContent: { name: "read_file", input: { path: "/tmp/example" } },
    });
  });

  test("converts executor errors to MCP tool errors", async () => {
    const handler = createOperationHandler({
      execute: async () => { throw new Error("daemon unavailable"); },
    });

    await expect(handler("read_file", {})).resolves.toEqual({
      content: [{ type: "text", text: "daemon unavailable" }],
      isError: true,
    });
  });
  test("omits structured content when the executor has no structured result", async () => {
    const handler = createOperationHandler({ execute: async () => undefined });

    await expect(handler("stop_search", { sessionId: "search-1" })).resolves.toEqual({
      content: [{ type: "text", text: "" }],
    });
  });
});
