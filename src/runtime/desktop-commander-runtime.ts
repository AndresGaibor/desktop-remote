import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { getCommandToSpawn, getSpawnArgs } from "../launcher";
import type { RuntimeEvent, StreamSource } from "./events";
import { UpstreamParser } from "./upstream-parser";

export interface ChildProcessLike {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcessLike;

export interface DesktopCommanderRuntimeOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnProcess;
  shutdownTimeoutMs?: number;
  parser?: UpstreamParser;
  now?: () => number;
}

export class DesktopCommanderRuntime {
  private readonly options: DesktopCommanderRuntimeOptions;
  private readonly parser: UpstreamParser;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private child: ChildProcessLike | null = null;
  private stdoutRemainder = "";
  private stderrRemainder = "";
  private closedPromise: Promise<void> | null = null;
  private resolveClosed: (() => void) | null = null;

  constructor(options: DesktopCommanderRuntimeOptions = {}) {
    this.options = options;
    this.parser = options.parser ?? new UpstreamParser({ now: options.now });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.child) throw new Error("Desktop Commander runtime already started");

    const command = getCommandToSpawn(this.options.command);
    const args = getSpawnArgs(
      this.options.command,
      this.options.args ?? ["remote", "--persist-session"],
    );
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
    const child = spawnProcess(command, args, { env: this.options.env ?? process.env });
    this.child = child;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    child.stdout.on("data", (chunk) => this.consumeChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => this.consumeChunk("stderr", chunk));
    child.on("error", (error) => {
      this.emit({ type: "runtime.error", message: error.message, at: this.now() });
    });
    child.on("close", (code, signal) => {
      this.flushRemainder("stdout");
      this.flushRemainder("stderr");
      for (const event of this.parser.flush()) this.emit(event);
      this.emit({ type: "runtime.exited", code, signal, at: this.now() });
      this.child = null;
      this.resolveClosed?.();
      this.resolveClosed = null;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    child.kill("SIGINT");
    const closed = this.closedPromise ?? Promise.resolve();
    const timeoutMs = this.options.shutdownTimeoutMs ?? 5000;
    const graceful = await Promise.race([
      closed.then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);

    if (!graceful && this.child === child) {
      child.kill("SIGKILL");
    }
  }

  private consumeChunk(source: StreamSource, chunk: Buffer | string) {
    const text = (source === "stdout" ? this.stdoutRemainder : this.stderrRemainder) +
      chunk.toString();
    const lines = text.split("\n");
    const remainder = lines.pop() ?? "";
    if (source === "stdout") this.stdoutRemainder = remainder;
    else this.stderrRemainder = remainder;

    for (const line of lines) {
      for (const event of this.parser.pushLine(line, source)) this.emit(event);
    }
  }

  private flushRemainder(source: StreamSource) {
    const remainder = source === "stdout" ? this.stdoutRemainder : this.stderrRemainder;
    if (!remainder) return;
    for (const event of this.parser.pushLine(remainder, source)) this.emit(event);
    if (source === "stdout") this.stdoutRemainder = "";
    else this.stderrRemainder = "";
  }

  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

const defaultSpawn: SpawnProcess = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("Desktop Commander child process did not expose stdout/stderr");
  }
  return child as ChildProcessLike;
};
