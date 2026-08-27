import { appendFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "readline";
import { dirname } from "node:path";

export interface TextPage {
  content: string;
  totalLines?: number;
  offset: number;
  length: number;
  truncated: boolean;
  hasMore?: boolean;
}

export interface ReadTextFileOptions {
  offset?: number;
  length?: number;
  lineLimit?: number;
  signal?: AbortSignal;
  /** Límite interno para respuestas URL; no forma parte de la configuración del usuario. */
  maxBytes?: number;
}

const DEFAULT_LINE_LIMIT = 1000;
const DEFAULT_URL_MAX_BYTES = 4 * 1024 * 1024;
const COMPATIBILITY_TOTAL_LINES_MAX_BYTES = 256 * 1024;

export async function readTextFile(path: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  validatePageOptions(offset, length, lineLimit);
  throwIfAborted(options.signal);
  const effectiveLength = Math.min(length, lineLimit);

  const target = requirePath(path);
  const fileSize = (await stat(target)).size;
  return streamReadLines(target, offset, effectiveLength, options.signal, fileSize <= COMPATIBILITY_TOTAL_LINES_MAX_BYTES);
}

async function streamReadLines(
  path: string,
  skipLines: number,
  takeLines: number,
  signal: AbortSignal | undefined,
  countRemainingForCompatibility: boolean,
): Promise<TextPage> {
  const lines: string[] = [];
  let seenLines = 0;
  let hasMore = false;
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const abort = () => stream.destroy(abortError(signal));
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const line of rl) {
      throwIfAborted(signal);
      if (seenLines >= skipLines && lines.length < takeLines) {
        lines.push(line);
      } else if (seenLines >= skipLines && lines.length >= takeLines) {
        hasMore = true;
        if (!countRemainingForCompatibility) break;
      }
      seenLines += 1;
    }
    const result: TextPage = {
      content: lines.join("\n"),
      offset: skipLines,
      length: lines.length,
      truncated: hasMore,
      ...(hasMore ? { hasMore: true } : { totalLines: seenLines }),
    };
    if (hasMore && countRemainingForCompatibility) result.totalLines = seenLines;
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    rl.close();
    stream.destroy();
  }
}

export async function readUrl(url: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  validatePageOptions(offset, length, lineLimit);
  const maxBytes = options.maxBytes ?? DEFAULT_URL_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  throwIfAborted(options.signal);

  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal);
    throw new Error(`Unable to read URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Unable to read URL: ${response.status} ${response.statusText}`);
  if (!response.body) {
    return { content: "", totalLines: 0, offset, length: 0, truncated: false };
  }
  return streamUrlLines(response.body, offset, Math.min(length, lineLimit), maxBytes, options.signal);
}

async function streamUrlLines(
  body: ReadableStream<Uint8Array>,
  offset: number,
  takeLines: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<TextPage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let pending = "";
  let seenLines = 0;
  let bytesRead = 0;
  let hasMore = false;
  let hitByteGuard = false;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = abortError(signal);
    rejectAbort?.(error);
    void reader.cancel(error).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  const consumeLine = (line: string) => {
    if (hasMore) return;
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (seenLines >= offset && lines.length < takeLines) lines.push(normalized);
    else if (seenLines >= offset && lines.length >= takeLines) hasMore = true;
    seenLines += 1;
  };

  const consumePendingLines = () => {
    while (!hasMore) {
      const newline = pending.indexOf("\n");
      if (newline === -1) return;
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  };

  try {
    throwIfAborted(signal);
    while (!hasMore && !hitByteGuard) {
      const next = await Promise.race([reader.read(), abortPromise]);
      if (next.done) {
        pending += decoder.decode();
        consumePendingLines();
        if (!hasMore && pending.length > 0) {
          consumeLine(pending);
          pending = "";
        }
        break;
      }

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        hitByteGuard = true;
        break;
      }
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      bytesRead += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) hitByteGuard = true;
      pending += decoder.decode(chunk, { stream: !hitByteGuard });
      consumePendingLines();
    }

    if (hitByteGuard && (pending.length > 0 || lines.length >= takeLines)) hasMore = true;
    const truncated = hasMore || hitByteGuard;
    return {
      content: lines.join("\n"),
      offset,
      length: lines.length,
      truncated,
      ...(truncated ? { hasMore: true } : { totalLines: seenLines }),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  const target = requirePath(path);
  const temporary = `${target}.desktop-remote-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function appendTextFile(path: string, content: string): Promise<void> {
  await appendFile(requirePath(path), content, "utf8");
}

function requirePath(path: string): string {
  if (!path.trim()) throw new Error("path is required");
  if (!dirname(path)) throw new Error("path is required");
  return path;
}

function validatePageOptions(offset: number, length: number, lineLimit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");
  if (!Number.isSafeInteger(lineLimit) || lineLimit < 1) throw new Error("lineLimit must be a positive integer");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Operation aborted");
}
