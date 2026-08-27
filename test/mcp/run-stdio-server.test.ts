import { describe, expect, test } from "bun:test";
import { runMcpStdioServer, type McpLifecycleLogger } from "../../src/mcp/run-stdio-server";

class MemoryLogger implements McpLifecycleLogger {
  readonly events: Array<{ level: string; message: string; data?: unknown }> = [];
  async info(message: string, data?: unknown): Promise<void> { this.events.push({ level: "info", message, data }); }
  async warn(message: string, data?: unknown): Promise<void> { this.events.push({ level: "warn", message, data }); }
  async error(message: string, data?: unknown): Promise<void> { this.events.push({ level: "error", message, data }); }
}

class FailingLogger implements McpLifecycleLogger {
  async info(): Promise<void> { throw new Error("disk unavailable"); }
  async warn(): Promise<void> { throw new Error("disk unavailable"); }
  async error(): Promise<void> { throw new Error("disk unavailable"); }
}

describe("runMcpStdioServer", () => {
  test("records startup and successful stdio attachment without protocol payloads", async () => {
    const logger = new MemoryLogger();
    const transport = { name: "stdio" };
    const server = { connect: async (actual: unknown) => { expect(actual).toBe(transport); } };

    await runMcpStdioServer({ server, transport, logger, pid: 101, ppid: 99 });

    expect(logger.events).toEqual([
      { level: "info", message: "mcp process starting", data: { pid: 101, ppid: 99 } },
      { level: "info", message: "mcp stdio transport connected", data: { pid: 101 } },
    ]);
    expect(JSON.stringify(logger.events)).not.toContain("arguments");
    expect(JSON.stringify(logger.events)).not.toContain("params");
  });

  test("records a bounded startup failure and rethrows it", async () => {
    const logger = new MemoryLogger();
    const secret = "sk-live-do-not-log";
    const server = { connect: async () => { throw new Error(`transport closed ${secret}`); } };

    await expect(runMcpStdioServer({ server, transport: {}, logger, pid: 101, ppid: 99 })).rejects.toThrow("transport closed");

    const serialized = JSON.stringify(logger.events);
    expect(serialized).toContain("mcp stdio transport failed");
    expect(serialized).not.toContain(secret);
  });

  test("logging failures never prevent a healthy MCP transport from connecting", async () => {
    let connected = false;
    const server = { connect: async () => { connected = true; } };

    await expect(runMcpStdioServer({
      server,
      transport: {},
      logger: new FailingLogger(),
      pid: 101,
      ppid: 99,
    })).resolves.toBeUndefined();

    expect(connected).toBe(true);
  });

  test("logging failures never mask the original MCP transport error", async () => {
    const server = { connect: async () => { throw new Error("transport closed"); } };

    await expect(runMcpStdioServer({
      server,
      transport: {},
      logger: new FailingLogger(),
      pid: 101,
      ppid: 99,
    })).rejects.toThrow("transport closed");
  });
});
