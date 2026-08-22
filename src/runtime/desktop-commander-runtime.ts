import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { getCommandToSpawn, getSpawnArgs } from "../launcher";
import type { RuntimeEvent, StreamSource } from "./events";
import { UpstreamParser } from "./upstream-parser";

export const MAX_UPSTREAM_REMAINDER_BYTES = 2 * 1024 * 1024;

export interface ChildProcessLike {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
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

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null;
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

    const stdoutHandler = (chunk: Buffer | string) => this.consumeChunk("stdout", chunk);
    const stderrHandler = (chunk: Buffer | string) => this.consumeChunk("stderr", chunk);
    const errorHandler = (error: Error) => {
      this.emit({ type: "runtime.error", message: error.message, at: this.now() });
    };
    const closeHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      this.flushRemainder("stdout");
      this.flushRemainder("stderr");
      for (const event of this.parser.flush()) this.emit(event);
      this.emit({ type: "runtime.exited", code, signal, at: this.now() });
      child.stdout.off("data", stdoutHandler);
      child.stderr.off("data", stderrHandler);
      child.off("error", errorHandler);
      child.off("close", closeHandler);
      if (this.child === child) this.child = null;
      this.stdoutRemainder = "";
      this.stderrRemainder = "";
      this.resolveClosed?.();
      this.resolveClosed = null;
      this.closedPromise = null;
    };

    child.stdout.on("data", stdoutHandler);
    child.stderr.on("data", stderrHandler);
    child.on("error", errorHandler);
    child.on("close", closeHandler);
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
    const incoming = chunk.toString();
    let remainder = source === "stdout" ? this.stdoutRemainder : this.stderrRemainder;
    let cursor = 0;

    while (cursor <= incoming.length) {
      const newline = incoming.indexOf("\n", cursor);
      if (newline < 0) break;
      const segment = incoming.slice(cursor, newline);
      if (Buffer.byteLength(remainder) + Buffer.byteLength(segment) > MAX_UPSTREAM_REMAINDER_BYTES) {
        this.emitRemainderOverflow(source);
      } else {
        const line = remainder + segment;
        for (const event of this.parser.pushLine(line, source)) this.emit(event);
      }
      remainder = "";
      cursor = newline + 1;
    }

    const tail = incoming.slice(cursor);
    if (Buffer.byteLength(remainder) + Buffer.byteLength(tail) > MAX_UPSTREAM_REMAINDER_BYTES) {
      this.emitRemainderOverflow(source);
      remainder = "";
    } else {
      remainder += tail;
    }

    if (source === "stdout") this.stdoutRemainder = remainder;
    else this.stderrRemainder = remainder;
  }

  private emitRemainderOverflow(source: StreamSource) {
    this.emit({
      type: "runtime.error",
      message: `${source} line exceeded 2 MiB observability limit and was discarded`,
      at: this.now(),
    });
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
