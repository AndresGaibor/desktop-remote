import type { RuntimeEvent } from "../runtime/events";
import { sleep } from "../platform/runtime";
import { RestartPolicy } from "./restart-policy";

export type SupervisorState =
  | "starting"
  | "auth"
  | "online"
  | "recovering"
  | "degraded"
  | "stopped";

export interface SupervisorStatus {
  state: SupervisorState;
  childPid?: number;
  restartCount: number;
  consecutiveFailures: number;
  startedAt: number;
  lastRestartAt?: number;
}

export interface ManagedRuntime {
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  start(): void;
  stop(): Promise<void>;
  readonly pid: number | undefined;
  readonly running: boolean;
}
export interface DaemonSupervisorOptions {
  createRuntime: () => ManagedRuntime;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  restartPolicy?: RestartPolicy;
}

export class DaemonSupervisor {
  private readonly createRuntime: () => ManagedRuntime;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly restartPolicy: RestartPolicy;
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly statusListeners = new Set<(status: SupervisorStatus) => void>();
  private current: ManagedRuntime | undefined;
  private unsubscribeCurrent: (() => void) | undefined;
  private state: SupervisorState = "stopped";
  private desiredRunning = false;
  private lifecycleGeneration = 0;
  private runtimeStartedAt = 0;
  private startedAt = 0;
  private restartCount = 0;
  private lastRestartAt: number | undefined;

  constructor(options: DaemonSupervisorOptions) {
    this.createRuntime = options.createRuntime;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.restartPolicy = options.restartPolicy ?? new RestartPolicy();
  }

  start(): void {
    if (this.desiredRunning) return;
    this.desiredRunning = true;
    this.lifecycleGeneration += 1;
    this.restartPolicy.reset();
    this.restartCount = 0;
    this.lastRestartAt = undefined;
    this.startedAt = this.now();
    this.startRuntime(false);
  }

  async stop(): Promise<void> {
    if (!this.desiredRunning && this.state === "stopped") return;
    this.desiredRunning = false;
    this.lifecycleGeneration += 1;
    this.state = "stopped";
    this.emitStatus();

    const runtime = this.current;
    this.detachCurrent();
    if (runtime) await runtime.stop();
  }

  status(): SupervisorStatus {
    const policy = this.restartPolicy.snapshot();
    return {
      state: this.state,
      childPid: this.current?.pid,
      restartCount: this.restartCount,
      consecutiveFailures: policy.consecutiveFailures,
      startedAt: this.startedAt,
      lastRestartAt: this.lastRestartAt,
    };
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: SupervisorStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private startRuntime(isRestart: boolean): void {
    if (!this.desiredRunning || this.current) return;
    const runtime = this.createRuntime();
    this.current = runtime;
    this.runtimeStartedAt = this.now();
    this.unsubscribeCurrent = runtime.onEvent((event) => this.handleRuntimeEvent(runtime, event));
    if (isRestart) {
      this.restartCount += 1;
      this.lastRestartAt = this.runtimeStartedAt;
    }
    this.state = "starting";
    this.emitStatus();

    try {
      runtime.start();
    } catch (error) {
      this.emitEvent({
        type: "runtime.error",
        message: error instanceof Error ? error.message : String(error),
        at: this.now(),
      });
      this.handleRuntimeExit(runtime, 0);
    }
  }

  private handleRuntimeEvent(runtime: ManagedRuntime, event: RuntimeEvent): void {
    if (runtime !== this.current) return;
    this.emitEvent(event);
    if (event.type === "auth.required") {
      this.state = "auth";
      this.emitStatus();
      return;
    }
    if (event.type === "device.ready") {
      this.state = "online";
      this.emitStatus();
      return;
    }
    if (event.type === "runtime.exited") {
      this.handleRuntimeExit(runtime, Math.max(0, this.now() - this.runtimeStartedAt));
    }
  }

  private handleRuntimeExit(runtime: ManagedRuntime, runDurationMs: number): void {
    if (runtime !== this.current) return;
    this.detachCurrent();
    if (!this.desiredRunning) {
      this.state = "stopped";
      this.emitStatus();
      return;
    }

    const decision = this.restartPolicy.nextAfterExit(runDurationMs);
    this.state = decision.degraded ? "degraded" : "recovering";
    this.emitStatus();
    const generation = this.lifecycleGeneration;
    void this.restartAfter(decision.delayMs, generation);
  }

  private async restartAfter(delayMs: number, generation: number): Promise<void> {
    await this.sleep(delayMs);
    if (!this.desiredRunning || generation !== this.lifecycleGeneration || this.current) return;
    this.startRuntime(true);
  }

  private detachCurrent(): void {
    this.unsubscribeCurrent?.();
    this.unsubscribeCurrent = undefined;
    this.current = undefined;
  }

  private emitEvent(event: RuntimeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // Observers must never take down the long-lived supervisor.
      }
    }
  }

  private emitStatus(): void {
    const status = this.status();
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status);
      } catch {
        // Status observers are isolated from daemon lifetime.
      }
    }
  }
}
