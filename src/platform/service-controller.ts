import type { DaemonStatus } from "../daemon/daemon";
import type { DesktopRemotePaths } from "./paths";
import { readDesiredState, writeDesiredState } from "./desired-state";
import { sleep as portableSleep } from "./runtime";

export interface ServiceManagerStatus {
  loaded?: boolean;
  enabled?: boolean;
  active?: boolean;
  pid?: number;
  lastExitCode?: number;
}

export interface UserServiceManager {
  install(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
  status?(): Promise<ServiceManagerStatus>;
}

export interface ServiceControllerOptions {
  paths: DesktopRemotePaths;
  manager: UserServiceManager;
  requestStatus?: () => Promise<DaemonStatus>;
  sleep?: (ms: number) => Promise<void>;
  healthAttempts?: number;
  onBeforeManagerStop?: () => Promise<void>;
  onBeforeManagerRestart?: () => Promise<void>;
  prepareInstall?: () => Promise<void>;
}

export class ServiceController {
  private readonly requestStatus?: () => Promise<DaemonStatus>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly healthAttempts: number;

  constructor(private readonly options: ServiceControllerOptions) {
    this.requestStatus = options.requestStatus;
    this.sleep = options.sleep ?? portableSleep;
    this.healthAttempts = options.healthAttempts ?? 20;
  }

  async install(): Promise<void> {
    await this.options.prepareInstall?.();
    await this.options.manager.install();
    await writeDesiredState(this.options.paths.desiredStatePath, "running");
    await this.options.manager.start();
    if (this.requestStatus) await this.waitForHealthy();
  }

  async start(): Promise<DaemonStatus> {
    await writeDesiredState(this.options.paths.desiredStatePath, "running");
    await this.options.manager.start();
    return this.waitForHealthy();
  }

  async stop(): Promise<void> {
    await writeDesiredState(this.options.paths.desiredStatePath, "stopped");
    await this.options.onBeforeManagerStop?.();
    await this.options.manager.stop();
  }

  async restart(): Promise<DaemonStatus> {
    const desired = await readDesiredState(this.options.paths.desiredStatePath);
    if (desired === "stopped") throw new Error("Desktop Remote is intentionally stopped. Run: desktop-remote start");
    await this.options.onBeforeManagerRestart?.();
    await this.options.manager.restart();
    return this.waitForHealthy();
  }

  async ensureRunning(): Promise<DaemonStatus> {
    const desired = await readDesiredState(this.options.paths.desiredStatePath);
    if (desired === "stopped") throw new Error("Desktop Remote is intentionally stopped. Run: desktop-remote start");
    if (this.requestStatus) {
      try { return await this.requestStatus(); } catch {}
    }
    await this.options.manager.start();
    return this.waitForHealthy();
  }

  async status(): Promise<DaemonStatus | ServiceManagerStatus> {
    if (this.requestStatus) {
      try { return await this.requestStatus(); } catch {}
    }
    return this.options.manager.status?.() ?? {};
  }

  private async waitForHealthy(): Promise<DaemonStatus> {
    if (!this.requestStatus) {
      return { state: "starting", restartCount: 0, consecutiveFailures: 0, startedAt: Date.now(), retainedCalls: 0 };
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < this.healthAttempts; attempt += 1) {
      try { return await this.requestStatus(); }
      catch (error) { lastError = error; }
      if (attempt + 1 < this.healthAttempts) await this.sleep(250);
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unavailable");
    throw new Error(`Desktop Remote daemon did not become healthy: ${detail}`);
  }
}
