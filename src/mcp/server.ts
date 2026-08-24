import { McpServer } from "@modelcontextprotocol/server";
import { createOperationHandler, type OperationExecutor } from "./handler";
import { createToolDefinitions } from "./tools";

export function createMcpServer(executor: OperationExecutor): McpServer {
  const server = new McpServer({ name: "desktop-remote", version: "1.0.0" });
  const handleOperation = createOperationHandler(executor);

  for (const tool of createToolDefinitions()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (input) => ({
      ...(await handleOperation(tool.name, input as Record<string, unknown>)),
      resultType: "success" as const,
    }));
  }

  return server;
}
