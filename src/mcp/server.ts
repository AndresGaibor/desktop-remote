import { McpServer } from "@modelcontextprotocol/server";
import { createOperationHandler, type OperationExecutor } from "./handler";
import { createToolDefinitions } from "./tools";

const SERVER_INSTRUCTIONS =
  "Desktop Remote controls the user's authorized local computer. Prefer read-only inspection before changes. " +
  "Use filesystem tools for local files, search tools for discovery, and process tools only when command execution is needed. " +
  "Do not claim a command or file change succeeded unless the tool result confirms it.";

export function createMcpServer(executor: OperationExecutor): McpServer {
  const server = new McpServer(
    { name: "desktop-remote", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const handleOperation = createOperationHandler(executor);

  for (const tool of createToolDefinitions()) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }, async (input) => ({      ...(await handleOperation(tool.name, input as Record<string, unknown>)),
      resultType: "success" as const,
    }));
  }

  return server;
}
