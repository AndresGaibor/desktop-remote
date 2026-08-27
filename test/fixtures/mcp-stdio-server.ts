import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../../src/mcp/server";

const server = createMcpServer({
  execute: async (name, input) => {
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
    return { name, input, ok: true };
  },
}, undefined, "linux");

await server.connect(new StdioServerTransport());
