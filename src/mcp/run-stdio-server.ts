import { redactText } from "../logging/redactor";

export interface McpLifecycleLogger {
  info(message: string, data?: unknown): Promise<void>;
  warn(message: string, data?: unknown): Promise<void>;
  error(message: string, data?: unknown): Promise<void>;
}

export interface McpConnectable<TTransport> {
  connect(transport: TTransport): Promise<void>;
}

export interface RunMcpStdioServerOptions<TTransport> {
  server: McpConnectable<TTransport>;
  transport: TTransport;
  logger: McpLifecycleLogger;
  pid?: number;
  ppid?: number;
}

export async function runMcpStdioServer<TTransport>(
  options: RunMcpStdioServerOptions<TTransport>,
): Promise<void> {
  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  await options.logger.info("mcp process starting", { pid, ppid });

  try {
    await options.server.connect(options.transport);
    await options.logger.info("mcp stdio transport connected", { pid });
  } catch (error) {
    await options.logger.error("mcp stdio transport failed", {
      pid,
      error: safeError(error),
    });
    throw error;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message).slice(0, 512);
}
