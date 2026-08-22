import { DesktopCommanderRuntime } from "../runtime/desktop-commander-runtime";
import { DesktopRemoteDaemon } from "./daemon";
import { DaemonSupervisor, type ManagedRuntime } from "./supervisor";

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
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
  const createRuntime = options.createRuntime ?? (() => new DesktopCommanderRuntime({
    command: options.command,
    args: options.args,
    env: options.env,
  }));
  const supervisor = new DaemonSupervisor({
    createRuntime,
    sleep: options.sleep,
    now: options.now,
  });
  const daemon = new DesktopRemoteDaemon({ supervisor });
  const signals = options.signals ?? PROCESS_SIGNALS;
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const requestShutdown = () => resolveShutdown();

  signals.on("SIGINT", requestShutdown);
  signals.on("SIGTERM", requestShutdown);
  try {
    daemon.start();
    await shutdownRequested;
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
