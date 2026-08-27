import { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createOperationHandler, type McpRequestLogger, type OperationExecutor } from "./handler";
import { computeMcpToolCatalogHash, createToolDefinitions } from "./tools";

export const MCP_SERVER_INFO = { name: "desktop-remote", version: "1.0.0" } as const;

export interface McpLifecycleSnapshot {
  runtimeInstanceId: string;
  currentSchemaHash: string;
  initializeCount: number;
  toolsListCount: number;
  toolsCallCount: number;
  activeRequests: number;
  lastInitializeAt?: number;
  lastToolsListAt?: number;
  lastToolsCallAt?: number;
}

interface McpLifecycleState extends McpLifecycleSnapshot {
  connectionId?: string;
  connectionSequence: number;
}

type RequestHandler = (request: unknown, context: unknown) => unknown | Promise<unknown>;
type McpProtocolInternals = {
  _requestHandlers: Map<string, RequestHandler>;
};

const lifecycleStates = new WeakMap<McpServer, McpLifecycleState>();

const SERVER_INSTRUCTIONS =
  "Desktop Remote controls the user's authorized local computer. Prefer read-only inspection before changes. " +
  "Use filesystem tools for local files, search tools for discovery, and process tools only when command execution is needed. " +
  "Do not claim a command or file change succeeded unless the tool result confirms it.";

export function createMcpServer(executor: OperationExecutor, logger?: McpRequestLogger): McpServer {
  const server = new McpServer(
    MCP_SERVER_INFO,
    { instructions: SERVER_INSTRUCTIONS },
  );
  const handleOperation = createOperationHandler(executor, logger);

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

  instrumentLifecycle(server, logger);

  return server;
}

export function getMcpLifecycleSnapshot(server: McpServer): McpLifecycleSnapshot {
  const state = lifecycleStates.get(server);
  if (!state) throw new Error("MCP server is not instrumented");
  const {
    connectionId: _connectionId,
    connectionSequence: _connectionSequence,
    ...snapshot
  } = state;
  return { ...snapshot };
}

function instrumentLifecycle(server: McpServer, logger?: McpRequestLogger): void {
  const tools = createToolDefinitions();
  const state: McpLifecycleState = {
    runtimeInstanceId: randomUUID(),
    currentSchemaHash: computeMcpToolCatalogHash(tools),
    initializeCount: 0,
    toolsListCount: 0,
    toolsCallCount: 0,
    activeRequests: 0,
    connectionSequence: 0,
  };
  lifecycleStates.set(server, state);

  const handlers = (server.server as unknown as McpProtocolInternals)._requestHandlers;
  for (const method of ["initialize", "tools/list", "tools/call"] as const) {
    const original = handlers.get(method);
    if (!original) throw new Error(`MCP SDK did not register ${method}`);
    handlers.set(method, wrapRequestHandler(method, original, state, logger));
  }

  const connect = server.connect.bind(server);
  server.connect = async (...args) => {
    state.connectionSequence += 1;
    state.connectionId = `${state.runtimeInstanceId}:${state.connectionSequence}`;
    safeLog(logger, "info", "mcp.lifecycle.transport.start", lifecycleData(state));
    try {
      await connect(...args);
      safeLog(logger, "info", "mcp.lifecycle.transport.connected", lifecycleData(state));
    } catch (error) {
      safeLog(logger, "error", "mcp.lifecycle.transport.failure", {
        ...lifecycleData(state),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const close = server.close.bind(server);
  server.close = async () => {
    safeLog(logger, "info", "mcp.lifecycle.transport.stop", lifecycleData(state));
    await close();
  };
}

function wrapRequestHandler(
  method: "initialize" | "tools/list" | "tools/call",
  original: RequestHandler,
  state: McpLifecycleState,
  logger?: McpRequestLogger,
): RequestHandler {
  return async (request, context) => {
    const now = Date.now();
    incrementMethod(state, method, now);
    if (method === "tools/call") state.activeRequests += 1;
    const toolName = method === "tools/call" ? extractToolName(request) : undefined;
    const data = { ...lifecycleData(state), method, ...(toolName ? { toolName } : {}) };
    safeLog(logger, "info", "mcp.lifecycle.request.arrival", data);

    try {
      const result = await original(request, context);
      if (isToolError(result)) {
        safeLog(logger, "warn", "mcp.lifecycle.request.failure", data);
      } else {
        safeLog(logger, "info", "mcp.lifecycle.request.completion", data);
      }
      return result;
    } catch (error) {
      safeLog(logger, "error", "mcp.lifecycle.request.failure", {
        ...data,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (method === "tools/call") state.activeRequests = Math.max(0, state.activeRequests - 1);
    }
  };
}

function incrementMethod(state: McpLifecycleState, method: string, now: number): void {
  if (method === "initialize") {
    state.initializeCount += 1;
    state.lastInitializeAt = now;
  } else if (method === "tools/list") {
    state.toolsListCount += 1;
    state.lastToolsListAt = now;
  } else {
    state.toolsCallCount += 1;
    state.lastToolsCallAt = now;
  }
}

function lifecycleData(state: McpLifecycleState): Record<string, unknown> {
  return {
    runtimeInstanceId: state.runtimeInstanceId,
    connectionId: state.connectionId ?? `${state.runtimeInstanceId}:unconnected`,
    currentSchemaHash: state.currentSchemaHash,
  };
}

function extractToolName(request: unknown): string | undefined {
  const name = (request as { params?: { name?: unknown } }).params?.name;
  return typeof name === "string" ? name : undefined;
}

function isToolError(result: unknown): boolean {
  return (result as { isError?: unknown } | undefined)?.isError === true;
}

function safeLog(logger: McpRequestLogger | undefined, level: "info" | "warn" | "error", message: string, data: unknown): void {
  try {
    const result = logger?.[level]?.(message, data);
    Promise.resolve(result).catch(() => undefined);
  } catch {
    // La observabilidad no puede afectar el protocolo MCP.
  }
}
