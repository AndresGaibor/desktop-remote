import type { RuntimeEvent } from "../runtime/events";
import { boundRuntimeEvent } from "../session/bounds";
import { RuntimeSessionStore } from "../session/runtime-store";
import { HistoryStore } from "./history-store";
import type { RuntimeSessionSnapshot } from "../session/types";
import type { SupervisorStatus } from "./supervisor";

export interface SupervisorController {
  start(): void;
  stop(): Promise<void>;
  status(): SupervisorStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

export interface DaemonStatus extends SupervisorStatus {
  retainedCalls: number;
}

export interface DesktopRemoteDaemonOptions {
  supervisor: SupervisorController;
  store?: RuntimeSessionStore;
  history?: HistoryStore;
}

export class DesktopRemoteDaemon {
  private readonly supervisor: SupervisorController;
  private readonly store: RuntimeSessionStore;
  private readonly history: HistoryStore | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private unsubscribeSupervisor: (() => void) | undefined;
  private started = false;

  constructor(options: DesktopRemoteDaemonOptions) {
    this.supervisor = options.supervisor;
    this.store = options.store ?? new RuntimeSessionStore();
    this.history = options.history;
  }

  start(): void | Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.history) {
      return this.history.loadInto(this.store)
        .catch(() => {})
        .then(() => {
          if (!this.started) return;
          this.startSupervisor();
        });
    }
    this.startSupervisor();
  }

  private startSupervisor(): void {
    this.unsubscribeSupervisor = this.supervisor.onEvent((event) => this.consume(event));
    try {
      this.supervisor.start();
    } catch (error) {
      this.unsubscribeSupervisor?.();
      this.unsubscribeSupervisor = undefined;
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeSupervisor?.();
    this.unsubscribeSupervisor = undefined;
    await this.supervisor.stop();
  }

  snapshot(): RuntimeSessionSnapshot {
    return this.store.snapshot();
  }

  status(): DaemonStatus {
    const supervisor = this.supervisor.status();
    return { ...supervisor, retainedCalls: this.store.snapshot().counts.total };
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private consume(rawEvent: RuntimeEvent): void {
    const event = boundRuntimeEvent(rawEvent);
    this.store.consume(event);
    if (this.history) {
      void this.history.append(event, this.store.snapshot()).catch(() => {
        // Persistence failures must not affect the active daemon connection.
      });
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Telemetry observers are isolated from the daemon lifetime.
      }
    }
  }
}
