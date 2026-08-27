import { describe, expect, test } from "bun:test";
import { createOperationHandler } from "../../src/mcp/handler";
import { outputSchemas } from "../../src/mcp/output-schemas";

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

  test("bounds structured content and avoids duplicating a large payload in text", async () => {
    const payload = "payload-".repeat(200_000);
    const handler = createOperationHandler({
      execute: async () => ({ payload, processes: Array.from({ length: 10_000 }, (_, pid) => ({ pid, command: "bun" })) }),
    });

    const result = await handler("list_processes", {});
    const structuredJson = JSON.stringify(result.structuredContent);

    expect(structuredJson.length).toBeLessThan(payload.length);
    expect(Buffer.byteLength(structuredJson, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.content[0]?.text).not.toContain("payload-".repeat(100));
    expect(result.content[0]?.text.length).toBeLessThan(2_000);
  });

  test("keeps bounded structured content compatible with the declared output schema", async () => {
    const handler = createOperationHandler({
      execute: async () => ({
        content: "é".repeat(100_000),
        offset: 0,
        length: 1,
        truncated: true,
        hasMore: true,
      }),
    }, undefined, { responseBudget: { maxBytes: 1_024, maxStringBytes: 128, maxItems: 8 } });

    const result = await handler("read_file", {});

    expect(outputSchemas.read_file.safeParse(result.structuredContent).success).toBe(true);
  });
});
