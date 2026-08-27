import { redactArgvSecrets } from "../security/argv-secrets";

export interface StartedProcess {
  id: string;
  pid: number;
}

export interface ProcessOutput {
  id: string;
  pid?: number;
  status: "running" | "completed" | "failed";
  output: string;
  exitCode?: number;
}

export interface ProcessSession {
  id: string;
  pid: number;
  status: "running" | "completed" | "failed";
  output: string;
  exitCode?: number;
}

export interface SystemProcess {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

interface ManagedProcess {
  id: string;
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  outputChunks: string[];
  outputBytes: number;
  exitCode?: number;
  outputReady: Promise<void>;
}

export interface ProcessOptions {
  shell?: string;
  timeout_ms?: number;
}

export interface ReadProcessOptions {
  timeout_ms?: number;
  offset?: number;
  length?: number;
}

export interface InteractProcessOptions extends ReadProcessOptions {
  wait_for_prompt?: boolean;
}

export interface ProcessManagerOptions {
  maxConcurrentProcesses?: number;
  maxOutputBytes?: number;
}

export class ProcessManager {
  private readonly processes = new Map<number, ManagedProcess>();
  private readonly ids = new Map<string, number>();
  private readonly maxConcurrentProcesses: number;
  private readonly maxOutputBytes: number;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxConcurrentProcesses = options.maxConcurrentProcesses ?? 16;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.maxConcurrentProcesses) || this.maxConcurrentProcesses <= 0) {
      throw new Error("maxConcurrentProcesses must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("maxOutputBytes must be a positive integer");
    }
  }

  async start(command: string | string[], options: ProcessOptions = {}): Promise<StartedProcess> {
    if (typeof command === "string" && !command.trim()) throw new Error("command is required");
    if (Array.isArray(command) && (command.length === 0 || !command[0])) throw new Error("command is required");

    const runningCount = [...this.processes.values()].filter((p) => p.exitCode === undefined).length;
    if (runningCount >= this.maxConcurrentProcesses) {
      throw new Error(`Maximum concurrent processes (${this.maxConcurrentProcesses}) exceeded`);
    }

    const shell = options.shell ?? (process.platform === "win32" ? "cmd.exe" : "zsh");
    const argv = typeof command === "string" ? [shell, process.platform === "win32" ? "/c" : "-lc", command] : command;
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const id = crypto.randomUUID();
    const managed: ManagedProcess = {
      id,
      child,
      outputChunks: [],
      outputBytes: 0,
      outputReady: Promise.resolve(),
    };
    managed.outputReady = this.collectOutput(managed);
    this.processes.set(child.pid, managed);
    this.ids.set(id, child.pid);

    if (options.timeout_ms !== undefined) {
      if (!Number.isSafeInteger(options.timeout_ms) || options.timeout_ms <= 0) {
        throw new Error("timeout_ms must be a positive integer");
      }
      setTimeout(() => {
        if (this.processes.get(child.pid)?.exitCode === undefined) this.signal(child.pid, "SIGTERM");
      }, options.timeout_ms);
    }
    return { id, pid: child.pid };
  }

  async readOutput(idOrPid: string | number, options: ReadProcessOptions = {}): Promise<ProcessOutput> {
    const process = this.getManaged(idOrPid);
    const waitMs = options.timeout_ms ?? 1000;
    if (process.exitCode === undefined) {
      await Promise.race([process.child.exited, delay(waitMs)]);
    }
    if (process.exitCode !== undefined) {
      await Promise.race([process.outputReady, delay(500)]);
    }
    const output = sliceOutput(this.getOutput(process), options.offset, options.length);
    const exitCode = process.exitCode;
    return {
      id: process.id,
      pid: process.child.pid,
      status: exitCode === undefined ? "running" : exitCode === 0 ? "completed" : "failed",
      output,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  async interact(pid: number, input: string, options: InteractProcessOptions = {}): Promise<ProcessOutput> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
    if (typeof input !== "string") throw new Error("input must be a string");
    const process = this.getManaged(pid);
    if (process.exitCode !== undefined) throw new Error(`Process ${pid} is not running`);
    await process.child.stdin.write(input);
    if (options.wait_for_prompt === false) return this.readOutput(pid, options);
    return this.readOutput(pid, { ...options, timeout_ms: options.timeout_ms ?? 1000 });
  }

  async terminate(pid: number): Promise<{ pid: number; terminated: true }> {
    this.getManaged(pid);
    this.signal(pid, "SIGKILL");
    return { pid, terminated: true };
  }

  listSessions(): ProcessSession[] {
    return [...this.processes.values()].map((process) => ({
      id: process.id,
      pid: process.child.pid,
      status: process.exitCode === undefined ? "running" : process.exitCode === 0 ? "completed" : "failed",
      output: this.getOutput(process),
      ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    }));
  }

  async listProcesses(): Promise<SystemProcess[]> {
    const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,stat=,command="], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    await child.exited;
    if (child.exitCode !== 0) throw new Error(`ps failed with exit code ${child.exitCode}`);
    return output.split("\n").map(parseProcessLine).filter((process): process is SystemProcess => process !== undefined);
  }

  async kill(pid: number): Promise<{ pid: number; killed: true }> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
    this.signal(pid, "SIGTERM");
    const process = this.processes.get(pid);
    if (process && process.exitCode === undefined) {
      await Promise.race([process.outputReady, delay(5000)]);
    }
    return { pid, killed: true };
  }

  private async collectOutput(process: ManagedProcess): Promise<void> {
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.appendOutput(process, decoder.decode(value, { stream: true }));
        }
        this.appendOutput(process, decoder.decode());
      } finally {
        reader.releaseLock();
      }
    };
    await Promise.all([read(process.child.stdout), read(process.child.stderr)]);
    process.exitCode = await process.child.exited;
  }

  private appendOutput(process: ManagedProcess, chunk: string): void {
    const bytes = new TextEncoder().encode(chunk).length;
    if (bytes === 0) return;
    process.outputBytes += bytes;
    process.outputChunks.push(chunk);
    while (process.outputBytes > this.maxOutputBytes && process.outputChunks.length > 1) {
      const removed = process.outputChunks.shift()!;
      process.outputBytes -= new TextEncoder().encode(removed).length;
    }
  }

  private getOutput(process: ManagedProcess): string {
    return process.outputChunks.join("");
  }

  private getManaged(idOrPid: string | number): ManagedProcess {
    const pid = typeof idOrPid === "number" ? idOrPid : this.ids.get(idOrPid);
    const process = pid === undefined ? undefined : this.processes.get(pid);
    if (!process) throw new Error(`Unknown process: ${String(idOrPid)}`);
    return process;
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new Error(`Unknown process: ${pid}`);
      throw error;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sliceOutput(output: string, offset?: number, length?: number): string {
  const start = offset ?? 0;
  if (start < 0 || !Number.isSafeInteger(start)) throw new Error("offset must be a non-negative integer");
  if (length !== undefined && (length <= 0 || !Number.isSafeInteger(length))) {
    throw new Error("length must be a positive integer");
  }
  return length === undefined ? output.slice(start) : output.slice(start, start + length);
}

function parseProcessLine(line: string): SystemProcess | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return undefined;
  return { pid: Number(match[1]), ppid: Number(match[2]), stat: match[3]!, command: redactArgvSecrets(match[4] ?? "") };
}
