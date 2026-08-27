import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../src/mcp/server";

const never = new Promise<never>(() => {});

const executor = {
  execute: async (name: string) => {
    if (name === "get_usage_stats") return never;
    if (name === "hang_forever") return never;
    if (name === "get_config") {
      return {
        blockedCommands: [],
        defaultShell: "/bin/sh",
        allowedDirectories: [],
        fileReadLineLimit: 1000,
        fileWriteLineLimit: 1000,
        telemetryEnabled: false,
      };
    }
    return { name, ok: true };
  },
};

async function connectPair() {
  const server = createMcpServer(executor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { server, client };
}

describe("MCP SDK concurrency", () => {
  test("una operacion que nunca resuelve NO bloquea otras requests del mismo servidor", async () => {
    const { server, client } = await connectPair();
    try {
      const hanging = client.callTool({ name: "get_usage_stats", arguments: {} }).catch(() => {});
      const cfg = await client.callTool({ name: "get_config", arguments: {} });
      expect(cfg.isError).not.toBe(true);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      await expect(Promise.race([hanging, Promise.resolve("pending")])).resolves.toBe("pending");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("regresion: operation A cuelga, operation B funciona, MCP sigue vivo", async () => {
    const { server, client } = await connectPair();
    try {
      const hanging = client.callTool({ name: "get_usage_stats", arguments: {} }).catch(() => {});
      const b = await client.callTool({ name: "get_config", arguments: {} });
      expect(b.isError).not.toBe(true);
      const c = await client.callTool({ name: "get_config", arguments: {} });
      expect(c.isError).not.toBe(true);
      await expect(Promise.race([hanging, Promise.resolve("pending")])).resolves.toBe("pending");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
