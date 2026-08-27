import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  createMcpServer,
  getMcpLifecycleSnapshot,
  MCP_SERVER_INFO,
} from "../../src/mcp/server";
import { computeMcpToolCatalogHash, createToolDefinitions } from "../../src/mcp/tools";

type Event = { level: string; message: string; data?: Record<string, unknown> };

const validConfig = {
  blockedCommands: [],
  defaultShell: "zsh",
  allowedDirectories: [],
  fileReadLineLimit: 1,
  fileWriteLineLimit: 1,
  telemetryEnabled: false,
};

class MemoryLogger {
  readonly events: Event[] = [];

  info(message: string, data?: unknown): void {
    this.events.push({ level: "info", message, data: data as Record<string, unknown> | undefined });
  }

  warn(message: string, data?: unknown): void {
    this.events.push({ level: "warn", message, data: data as Record<string, unknown> | undefined });
  }

  error(message: string, data?: unknown): void {
    this.events.push({ level: "error", message, data: data as Record<string, unknown> | undefined });
  }
}

async function connectPair(executor: { execute(name: string, input: Record<string, unknown>): Promise<unknown> }, logger: MemoryLogger) {
  const server = createMcpServer(executor, logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "observability-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { server, client };
}

describe("MCP lifecycle observability", () => {
  test("keeps server identity and tool catalog stable across server instances", () => {
    const first = createMcpServer({ execute: async () => ({}) });
    const second = createMcpServer({ execute: async () => ({}) });

    expect(MCP_SERVER_INFO).toEqual({ name: "desktop-remote", version: "1.0.0" });
    expect(getMcpLifecycleSnapshot(first).currentSchemaHash).toBe(
      getMcpLifecycleSnapshot(second).currentSchemaHash,
    );
    expect(getMcpLifecycleSnapshot(first).runtimeInstanceId).not.toBe(
      getMcpLifecycleSnapshot(second).runtimeInstanceId,
    );
    expect(computeMcpToolCatalogHash(createToolDefinitions().toReversed())).toBe(
      computeMcpToolCatalogHash(createToolDefinitions()),
    );
    expect(createToolDefinitions().map((tool) => tool.name)).toEqual(
      [...createToolDefinitions().map((tool) => tool.name)].sort(),
    );
  });

  test("observes initialize, tools/list, and tools/call even when the host executor is unavailable", async () => {
    const logger = new MemoryLogger();
    const { server, client } = await connectPair({
      execute: async () => { throw new Error("host unavailable"); },
    }, logger);

    try {
      expect(client.getServerVersion()).toEqual(MCP_SERVER_INFO);
      await client.listTools();
      const result = await client.callTool({ name: "get_config", arguments: { secret: "never-log" } });
      expect(result.isError).toBe(true);

      const snapshot = getMcpLifecycleSnapshot(server);
      const runtimeInstanceId = snapshot.runtimeInstanceId;
      expect(snapshot).toMatchObject({
        initializeCount: 1,
        toolsListCount: 1,
        toolsCallCount: 1,
        activeRequests: 0,
        currentSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeInstanceId: expect.any(String),
      });
      expect(snapshot.lastInitializeAt).toBeTypeOf("number");
      expect(snapshot.lastToolsListAt).toBeTypeOf("number");
      expect(snapshot.lastToolsCallAt).toBeTypeOf("number");

      const arrivals = logger.events.filter((event) => event.message === "mcp.lifecycle.request.arrival");
      const failures = logger.events.filter((event) => event.message === "mcp.lifecycle.request.failure");
      expect(arrivals.map((event) => event.data?.method)).toEqual([
        "initialize",
        "tools/list",
        "tools/call",
      ]);
      expect(failures.at(-1)?.data).toMatchObject({ method: "tools/call", toolName: "get_config" });
      expect(failures.at(-1)?.data?.runtimeInstanceId).toBe(runtimeInstanceId);
      expect(failures.at(-1)?.data?.connectionId).toEqual(arrivals.at(-1)?.data?.connectionId);

      const serialized = JSON.stringify(logger.events);
      expect(serialized).not.toContain("never-log");
      expect(serialized).not.toContain("arguments");
      expect(serialized).not.toContain("result");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("tracks an active tool call until its protocol response arrives", async () => {
    const logger = new MemoryLogger();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { server, client } = await connectPair({
      execute: async () => { await blocked; return validConfig; },
    }, logger);

    try {
      const call = client.callTool({ name: "get_config", arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getMcpLifecycleSnapshot(server).activeRequests).toBe(1);
      expect(logger.events.some((event) => event.message === "mcp.lifecycle.request.arrival" && event.data?.method === "tools/call")).toBe(true);

      release();
      await call;
      expect(getMcpLifecycleSnapshot(server).activeRequests).toBe(0);
      expect(logger.events.some((event) => event.message === "mcp.lifecycle.request.completion" && event.data?.method === "tools/call")).toBe(true);
    } finally {
      release();
      await client.close();
      await server.close();
    }
  });

  test("does not make protocol availability depend on an async logger", async () => {
    const logger = {
      info: async () => { throw new Error("log sink unavailable"); },
      warn: async () => { throw new Error("log sink unavailable"); },
      error: async () => { throw new Error("log sink unavailable"); },
    };
    const server = createMcpServer({ execute: async () => validConfig }, logger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "logger-failure-test", version: "1.0.0" });

    try {
      await client.connect(clientTransport);
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      await expect(client.callTool({ name: "get_config", arguments: {} })).resolves.toMatchObject({
        content: expect.any(Array),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
