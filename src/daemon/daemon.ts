import type { RuntimeEvent } from "../runtime/events";
import { boundRuntimeEvent } from "../session/bounds";
import { RuntimeSessionStore } from "../session/runtime-store";
import { HistoryStore } from "./history-store";
import type { RuntimeSessionSnapshot } from "../session/types";
import type { SupervisorStatus } from "./supervisor";
import type { OperationExecutionOptions, OperationExecutor } from "../mcp/handler";
import type { WatchdogHungEvent } from "./self-healing";
import { getRuntimeContractIdentity } from "../runtime/contract";

export interface SupervisorController {
  start(): void;
  stop(): Promise<void>;
  status(): SupervisorStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  onStatus?(listener: (status: SupervisorStatus) => void): () => void;
}

export interface DaemonLogger {
  info(message: string, data?: unknown): Promise<void>;
  warn(message: string, data?: unknown): Promise<void>;
  error(message: string, data?: unknown): Promise<void>;
}

export interface DaemonStatus extends SupervisorStatus {
  retainedCalls: number;
  buildId?: string;
  operationContractHash?: string;
  protocolVersion?: number;
}
export interface DesktopRemoteDaemonOptions {
  supervisor: SupervisorController;
  store?: RuntimeSessionStore;
  history?: HistoryStore;
  logger?: DaemonLogger;
  operationExecutor?: OperationExecutor;
}

export class DesktopRemoteDaemon {
  private readonly supervisor: SupervisorController;
  private readonly store: RuntimeSessionStore;
  private readonly history: HistoryStore | undefined;
  private readonly logger: DaemonLogger | undefined;
  private readonly operationExecutor: OperationExecutor | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribeSupervisor: (() => void) | undefined;
  private unsubscribeSupervisorStatus: (() => void) | undefined;
  private started = false;
  private persistenceWarningLogged = false;
  private lastLoggedSupervisorState: SupervisorStatus["state"] | undefined;
  private lastLoggedRestartCount = 0;

  constructor(options: DesktopRemoteDaemonOptions) {
    this.supervisor = options.supervisor;
    this.store = options.store ?? new RuntimeSessionStore();
    this.history = options.history;
    this.logger = options.logger;
    this.operationExecutor = options.operationExecutor;
  }

  start(): void | Promise<void> {
    if (this.started) return;
    this.started = true;
    this.persistenceWarningLogged = false;
    this.lastLoggedSupervisorState = undefined;
    this.lastLoggedRestartCount = 0;
    this.log("info", "daemon.starting");
    if (this.history) {
      return this.history.loadInto(this.store)
        .catch((error) => this.logPersistenceWarning(error))
        .then(() => {
          if (!this.started) return;
          this.startSupervisor();
        });
    }
    this.startSupervisor();
  }

  private startSupervisor(): void {
    this.lastLoggedSupervisorState = undefined;
    this.lastLoggedRestartCount = 0;
    this.unsubscribeSupervisor = this.supervisor.onEvent((event) => this.consume(event));
    this.unsubscribeSupervisorStatus = this.supervisor.onStatus?.((status) => this.handleStatus(status));
    try {
      this.supervisor.start();
      this.log("info", "daemon.started");
    } catch (error) {
      this.detachSupervisor();
      this.started = false;
      this.log("error", "daemon start failed", errorData(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.detachSupervisor();
    await this.supervisor.stop();
    await this.logAsync("info", "daemon.stopped");
  }

  snapshot(): RuntimeSessionSnapshot {
    return this.store.snapshot();
  }

  status(): DaemonStatus {
    const identity = getRuntimeContractIdentity();
    return {
      ...this.supervisor.status(),
      retainedCalls: this.store.snapshot().counts.total,
      buildId: identity.buildId,
      operationContractHash: identity.operationContractHash,
      protocolVersion: identity.protocolVersion,
    };
  }
  async execute(name: string, input: Record<string, unknown>, options?: OperationExecutionOptions): Promise<unknown> {
    if (!this.operationExecutor) throw new Error("Daemon operation executor is unavailable");

    const callId = options?.callId ?? `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    this.consume({
      type: "tool.started",
      callId,
      toolName: name,
      args: input,
      metadata: { source: "mcp" },
      startedAt,
    });

    try {
      const result = await this.operationExecutor.execute(name, input, options);
      this.consume({
        type: "tool.completed",
        callId,
        toolName: name,
        resultText: serializeActivityResult(result),
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.consume({
        type: "tool.failed",
        callId,
        toolName: name,
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  consumeWatchdogEvent(event: WatchdogHungEvent): void {
    if (!this.started) return;
    const runtimeError: RuntimeEvent = {
      type: "runtime.error",
      message: `Operation ${event.operationName} hung for ${event.hungDurationMs}ms (deadline: ${event.deadline})`,
      at: Date.now(),
    };
    this.consume(runtimeError);
  }

  private consume(rawEvent: RuntimeEvent): void {
    const event = boundRuntimeEvent(rawEvent);
    this.store.consume(event);
    if (this.history) {
      void this.history.append(event, this.store.snapshot()).catch((error) => {
        this.logPersistenceWarning(error);
      });
    }
    if (event.type === "auth.required") {
      this.log("warn", "authentication required", { expiresIn: event.expiresIn });
    } else if (event.type === "runtime.error") {
      this.log("error", "runtime error", { message: event.message });
    } else if (event.type === "runtime.exited") {
      this.log("warn", "runtime exited", { code: event.code, signal: event.signal });
    } else if (event.type === "device.ready") {
      this.log("info", "remote device ready", { deviceName: event.deviceName });
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Telemetry observers are isolated from the daemon lifetime.
      }
    }
  }

  private handleStatus(status: SupervisorStatus): void {
    if (this.lastLoggedSupervisorState !== status.state) {
      this.log(status.state === "degraded" || status.state === "recovering" ? "warn" : "info",
        "supervisor state changed", {
          state: status.state,
          childPid: status.childPid,
          restartCount: status.restartCount,
          consecutiveFailures: status.consecutiveFailures,
          lastRestartAt: status.lastRestartAt,
        });
      this.lastLoggedSupervisorState = status.state;
    }
    if (status.restartCount > this.lastLoggedRestartCount) {
      this.lastLoggedRestartCount = status.restartCount;
      this.log("warn", "supervisor restarted runtime", {
        restartCount: status.restartCount,
        lastRestartAt: status.lastRestartAt,
      });
    }
  }

  private logPersistenceWarning(error: unknown): void {
    if (this.persistenceWarningLogged) return;
    this.persistenceWarningLogged = true;
    this.log("warn", "daemon persistence warning", errorData(error));
  }

  private detachSupervisor(): void {
    this.unsubscribeSupervisor?.();
    this.unsubscribeSupervisor = undefined;
    this.unsubscribeSupervisorStatus?.();
    this.unsubscribeSupervisorStatus = undefined;
  }

  private log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
    void this.logAsync(level, message, data);
  }

  private async logAsync(level: "info" | "warn" | "error", message: string, data?: unknown): Promise<void> {
    try {
      await this.logger?.[level](message, data);
    } catch {
      // Los fallos del logger no deben afectar la vida del daemon.
    }
  }
}

function errorData(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

function serializeActivityResult(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
