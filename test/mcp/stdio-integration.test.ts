import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = new URL("../../", import.meta.url).pathname;

describe("Desktop Remote MCP over stdio", () => {
  test("initializes, advertises ChatGPT metadata, lists tools, and calls a tool", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", "test/fixtures/mcp-stdio-server.ts"],
      cwd: root,
      stderr: "pipe",
    });
    const client = new Client({ name: "desktop-remote-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("local computer");

      const { tools } = await client.listTools();
      expect(tools).toHaveLength(24);
      expect(tools.find((tool) => tool.name === "read_file")).toMatchObject({
        title: "Read file",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      });
      expect(tools.find((tool) => tool.name === "get_config")?.outputSchema).toBeDefined();

      const result = await client.callTool({ name: "get_config", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ blockedCommands: [], defaultShell: "/bin/sh", allowedDirectories: [], fileReadLineLimit: 1000, fileWriteLineLimit: 1000, telemetryEnabled: false });
    } finally {
      await client.close();
    }
  });
});
