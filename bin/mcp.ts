import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { OperationIpcClient } from "../src/client/operation-ipc-client";
import { createMcpServer } from "../src/mcp/server";
import { getDesktopRemotePaths } from "../src/platform/paths";

const server = createMcpServer(new OperationIpcClient(getDesktopRemotePaths().socketPath));
await server.connect(new StdioServerTransport());
