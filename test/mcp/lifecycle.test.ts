import { describe, expect, test } from "bun:test";
import { createOperationHandler, type McpRequestLogger } from "../../src/mcp/handler";

class MemoryLogger implements McpRequestLogger {
  readonly events: Array<{ level: string; message: string; data?: unknown }> = [];
  info(message: string, data?: unknown): void { this.events.push({ level: "info", message, data }); }
  warn(message: string, data?: unknown): void { this.events.push({ level: "warn", message, data }); }
  error(message: string, data?: unknown): void { this.events.push({ level: "error", message, data }); }
}

describe("MCP request lifecycle tracing", () => {
  test("registra start y end con traceId, toolName, durationMs, responseBytes, activeRequests", async () => {
    const logger = new MemoryLogger();
    const handler = createOperationHandler({ execute: async () => ({ ok: true }) }, logger);
    const result = await handler("get_config", {});
    expect(result.isError).toBeUndefined();

    const start = logger.events.find((e) => e.message === "mcp.request.start");
    const end = logger.events.find((e) => e.message === "mcp.request.end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start?.data).toMatchObject({ traceId: expect.any(String), toolName: "get_config", activeRequests: 1 });
    expect(end?.data).toMatchObject({
      traceId: start?.data && (start.data as { traceId: string }).traceId,
      toolName: "get_config",
      responseBytes: expect.any(Number),
      activeRequests: 0,
    });

    const serialized = JSON.stringify(logger.events);
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("result");
  });

  test("registra error y nunca expone el payload de la operacion", async () => {
    const logger = new MemoryLogger();
    const handler = createOperationHandler({ execute: async () => { throw new Error("boom"); } }, logger);
    const result = await handler("write_file", { path: "/x", content: "secret" });
    expect(result.isError).toBe(true);

    const errorEvent = logger.events.find((e) => e.message === "mcp.request.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data).toMatchObject({ toolName: "write_file", error: "boom" });
    expect(JSON.stringify(logger.events)).not.toContain("secret");
  });

  test("un logger que falla nunca rompe la disponibilidad del MCP", async () => {
    const failing: McpRequestLogger = {
      info: () => { throw new Error("disk down"); },
      warn: () => { throw new Error("disk down"); },
      error: () => { throw new Error("disk down"); },
    };
    const handler = createOperationHandler({ execute: async () => ({ ok: true }) }, failing);
    await expect(handler("get_config", {})).resolves.toMatchObject({ content: expect.any(Array) });
  });
});
