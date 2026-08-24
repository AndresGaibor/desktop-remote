import { join } from "node:path";
import { RotatingDaemonLog } from "../logging/rotating-log";
import { getDesktopRemotePaths, type DesktopRemotePaths } from "../platform/paths";
import type { RuntimeEvent } from "../runtime/events";
import { DesktopRemoteDaemon, type DaemonLogger } from "./daemon";
import { HistoryStore } from "./history-store";
import { DaemonSupervisor, type ManagedRuntime } from "./supervisor";
import { DaemonIpcServer } from "./ipc-server";
import { DesktopOperationExecutor } from "../core/executor";

export type DaemonSignal = "SIGINT" | "SIGTERM";

export interface DaemonSignalSource {
  on(signal: DaemonSignal, listener: () => void): void;
  off(signal: DaemonSignal, listener: () => void): void;
}

export interface RunDaemonOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  createRuntime?: () => ManagedRuntime;
  signals?: DaemonSignalSource;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  ipcServer?: DaemonIpcServer;
  history?: HistoryStore;
  logger?: DaemonLogger;
  paths?: DesktopRemotePaths;
}

export interface LocalRuntimeOptions {
  now?: () => number;
}

/** Runtime in-process del daemon; no depende de ejecutables ni procesos externos. */
export class LocalRuntime implements ManagedRuntime {
  private readonly now: () => number;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private active = false;

  constructor(options: LocalRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get pid(): number | undefined {
    return undefined;
  }

  get running(): boolean {
    return this.active;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.active) throw new Error("Local runtime already started");
    this.active = true;
    this.emit({
      type: "device.ready",
      user: "local",
      deviceId: "desktop-remote",
      deviceName: "Desktop Remote Local Runtime",
      at: this.now(),
    });
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.emit({ type: "runtime.exited", code: 0, signal: null, at: this.now() });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
  const createRuntime = options.createRuntime ?? (() => new LocalRuntime());
  const supervisor = new DaemonSupervisor({
    createRuntime,
    sleep: options.sleep,
    now: options.now,
  });
  const paths = options.paths ?? getDesktopRemotePaths();
  const logger = options.logger ?? new RotatingDaemonLog({ path: join(paths.logsDir, "daemon.log") });
  const history = options.history ?? new HistoryStore({
    path: paths.historyPath,
    onWarning: (message) => { void logger.warn("daemon persistence warning", { message }); },
  });
  const operationExecutor = new DesktopOperationExecutor();
  const daemon = new DesktopRemoteDaemon({ supervisor, history, logger, operationExecutor });
  const ipc = options.ipcServer ?? new DaemonIpcServer({ source: daemon, paths });
  const signals = options.signals ?? PROCESS_SIGNALS;
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown();

  signals.on("SIGINT", requestShutdown);
  signals.on("SIGTERM", requestShutdown);
  try {
    await daemon.start();
    await ipc.start();
    await shutdownRequested;
    await ipc.stop();
    await daemon.stop();
  } finally {
    signals.off("SIGINT", requestShutdown);
    signals.off("SIGTERM", requestShutdown);
  }
}

export function parseDaemonDevArgs(argv: string[]): Pick<RunDaemonOptions, "command" | "args"> {
  if (argv.length === 0) return {};
  const separator = argv.indexOf("--");
  const controlArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const childArgs = separator >= 0 ? argv.slice(separator + 1) : undefined;
  const commandIndex = controlArgs.indexOf("--cmd");
  if (commandIndex < 0) throw new Error(`Unknown daemon development arguments: ${controlArgs.join(" ")}`);
  const command = controlArgs[commandIndex + 1];
  if (!command) throw new Error("--cmd requires an executable path");
  return { command, args: childArgs?.length ? childArgs : undefined };
}

const PROCESS_SIGNALS: DaemonSignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};
