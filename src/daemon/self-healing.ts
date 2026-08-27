import type { OperationExecutionOptions, OperationExecutor } from "../mcp/handler";
import { ProcessManager } from "../process/manager";

export const DEFAULT_DEADLINE_MS = 20_000;
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;

export interface TrackedOperation {
  id: string;
  operationName: string;
  startedAt: number;
  deadline: number;
  childPid?: number;
  aborted: boolean;
}

export type WatchdogEventType = "operation.hung" | "operation.completed";

export interface WatchdogHungEvent {
  type: "operation.hung";
  operationId: string;
  operationName: string;
  childPid?: number;
  startedAt: number;
  deadline: number;
  hungDurationMs: number;
}

export interface WatchdogCompletedEvent {
  type: "operation.completed";
  operationId: string;
  operationName: string;
  durationMs: number;
}

export type WatchdogEvent = WatchdogHungEvent | WatchdogCompletedEvent;

export interface OperationDeadlineTrackerOptions {
  deadlineMs?: number;
  now?: () => number;
}

export class OperationDeadlineTracker {
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly operations = new Map<string, TrackedOperation>();

  constructor(options: OperationDeadlineTrackerOptions = {}) {
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = options.now ?? Date.now;
  }

  track(id: string, operationName: string, startedAt: number, childPid?: number): TrackedOperation {
    const operation: TrackedOperation = {
      id,
      operationName,
      startedAt,
      deadline: startedAt + this.deadlineMs,
      childPid,
      aborted: false,
    };
    this.operations.set(id, operation);
    return operation;
  }

  get(id: string): TrackedOperation | undefined {
    return this.operations.get(id);
  }

  remove(id: string): void {
    this.operations.delete(id);
  }

  abort(id: string): boolean {
    const op = this.operations.get(id);
    if (!op) return false;
    op.aborted = true;
    return true;
  }

  isExpired(id: string): boolean {
    const op = this.operations.get(id);
    if (!op || op.aborted) return false;
    return this.now() >= op.deadline;
  }

  list(): TrackedOperation[] {
    return [...this.operations.values()];
  }

  clear(): void {
    this.operations.clear();
  }
}

export interface SelfHealingExecutorOptions {
  executor: OperationExecutor;
  deadlineMs?: number;
  watchdogIntervalMs?: number;
  now?: () => number;
  processManager?: ProcessManager;
}

export class SelfHealingExecutor {
  private readonly executor: OperationExecutor;
  private readonly deadlineMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly now: () => number;
  private readonly processManager: ProcessManager;
  private readonly tracker: OperationDeadlineTracker;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private readonly watchdogListeners = new Set<(event: WatchdogEvent) => void>();
  private opCounter = 0;

  constructor(options: SelfHealingExecutorOptions) {
    this.executor = options.executor;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.processManager = options.processManager ?? new ProcessManager();
    this.tracker = new OperationDeadlineTracker({
      deadlineMs: this.deadlineMs,
      now: this.now,
    });
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: OperationExecutionOptions,
  ): Promise<unknown> {
    const id = `op-${++this.opCounter}`;
    const startedAt = this.now();

    this.tracker.track(id, name, startedAt);
    this.startWatchdog();

    let hung = false;
    const executePromise = this.executor.execute(name, input, options).finally(() => {
      if (!hung) {
        this.tracker.remove(id);
        this.emitWatchdogEvent({
          type: "operation.completed",
          operationId: id,
          operationName: name,
          durationMs: this.now() - startedAt,
        });
        if (this.tracker.list().length === 0) {
          this.stopWatchdog();
        }
      }
    });

    const deadlineMs = this.deadlineMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (this.tracker.get(id) && !hung) {
          hung = true;
          this.abortOperation(id);
          reject(new Error(`Operation ${name} timed out after ${deadlineMs}ms`));
        }
      }, deadlineMs);
    });

    try {
      return await Promise.race([executePromise, timeoutPromise]);
    } catch (error) {
      if (hung) {
        throw error;
      }
      throw error;
    }
  }

  onWatchdogEvent(listener: (event: WatchdogEvent) => void): () => void {
    this.watchdogListeners.add(listener);
    return () => this.watchdogListeners.delete(listener);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkDeadlines(), this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private abortOperation(id: string): void {
    const op = this.tracker.get(id);
    if (!op) return;

    this.tracker.abort(id);

    if (op.childPid !== undefined) {
      void this.processManager.kill(op.childPid).catch(() => {});
    }

    this.emitWatchdogEvent({
      type: "operation.hung",
      operationId: id,
      operationName: op.operationName,
      childPid: op.childPid,
      startedAt: op.startedAt,
      deadline: op.deadline,
      hungDurationMs: this.now() - op.startedAt,
    });
  }

  private checkDeadlines(): void {
    const now = this.now();
    for (const op of this.tracker.list()) {
      if (op.aborted) continue;
      if (now >= op.deadline) {
        this.abortOperation(op.id);
      }
    }
  }

  private emitWatchdogEvent(event: WatchdogEvent): void {
    for (const listener of [...this.watchdogListeners]) {
      try {
        listener(event);
      } catch {
        // Watchdog listeners must never affect the executor.
      }
    }
  }
}