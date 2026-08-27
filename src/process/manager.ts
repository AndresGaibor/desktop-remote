import { Buffer } from "node:buffer";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactArgvSecrets } from "../security/argv-secrets";

export interface ProcessCursor {
  offset: number;
  end: number;
  nextOffset: number;
  truncated: boolean;
}

export interface StartedProcess {
  id: string;
  pid: number;
  cwd: string;
}

export interface ProcessOutput {
  id: string;
  pid: number;
  cwd: string;
  status: "running" | "completed" | "failed";
  output: string;
  stdout: string;
  stderr: string;
  outputBytes: number;
  outputRetainedBytes: number;
  stdoutBytes: number;
  stdoutRetainedBytes: number;
  stderrBytes: number;
  stderrRetainedBytes: number;
  outputTruncated: boolean;
  truncated: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputCursor: ProcessCursor;
  stdoutCursor: ProcessCursor;
  stderrCursor: ProcessCursor;
  timedOut?: boolean;
  exitCode?: number;
}

export interface ProcessSession extends ProcessOutput {}

export interface SystemProcess {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

interface ManagedProcess {
  id: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  stdout: BoundedUtf8Buffer;
  stderr: BoundedUtf8Buffer;
  combined: BoundedUtf8Buffer;
  exitCode?: number;
  exitReady: Promise<ChildExit>;
  outputReady: Promise<void>;
  completedAt?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  evictionTimer?: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<void>;
  timedOut: boolean;
}

export interface ProcessOptions {
  shell?: string;
  cwd?: string;
  env?: Record<string, string | null | undefined>;
  timeout_ms?: number;
}

export interface ReadProcessOptions {
  timeout_ms?: number;
  offset?: number;
  length?: number;
  stdout_offset?: number;
  stdout_length?: number;
  stderr_offset?: number;
  stderr_length?: number;
}

export interface InteractProcessOptions extends ReadProcessOptions {
  wait_for_prompt?: boolean;
}

export interface ProcessManagerOptions {
  maxConcurrentProcesses?: number;
  maxOutputBytes?: number;
  maxRetainedSessions?: number;
  completedSessionTtlMs?: number;
  sessionTtlMs?: number;
  gracefulTerminateMs?: number;
}

const DEFAULT_MAX_RETAINED_SESSIONS = 100;
const DEFAULT_COMPLETED_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GRACEFUL_TERMINATE_MS = 500;

export class ProcessManager {
  private readonly processes = new Map<number, ManagedProcess>();
  private readonly ids = new Map<string, number>();
  private readonly maxConcurrentProcesses: number;
  private readonly maxOutputBytes: number;
  private readonly maxRetainedSessions: number;
  private readonly completedSessionTtlMs: number;
  private readonly gracefulTerminateMs: number;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxConcurrentProcesses = options.maxConcurrentProcesses ?? 16;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.maxRetainedSessions = options.maxRetainedSessions ?? DEFAULT_MAX_RETAINED_SESSIONS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? options.sessionTtlMs ?? DEFAULT_COMPLETED_SESSION_TTL_MS;
    this.gracefulTerminateMs = options.gracefulTerminateMs ?? DEFAULT_GRACEFUL_TERMINATE_MS;

    if (!Number.isSafeInteger(this.maxConcurrentProcesses) || this.maxConcurrentProcesses <= 0) {
      throw new Error("maxConcurrentProcesses must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("maxOutputBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxRetainedSessions) || this.maxRetainedSessions < 0) {
      throw new Error("maxRetainedSessions must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.completedSessionTtlMs) || this.completedSessionTtlMs < 0) {
      throw new Error("completedSessionTtlMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.gracefulTerminateMs) || this.gracefulTerminateMs < 0) {
      throw new Error("gracefulTerminateMs must be a non-negative integer");
    }
  }

  async start(command: string | string[], options: ProcessOptions = {}): Promise<StartedProcess> {
    validateCommand(command);
    validateTimeout(options.timeout_ms, "timeout_ms");
    validateCwd(options.cwd);
    validateEnvironmentOverrides(options.env);

    this.evictExpiredSessions();
    const runningCount = [...this.processes.values()].filter((managed) => managed.exitCode === undefined).length;
    if (runningCount >= this.maxConcurrentProcesses) {
      throw new Error(`Maximum concurrent processes (${this.maxConcurrentProcesses}) exceeded`);
    }

    const shell = options.shell ?? (process.platform === "win32" ? "cmd.exe" : "zsh");
    const argv = typeof command === "string"
      ? [shell, process.platform === "win32" ? "/c" : "-lc", command]
      : command;
    const cwd = options.cwd ?? process.cwd();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: buildEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    if (child.pid === undefined) {
      const failure = await waitForChild(child);
      throw new Error(failure.error?.message ?? `Failed to start process ${argv[0]}`);
    }

    const managed: ManagedProcess = {
      id: randomUUID(),
      child,
      cwd,
      stdout: new BoundedUtf8Buffer(this.maxOutputBytes),
      stderr: new BoundedUtf8Buffer(this.maxOutputBytes),
      combined: new BoundedUtf8Buffer(this.maxOutputBytes),
      exitReady: Promise.resolve({ code: 1 }),
      outputReady: Promise.resolve(),
      timedOut: false,
    };
    managed.exitReady = waitForChild(child).then((exit) => {
      managed.exitCode = exit.code ?? 1;
      this.markCompleted(managed);
      return exit;
    });
    managed.outputReady = this.collectOutput(managed);
    this.processes.set(child.pid, managed);
    this.ids.set(managed.id, child.pid);

    if (options.timeout_ms !== undefined) {
      managed.timeoutTimer = setTimeout(() => {
        if (managed.exitCode !== undefined) return;
        managed.timedOut = true;
        void this.requestTermination(managed).catch(() => undefined);
      }, options.timeout_ms);
      managed.timeoutTimer.unref?.();
    }

    return { id: managed.id, pid: child.pid, cwd };
  }

  async readOutput(idOrPid: string | number, options: ReadProcessOptions = {}): Promise<ProcessOutput> {
    const managed = this.getManaged(idOrPid);
    validateReadOptions(options);
    const waitMs = options.timeout_ms ?? 1000;
    if (managed.exitCode === undefined) await Promise.race([managed.outputReady, delay(waitMs)]);
    else await Promise.race([managed.outputReady, delay(500)]);

    const stdout = managed.stdout.read(options.stdout_offset, options.stdout_length);
    const stderr = managed.stderr.read(options.stderr_offset, options.stderr_length);
    const exitCode = managed.exitCode;
    return {
      ...this.snapshot(managed),
      output: sliceOutput(managed.combined.toString(), options.offset, options.length),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutCursor: stdout.cursor,
      stderrCursor: stderr.cursor,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  async interact(pid: number, input: string, options: InteractProcessOptions = {}): Promise<ProcessOutput> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
    if (typeof input !== "string") throw new Error("input must be a string");
    const managed = this.getManaged(pid);
    if (managed.exitCode !== undefined) throw new Error(`Process ${pid} is not running`);
    await writeInput(managed.child.stdin, input);
    if (options.wait_for_prompt === false) return this.readOutput(pid, options);
    return this.readOutput(pid, { ...options, timeout_ms: options.timeout_ms ?? 1000 });
  }

  async terminate(pid: number): Promise<{ pid: number; terminated: true }> {
    validatePid(pid);
    const managed = this.getManaged(pid);
    await this.requestTermination(managed);
    return { pid, terminated: true };
  }

  listSessions(): ProcessSession[] {
    this.evictExpiredSessions();
    return [...this.processes.values()].map((managed) => this.snapshot(managed));
  }

  async listProcesses(): Promise<SystemProcess[]> {
    const child = spawn("ps", ["-axo", "pid=,ppid=,stat=,command="], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid === undefined) {
      const failure = await waitForChild(child);
      throw new Error(failure.error?.message ?? "Failed to start ps");
    }

    const exitPromise = waitForChild(child);
    const [stdoutResult] = await Promise.all([
      readBoundedStream(child.stdout, this.maxOutputBytes),
      readBoundedStream(child.stderr, this.maxOutputBytes),
    ]);
    const exit = await exitPromise;
    if (exit.code !== 0) throw new Error(`ps failed with exit code ${exit.code ?? 1}`);
    return stdoutResult.split("\n").map(parseProcessLine).filter((process): process is SystemProcess => process !== undefined);
  }

  async kill(pid: number): Promise<{ pid: number; killed: true }> {
    validatePid(pid);
    const managed = this.getManaged(pid);
    await this.requestTermination(managed);
    return { pid, killed: true };
  }

  private async collectOutput(managed: ManagedProcess): Promise<void> {
    const outputPromise = Promise.allSettled([
      readOutputStream(managed.child.stdout, managed.stdout, managed.combined),
      readOutputStream(managed.child.stderr, managed.stderr, managed.combined),
    ]);
    await managed.exitReady;
    const [stdoutResult, stderrResult] = await outputPromise;
    if (stdoutResult.status === "rejected") managed.stderr.append(`[stdout read failed: ${String(stdoutResult.reason)}]`);
    if (stderrResult.status === "rejected") managed.stderr.append(`[stderr read failed: ${String(stderrResult.reason)}]`);
  }

  private markCompleted(managed: ManagedProcess): void {
    if (managed.timeoutTimer) clearTimeout(managed.timeoutTimer);
    managed.completedAt = Date.now();
    this.evictCompletedByCount();
    if (this.completedSessionTtlMs === 0) {
      this.evict(managed);
      return;
    }
    managed.evictionTimer = setTimeout(() => this.evict(managed), this.completedSessionTtlMs);
    managed.evictionTimer.unref?.();
  }

  private async requestTermination(managed: ManagedProcess): Promise<void> {
    if (managed.terminationPromise) return managed.terminationPromise;
    managed.terminationPromise = this.terminateManaged(managed);
    return managed.terminationPromise;
  }

  private async terminateManaged(managed: ManagedProcess): Promise<void> {
    if (managed.exitCode !== undefined) return;
    signalManagedProcess(managed, "SIGTERM", true);
    await Promise.race([managed.exitReady, delay(this.gracefulTerminateMs)]);
    if (managed.exitCode === undefined) signalManagedProcess(managed, "SIGKILL", true);
    await Promise.race([managed.exitReady, delay(5000)]);
  }

  private snapshot(managed: ManagedProcess): ProcessOutput {
    const output = managed.combined.read();
    const stdout = managed.stdout.read();
    const stderr = managed.stderr.read();
    return {
      id: managed.id,
      pid: managed.child.pid!,
      cwd: managed.cwd,
      status: managed.exitCode === undefined ? "running" : managed.exitCode === 0 ? "completed" : "failed",
      output: output.text,
      stdout: stdout.text,
      stderr: stderr.text,
      outputBytes: managed.combined.totalBytes,
      outputRetainedBytes: managed.combined.retainedBytes,
      stdoutBytes: managed.stdout.totalBytes,
      stdoutRetainedBytes: managed.stdout.retainedBytes,
      stderrBytes: managed.stderr.totalBytes,
      stderrRetainedBytes: managed.stderr.retainedBytes,
      outputTruncated: managed.combined.truncated,
      truncated: managed.combined.truncated || managed.stdout.truncated || managed.stderr.truncated,
      stdoutTruncated: managed.stdout.truncated,
      stderrTruncated: managed.stderr.truncated,
      outputCursor: output.cursor,
      stdoutCursor: stdout.cursor,
      stderrCursor: stderr.cursor,
      ...(managed.timedOut ? { timedOut: true } : {}),
      ...(managed.exitCode === undefined ? {} : { exitCode: managed.exitCode }),
    };
  }

  private evictExpiredSessions(now = Date.now()): void {
    for (const managed of this.processes.values()) {
      if (managed.completedAt !== undefined && now - managed.completedAt >= this.completedSessionTtlMs) this.evict(managed);
    }
  }

  private evictCompletedByCount(): void {
    const completed = [...this.processes.values()]
      .filter((managed) => managed.completedAt !== undefined)
      .sort((left, right) => (left.completedAt! - right.completedAt!));
    while (completed.length > this.maxRetainedSessions) this.evict(completed.shift()!);
  }

  private evict(managed: ManagedProcess): void {
    if (this.processes.get(managed.child.pid!) !== managed) return;
    if (managed.exitCode === undefined) return;
    if (managed.evictionTimer) clearTimeout(managed.evictionTimer);
    this.processes.delete(managed.child.pid!);
    this.ids.delete(managed.id);
  }

  private getManaged(idOrPid: string | number): ManagedProcess {
    this.evictExpiredSessions();
    const pid = typeof idOrPid === "number" ? idOrPid : this.ids.get(idOrPid);
    const managed = pid === undefined ? undefined : this.processes.get(pid);
    if (!managed) throw new Error(`Unknown managed process: ${String(idOrPid)}`);
    return managed;
  }
}

class BoundedUtf8Buffer {
  private chunks: Buffer[] = [];
  totalBytes = 0;
  retainedBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;
    if (bytes.length >= this.maxBytes) {
      const tail = safeTail(bytes, this.maxBytes);
      this.chunks = tail.length === 0 ? [] : [tail];
      this.retainedBytes = tail.length;
      this.truncated = true;
      return;
    }

    this.chunks.push(bytes);
    this.retainedBytes += bytes.length;
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0]!;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        const trimmed = safeTail(first, first.length - excess);
        this.chunks[0] = trimmed;
        this.retainedBytes -= first.length - trimmed.length;
      }
      this.truncated = true;
    }
  }

  read(offset?: number, length?: number): { text: string; cursor: ProcessCursor } {
    validateByteRange(offset, length);
    const buffer = Buffer.concat(this.chunks, this.retainedBytes);
    const retainedStart = this.totalBytes - this.retainedBytes;
    const requestedStart = offset ?? retainedStart;
    const start = Math.min(this.totalBytes, Math.max(requestedStart, retainedStart));
    const requestedEnd = length === undefined ? this.totalBytes : Math.min(this.totalBytes, start + length);
    const relativeStart = Math.max(0, start - retainedStart);
    const relativeEnd = Math.max(relativeStart, Math.min(buffer.length, requestedEnd - retainedStart));
    const safeStart = safeUtf8Start(buffer, relativeStart, relativeEnd);
    const safeEnd = safeUtf8End(buffer, safeStart, relativeEnd);
    const text = buffer.subarray(safeStart, safeEnd).toString("utf8");
    const cursorStart = retainedStart + safeStart;
    const cursorEnd = retainedStart + safeEnd;
    return {
      text,
      cursor: {
        offset: cursorStart,
        end: cursorEnd,
        nextOffset: this.totalBytes,
        truncated: this.truncated || requestedStart < retainedStart,
      },
    };
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.retainedBytes).toString("utf8");
  }
}

function validateCommand(command: string | string[]): void {
  if (typeof command === "string" && !command.trim()) throw new Error("command is required");
  if (Array.isArray(command)) {
    if (command.length === 0 || command.some((part) => typeof part !== "string") || !command[0]!.trim()) {
      throw new Error("command is required");
    }
  }
  if (!Array.isArray(command) && typeof command !== "string") throw new Error("command is required");
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer");
}

function validateTimeout(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${field} must be a positive integer`);
}

function validateCwd(value: string | undefined): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error("cwd must be a non-empty string");
}

function validateEnvironmentOverrides(value: Record<string, string | null | undefined> | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("env must be an object");
  for (const [key, entry] of Object.entries(value)) {
    if (!key || (typeof entry !== "string" && entry !== null && entry !== undefined)) {
      throw new Error(`env.${key} must be a string or null`);
    }
  }
}

function validateReadOptions(options: ReadProcessOptions): void {
  validateTimeout(options.timeout_ms, "timeout_ms");
  if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
    throw new Error("offset must be a non-negative integer");
  }
  validateByteRange(options.stdout_offset, options.stdout_length);
  validateByteRange(options.stderr_offset, options.stderr_length);
  if (options.length !== undefined && (!Number.isSafeInteger(options.length) || options.length <= 0)) {
    throw new Error("length must be a positive integer");
  }
}

function validateByteRange(offset: number | undefined, length: number | undefined): void {
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error("byte offset must be a non-negative integer");
  if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0)) throw new Error("byte length must be a positive integer");
}

function buildEnvironment(overrides: Record<string, string | null | undefined> | undefined): NodeJS.ProcessEnv | undefined {
  if (overrides === undefined) return undefined;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

async function readOutputStream(
  stream: NodeJS.ReadableStream,
  target: BoundedUtf8Buffer,
  combined: BoundedUtf8Buffer,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    target.append(text);
    combined.append(text);
  }
  const remainder = decoder.decode();
  target.append(remainder);
  combined.append(remainder);
}

async function readBoundedStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const buffer = new BoundedUtf8Buffer(maxBytes);
  const decoder = new TextDecoder();
  for await (const chunk of stream as AsyncIterable<Uint8Array>) buffer.append(decoder.decode(chunk, { stream: true }));
  buffer.append(decoder.decode());
  return buffer.toString();
}

function writeInput(stream: NodeJS.WritableStream, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(input, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

interface ChildExit {
  code: number | null;
  error?: Error;
}

function waitForChild(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode ?? 1 });
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("exit", (code) => settle({ code }));
    child.once("error", (error) => settle({ code: 1, error }));
  });
}

function signalManagedProcess(managed: ManagedProcess, signal: NodeJS.Signals, group: boolean): void {
  if (managed.exitCode !== undefined) return;
  try {
    if (group && process.platform !== "win32") process.kill(-managed.child.pid!, signal);
    else managed.child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sliceOutput(output: string, offset?: number, length?: number): string {
  const start = offset ?? 0;
  if (length === undefined) return output.slice(start);
  return output.slice(start, start + length);
}

function safeTail(bytes: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && isUtf8Continuation(bytes[start]!)) start += 1;
  return bytes.subarray(start);
}

function safeUtf8Start(bytes: Buffer, start: number, end: number): number {
  while (start < end && isUtf8Continuation(bytes[start]!)) start += 1;
  return start;
}

function safeUtf8End(bytes: Buffer, start: number, end: number): number {
  if (end <= start) return end;
  let lead = end - 1;
  while (lead > start && isUtf8Continuation(bytes[lead]!)) lead -= 1;
  return lead + utf8SequenceLength(bytes[lead]!) === end ? end : lead;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte < 0xe0) return 2;
  if (byte < 0xf0) return 3;
  return 4;
}

function parseProcessLine(line: string): SystemProcess | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return undefined;
  return { pid: Number(match[1]), ppid: Number(match[2]), stat: match[3]!, command: redactArgvSecrets(match[4] ?? "") };
}
