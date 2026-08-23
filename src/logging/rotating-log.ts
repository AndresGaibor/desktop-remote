import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { redactText, redactValue } from "./redactor";

export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_FILE_COUNT = 3;
const LOG_ENTRY_MAX_BYTES = 64 * 1024;

type LogLevel = "info" | "warn" | "error";

export interface RotatingDaemonLogOptions {
  path: string;
  maxBytes?: number;
  fileCount?: number;
  now?: () => Date;
}

export class RotatingDaemonLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly fileCount: number;
  private readonly now: () => Date;
  private writeChain = Promise.resolve();

  constructor(options: RotatingDaemonLogOptions);
  constructor(path: string, options?: Omit<RotatingDaemonLogOptions, "path">);
  constructor(
    pathOrOptions: string | RotatingDaemonLogOptions,
    options: Omit<RotatingDaemonLogOptions, "path"> = {},
  ) {
    const config = typeof pathOrOptions === "string"
      ? { path: pathOrOptions, ...options }
      : pathOrOptions;
    this.path = config.path;
    this.maxBytes = Math.max(128, config.maxBytes ?? LOG_FILE_MAX_BYTES);
    this.fileCount = Math.max(1, config.fileCount ?? LOG_FILE_COUNT);
    this.now = config.now ?? (() => new Date());
  }

  info(message: string, data?: unknown): Promise<void> { return this.write("info", message, data); }
  warn(message: string, data?: unknown): Promise<void> { return this.write("warn", message, data); }
  error(message: string, data?: unknown): Promise<void> { return this.write("error", message, data); }

  async totalSizeBytes(): Promise<number> {
    await this.writeChain;
    let total = 0;
    for (let index = 0; index < this.fileCount; index += 1) total += await sizeIfPresent(this.filePath(index));
    return total;
  }

  private write(level: LogLevel, message: string, data?: unknown): Promise<void> {
    return this.enqueue(async () => {
      const line = encodeBoundedRecord({
        timestamp: this.now().toISOString(),
        level,
        message: redactText(message),
        data: data === undefined ? undefined : redactValue(data),
      }, Math.min(this.maxBytes, LOG_ENTRY_MAX_BYTES));
      await this.ensureDirectory();
      if (await sizeIfPresent(this.path) + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
      await appendAndSync(this.path, line);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writeChain.then(operation);
    this.writeChain = result.catch(() => {});
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async rotate(): Promise<void> {
    if (this.fileCount <= 1) { await rm(this.path, { force: true }); return; }
    await rm(this.filePath(this.fileCount - 1), { force: true });
    for (let index = this.fileCount - 2; index >= 1; index -= 1) {
      await renameIfPresent(this.filePath(index), this.filePath(index + 1));
    }
    await renameIfPresent(this.path, this.filePath(1));
  }

  private filePath(index: number): string { return index === 0 ? this.path : `${this.path}.${index}`; }
}

function encodeBoundedRecord(record: Record<string, unknown>, maxBytes: number): string {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) <= maxBytes) return line;
  const base = { timestamp: record.timestamp, level: record.level, data: "[TRUNCATED]" };
  const overhead = Buffer.byteLength(`${JSON.stringify({ ...base, message: "" })}\n`);
  const message = truncateUtf8(String(record.message ?? ""), Math.max(0, maxBytes - overhead));
  line = `${JSON.stringify({ ...base, message })}\n`;
  if (Buffer.byteLength(line) <= maxBytes) return line;
  return `${JSON.stringify({ level: record.level, message: "[TRUNCATED]" })}\n`.slice(0, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid) + suffix) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low) + (maxBytes >= Buffer.byteLength(suffix) ? suffix : "");
}

async function sizeIfPresent(path: string): Promise<number> {
  try { return (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

async function appendAndSync(path: string, line: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try { await rename(from, to); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
