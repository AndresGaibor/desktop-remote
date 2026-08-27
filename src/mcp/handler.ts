import {
  boundResponse,
  DEFAULT_RESPONSE_BUDGET,
  estimateJsonBytes,
  serializeResponse,
  type ResponseBudget,
} from "../core/response-budget";

export interface OperationExecutionOptions {
  traceId?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface OperationExecutor {
  execute(name: string, input: Record<string, unknown>, options?: OperationExecutionOptions): Promise<unknown>;
}

export interface McpRequestLogger {
  info?(message: string, data?: unknown): void;
  warn?(message: string, data?: unknown): void;
  error?(message: string, data?: unknown): void;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: true;
}

export interface McpBackpressureSnapshot {
  active: number;
  activeLimit: number;
  queued: number;
  queueLimit: number;
  rejected: number;
  queueTimeouts: number;
}

export interface McpOperationRequestContext {
  requesterId?: string;
  signal?: AbortSignal;
}

export interface ConcurrencyOptions {
  maxConcurrentOperations?: number;
  maxQueuedOperations?: number;
  queueTimeoutMs?: number;
  responseBudget?: ResponseBudget;
}

export interface OperationHandler {
  (name: string, input: Record<string, unknown>, context?: McpOperationRequestContext): Promise<McpToolResult>;
  getBackpressureSnapshot(): McpBackpressureSnapshot;
}

const REQUEST_WARN_THRESHOLD_MS = 5_000;
const MAX_TEXT_CONTENT_BYTES = 16_000;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_QUEUED = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

export function createBoundedToolResult(result: unknown, responseBudget: ResponseBudget = {}): McpToolResult {
  if (result === undefined) return { content: [{ type: "text", text: "" }] };

  const budget = { ...DEFAULT_RESPONSE_BUDGET, ...responseBudget };
  const bounded = boundResponse(result, budget);
  const structuredContent = bounded.value;
  const fitsText = estimateJsonBytes(result, MAX_TEXT_CONTENT_BYTES) <= MAX_TEXT_CONTENT_BYTES && !bounded.truncated;
  const text = fitsText
    ? serializeResponse(result, { ...budget, maxBytes: MAX_TEXT_CONTENT_BYTES })
    : "Result is available in bounded structuredContent; use pagination or cursors for more data.";
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function createOperationHandler(
  executor: OperationExecutor,
  logger?: McpRequestLogger,
  opts?: ConcurrencyOptions,
): OperationHandler {
  const maxConcurrent = Math.max(1, opts?.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT);
  const maxQueued = Math.max(0, opts?.maxQueuedOperations ?? DEFAULT_MAX_QUEUED);
  const queueTimeoutMs = Math.max(1, opts?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
  const responseBudget = opts?.responseBudget ?? DEFAULT_RESPONSE_BUDGET;

  let activeRequests = 0;
  let rejectedRequests = 0;
  let queueTimeouts = 0;
  let lastDequeuedRequester: string | undefined;

  type QueuedOperation = {
    id: string;
    requesterId: string;
    resolve: (result: AcquireResult) => void;
    deadlineTimer: ReturnType<typeof setTimeout>;
    started: boolean;
  };
  type AcquireResult = "started" | "timeout" | "rejected";

  const queue: QueuedOperation[] = [];

  const safeLog = (level: "info" | "warn" | "error", message: string, data?: unknown) => {
    try {
      const pending = logger?.[level]?.(message, data);
      Promise.resolve(pending).catch(() => undefined);
    } catch {
      // La telemetría nunca debe convertirse en una dependencia de disponibilidad del MCP.
    }
  };

  const snapshot = (): McpBackpressureSnapshot => ({
    active: activeRequests,
    activeLimit: maxConcurrent,
    queued: queue.length,
    queueLimit: maxQueued,
    rejected: rejectedRequests,
    queueTimeouts,
  });

  const logBackpressure = (reason: string) => {
    safeLog("info", "mcp.backpressure.state", { ...snapshot(), reason });
  };

  function nextQueueIndex(): number {
    if (queue.length === 0) return -1;
    if (lastDequeuedRequester === undefined) return 0;
    const alternate = queue.findIndex((item) => item.requesterId !== lastDequeuedRequester);
    return alternate >= 0 ? alternate : 0;
  }

  function startNextFromQueue() {
    while (activeRequests < maxConcurrent && queue.length > 0) {
      const index = nextQueueIndex();
      if (index < 0) return;
      const [queued] = queue.splice(index, 1);
      if (!queued) return;
      clearTimeout(queued.deadlineTimer);
      if (queued.started) continue;
      queued.started = true;
      lastDequeuedRequester = queued.requesterId;
      activeRequests++;
      queued.resolve("started");
      logBackpressure("dequeued");
    }
  }

  function releaseSlot() {
    activeRequests = Math.max(0, activeRequests - 1);
    startNextFromQueue();
    logBackpressure("released");
  }

  async function acquireSlot(deadlineMs: number, requesterId: string): Promise<AcquireResult> {
    if (activeRequests < maxConcurrent) {
      activeRequests++;
      logBackpressure("acquired");
      return "started";
    }

    if (queue.length >= maxQueued) {
      rejectedRequests++;
      logBackpressure("rejected");
      return "rejected";
    }

    return new Promise<AcquireResult>((resolve) => {
      const id = crypto.randomUUID();
      const deadlineTimer = setTimeout(() => {
        const index = queue.findIndex((item) => item.id === id);
        if (index === -1) return;
        queue.splice(index, 1);
        queueTimeouts++;
        resolve("timeout");
        logBackpressure("queue-timeout");
      }, deadlineMs);

      queue.push({ id, requesterId, resolve, deadlineTimer, started: false });
      logBackpressure("queued");
    });
  }

  const handler: OperationHandler = async (
    name: string,
    input: Record<string, unknown>,
    context: McpOperationRequestContext = {},
  ): Promise<McpToolResult> => {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const requesterId = context.requesterId?.trim() || "anonymous";
    const acquireResult = await acquireSlot(queueTimeoutMs, requesterId);

    if (acquireResult === "rejected") {
      safeLog("warn", "mcp.request.rejected", {
        traceId,
        method: "tools/call",
        toolName: name,
        ...snapshot(),
        activeRequests,
        reason: "queue-full",
      });
      return {
        content: [{ type: "text", text: "MCP_BUSY: operation queue is full. Try again later." }],
        isError: true,
      };
    }

    if (acquireResult === "timeout") {
      safeLog("warn", "mcp.request.start", {
        traceId,
        method: "tools/call",
        toolName: name,
        ...snapshot(),
        activeRequests,
        reason: "queue-timeout",
      });
      return {
        content: [{ type: "text", text: "Operation queued for too long: queue timeout exceeded. Try again later." }],
        isError: true,
      };
    }

    safeLog("info", "mcp.request.start", {
      traceId,
      method: "tools/call",
      toolName: name,
      ...snapshot(),
      activeRequests,
    });

    const warnTimer = setTimeout(() => {
      safeLog("warn", "mcp.request.warn", {
        traceId,
        toolName: name,
        durationMs: Date.now() - startedAt,
        ...snapshot(),
        activeRequests,
      });
    }, REQUEST_WARN_THRESHOLD_MS);

    try {
      const result = await executor.execute(name, input, { traceId, signal: context.signal });
      const durationMs = Date.now() - startedAt;
      const toolResult = createBoundedToolResult(result, responseBudget);
      const responseBytes = toolResult.structuredContent === undefined
        ? 0
        : estimateJsonBytes(toolResult.structuredContent);
      safeLog("info", "mcp.request.end", {
        traceId,
        toolName: name,
        durationMs,
        responseBytes,
        activeRequests: Math.max(0, activeRequests - 1),
      });
      return toolResult;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const eventName = /^Desktop Remote operation timed out after \d+ms$/.test(errorMessage)
        ? "mcp.request.timeout"
        : "mcp.request.error";
      safeLog("error", eventName, {
        traceId,
        toolName: name,
        durationMs,
        activeRequests: Math.max(0, activeRequests - 1),
        error: errorMessage,
      });
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    } finally {
      clearTimeout(warnTimer);
      releaseSlot();
    }
  };

  handler.getBackpressureSnapshot = snapshot;
  return handler;
}
