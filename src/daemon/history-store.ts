import { appendFile, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, basename, join } from "node:path";
import type { RuntimeEvent } from "../runtime/events";
import { redactEvent, redactValue } from "../logging/redactor";
import { boundRuntimeEvent } from "../session/bounds";
import { RuntimeSessionStore } from "../session/runtime-store";
import type { RuntimeSessionSnapshot } from "../session/types";

export const STATE_VERSION = 1 as const;
export const HISTORY_MAX_BYTES = 24 * 1024 * 1024;
export const HISTORY_COMPACT_AT_BYTES = 20 * 1024 * 1024;

export type PersistedRuntimeSnapshot = Omit<RuntimeSessionSnapshot, "auth">;
export type HistoryRecord =
  | { stateVersion: 1; kind: "checkpoint"; snapshot: PersistedRuntimeSnapshot }
  | { stateVersion: 1; kind: "event"; event: RuntimeEvent };

export interface HistoryStoreOptions {
  path: string;
  maxBytes?: number;
  compactAtBytes?: number;
  onWarning?: (message: string) => void;
}

export class HistoryStore {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly compactAtBytes: number;
  private readonly onWarning?: (message: string) => void;
  private writeChain = Promise.resolve();
  private warned = false;

  constructor(options: HistoryStoreOptions) {
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES;
    this.compactAtBytes = options.compactAtBytes ?? HISTORY_COMPACT_AT_BYTES;
    this.onWarning = options.onWarning;
  }

  async loadInto(store: RuntimeSessionStore): Promise<void> {
    try {
      const fileSize = await this.sizeBytes();
      if (fileSize > this.maxBytes) {
        this.warn(`Daemon history exceeds maximum size (${fileSize} > ${this.maxBytes})`);
        return;
      }
      const input = createReadStream(this.path, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            this.warn("Ignoring corrupt daemon history suffix");
            break;
          }
          if (!isHistoryRecord(record)) {
            this.warn("Ignoring unsupported daemon history suffix");
            break;
          }
          if (record.kind === "checkpoint") {
            store.restore({ ...record.snapshot, auth: undefined });
          } else if (record.event.type !== "auth.required") {
            store.consume(boundRuntimeEvent(record.event));
          }
        }
      } finally {
        lines.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  append(event: RuntimeEvent, snapshot: RuntimeSessionSnapshot): Promise<void> {
    if (event.type === "auth.required") return Promise.resolve();
    const boundedEvent = redactEvent(boundRuntimeEvent(event));
    const line = `${JSON.stringify({ stateVersion: STATE_VERSION, kind: "event", event: boundedEvent } satisfies HistoryRecord)}\n`;
    return this.enqueue(async () => {
      const currentSize = await this.sizeBytes();
      if (currentSize >= this.compactAtBytes || currentSize + Buffer.byteLength(line) > this.maxBytes) {
        await this.writeCheckpoint(snapshot);
        return;
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    });
  }

  compact(snapshot: RuntimeSessionSnapshot): Promise<void> {
    return this.enqueue(() => this.writeCheckpoint(snapshot));
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writeChain.then(operation);
    this.writeChain = result.catch(() => {});
    return result;
  }

  private async writeCheckpoint(snapshot: RuntimeSessionSnapshot): Promise<void> {
    const { auth: _auth, ...base } = snapshot;
    const redactedBase = redactValue(base) as PersistedRuntimeSnapshot;
    let rows = redactedBase.rows.slice(-50);
    let persisted: PersistedRuntimeSnapshot = { ...redactedBase, rows, counts: countRows(rows) };
    let content = `${JSON.stringify({ stateVersion: STATE_VERSION, kind: "checkpoint", snapshot: persisted } satisfies HistoryRecord)}\n`;
    while (Buffer.byteLength(content) > this.maxBytes && rows.length > 0) {
      rows = rows.slice(1);
      persisted = { ...redactedBase, rows, counts: countRows(rows) };
      content = `${JSON.stringify({ stateVersion: STATE_VERSION, kind: "checkpoint", snapshot: persisted } satisfies HistoryRecord)}\n`;
    }
    if (Buffer.byteLength(content) > this.maxBytes) {
      throw new Error("Daemon history checkpoint exceeds maximum size");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const handle = await open(tempPath, "wx", 0o600);
    let closed = false;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(tempPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      if (!closed) await handle.close().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.onWarning?.(message);
  }
}

function countRows(rows: PersistedRuntimeSnapshot["rows"]): PersistedRuntimeSnapshot["counts"] {
  return {
    total: rows.length,
    running: rows.filter((row) => row.status === "running").length,
    completed: rows.filter((row) => row.status === "completed").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.stateVersion === STATE_VERSION &&
    (record.kind === "checkpoint" || record.kind === "event") &&
    (record.kind === "checkpoint" ? isSnapshot(record.snapshot) : isRuntimeEvent(record.event));
}

function isSnapshot(value: unknown): value is PersistedRuntimeSnapshot {
  return !!value && typeof value === "object" &&
    Array.isArray((value as { rows?: unknown }).rows) &&
    typeof (value as { connection?: unknown }).connection === "string";
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
