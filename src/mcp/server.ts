import { McpServer } from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import {
  createOperationHandler,
  type McpBackpressureSnapshot,
  type McpRequestLogger,
  type OperationExecutor,
  type OperationHandler,
} from "./handler";
import { computeMcpToolCatalogHash, createToolDefinitions } from "./tools";

export const MCP_SERVER_INFO = { name: "desktop-remote", version: "1.0.0" } as const;

export interface McpLifecycleSnapshot {
  runtimeInstanceId: string;
  connectionId?: string;
  currentSchemaHash: string;
  initializeCount: number;
  toolsListCount: number;
  toolsCallCount: number;
  toolsCallSuccessCount: number;
  toolsCallFailureCount: number;
  activeRequests: number;
  lastInitializeAt?: number;
  lastToolsListAt?: number;
  lastToolsCallAt?: number;
  backpressure?: McpBackpressureSnapshot;
}

interface McpLifecycleState extends Omit<McpLifecycleSnapshot, "backpressure"> {
  connectionSequence: number;
}

type RequestHandler = (request: unknown, context: unknown) => unknown | Promise<unknown>;
type McpProtocolInternals = {
  _requestHandlers: Map<string, RequestHandler>;
};

const lifecycleStates = new WeakMap<McpServer, McpLifecycleState>();
const operationHandlers = new WeakMap<McpServer, OperationHandler>();

const SERVER_INSTRUCTIONS =
  "Desktop Remote controls the user's authorized local computer. Prefer read-only inspection before changes. " +
  "Use filesystem tools for local files, search tools for discovery, and process tools only when command execution is needed. " +
  "Do not claim a command or file change succeeded unless the tool result confirms it.";

export function createMcpServer(executor: OperationExecutor, logger?: McpRequestLogger, platform?: string): McpServer {
  const server = new McpServer(
    MCP_SERVER_INFO,
    { instructions: SERVER_INSTRUCTIONS },
  );
  const handleOperation = createOperationHandler(executor, logger);
  operationHandlers.set(server, handleOperation);

  for (const tool of createToolDefinitions(platform)) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }, async (input, context) => ({
      ...(await handleOperation(tool.name, input as Record<string, unknown>, {
        requesterId: typeof context.sessionId === "string" ? context.sessionId : undefined,
      })),
      resultType: "success" as const,
    }));
  }

  instrumentLifecycle(server, logger);

  return server;
}

export function getMcpLifecycleSnapshot(server: McpServer): McpLifecycleSnapshot {
  const state = lifecycleStates.get(server);
  if (!state) throw new Error("MCP server is not instrumented");
  const { connectionSequence: _connectionSequence, ...snapshot } = state;
  const backpressure = operationHandlers.get(server)?.getBackpressureSnapshot();
  return { ...snapshot, ...(backpressure ? { backpressure } : {}) };
}

function instrumentLifecycle(server: McpServer, logger?: McpRequestLogger): void {
  const tools = createToolDefinitions();
  const state: McpLifecycleState = {
    runtimeInstanceId: randomUUID(),
    currentSchemaHash: computeMcpToolCatalogHash(tools),
    initializeCount: 0,
    toolsListCount: 0,
    toolsCallCount: 0,
    toolsCallSuccessCount: 0,
    toolsCallFailureCount: 0,
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
    const requesterFingerprint = fingerprintRequester(context);
    const eventData = () => ({
      ...lifecycleData(state),
      method,
      ...(toolName ? { toolName } : {}),
      ...(requesterFingerprint ? { requesterFingerprint } : {}),
    });
    safeLog(logger, "info", "mcp.lifecycle.request.arrival", eventData());

    try {
      const result = await original(request, context);
      if (method === "tools/call") {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        if (isToolError(result)) state.toolsCallFailureCount += 1;
        else state.toolsCallSuccessCount += 1;
      }
      if (isToolError(result)) safeLog(logger, "warn", "mcp.lifecycle.request.failure", eventData());
      else safeLog(logger, "info", "mcp.lifecycle.request.completion", eventData());
      return result;
    } catch (error) {
      if (method === "tools/call") {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
        state.toolsCallFailureCount += 1;
      }
      safeLog(logger, "error", "mcp.lifecycle.request.failure", {
        ...eventData(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
    initializeCount: state.initializeCount,
    toolsListCount: state.toolsListCount,
    toolsCallCount: state.toolsCallCount,
    toolsCallSuccessCount: state.toolsCallSuccessCount,
    toolsCallFailureCount: state.toolsCallFailureCount,
    activeRequests: state.activeRequests,
    ...(state.lastInitializeAt !== undefined ? { lastInitializeAt: state.lastInitializeAt } : {}),
    ...(state.lastToolsListAt !== undefined ? { lastToolsListAt: state.lastToolsListAt } : {}),
    ...(state.lastToolsCallAt !== undefined ? { lastToolsCallAt: state.lastToolsCallAt } : {}),
  };
}

function extractToolName(request: unknown): string | undefined {
  const name = (request as { params?: { name?: unknown } }).params?.name;
  return typeof name === "string" ? name : undefined;
}

function fingerprintRequester(context: unknown): string | undefined {
  const sessionId = (context as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
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
