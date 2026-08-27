import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { OperationIpcClient } from "../src/client/operation-ipc-client";
import { RotatingDaemonLog } from "../src/logging/rotating-log";
import { runMcpStdioServer } from "../src/mcp/run-stdio-server";
import { createMcpServer } from "../src/mcp/server";
import { getDesktopRemotePaths } from "../src/platform/paths";

const paths = getDesktopRemotePaths();
const logger = new RotatingDaemonLog(join(paths.logsDir, "mcp.log"));
const server = createMcpServer(new OperationIpcClient(paths.socketPath), logger);
await runMcpStdioServer({ server, transport: new StdioServerTransport(), logger });
