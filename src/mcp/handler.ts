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

export interface ConcurrencyOptions {
  maxConcurrentOperations?: number;
  queueTimeoutMs?: number;
  responseBudget?: ResponseBudget;
}

const REQUEST_WARN_THRESHOLD_MS = 5_000;
const MAX_TEXT_CONTENT_BYTES = 16_000;
const DEFAULT_MAX_CONCURRENT = 8;
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
) {
  const maxConcurrent = opts?.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT;
  const queueTimeoutMs = opts?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const responseBudget = opts?.responseBudget ?? DEFAULT_RESPONSE_BUDGET;

  let activeRequests = 0;

  type QueuedOperation = {
    resolve: (started: boolean) => void;
    deadlineTimer: ReturnType<typeof setTimeout>;
    started: boolean;
  };

  const queue: QueuedOperation[] = [];

  const safeLog = (level: "info" | "warn" | "error", message: string, data?: unknown) => {
    try {
      logger?.[level]?.(message, data);
    } catch {
      // La telemetría nunca debe convertirse en una dependencia de disponibilidad del MCP.
    }
  };

  function startNextFromQueue() {
    while (activeRequests < maxConcurrent && queue.length > 0) {
      const q = queue.shift()!;
      clearTimeout(q.deadlineTimer);
      if (!q.started) {
        q.started = true;
        activeRequests++;
        q.resolve(true);
      }
    }
  }

  function releaseSlot() {
    activeRequests = Math.max(0, activeRequests - 1);
    startNextFromQueue();
  }

  async function acquireSlot(deadlineMs: number): Promise<boolean> {
    if (activeRequests < maxConcurrent) {
      activeRequests++;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const deadlineTimer = setTimeout(() => {
        const idx = queue.findIndex((q) => q.resolve === resolve);
        if (idx !== -1) {
          queue.splice(idx, 1);
          resolve(false);
        }
      }, deadlineMs);

      const q: QueuedOperation = {
        resolve,
        deadlineTimer,
        started: false,
      };

      queue.push(q);
    });
  }

  return async (name: string, input: Record<string, unknown>): Promise<McpToolResult> => {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const canStart = await acquireSlot(queueTimeoutMs);

    if (!canStart) {
      safeLog("warn", "mcp.request.start", {
        traceId,
        method: "tools/call",
        toolName: name,
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
      activeRequests,
    });

    const warnTimer = setTimeout(() => {
      safeLog("warn", "mcp.request.warn", {
        traceId,
        toolName: name,
        durationMs: Date.now() - startedAt,
        activeRequests,
      });
    }, REQUEST_WARN_THRESHOLD_MS);

    try {
      const result = await executor.execute(name, input, { traceId });
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
        activeRequests: activeRequests - 1,
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
        activeRequests: activeRequests - 1,
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
}
