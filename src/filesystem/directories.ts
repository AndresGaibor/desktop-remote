import { mkdir, opendir, rename } from "node:fs/promises";
import { join } from "node:path";

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export interface DirectoryPage {
  entries: DirectoryEntry[];
  cursor?: string;
  hasMore: boolean;
  truncated?: boolean;
}

export interface ListDirectoryOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export const DEFAULT_DIRECTORY_PAGE_SIZE = 200;

export async function createDirectory(path: string): Promise<{ path: string; created: true }> {
  const target = requirePath(path);
  await mkdir(target, { recursive: true });
  return { path: target, created: true };
}

export function listDirectory(path: string, depth?: number): Promise<DirectoryEntry[]>;
export function listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryPage>;
export function listDirectory(path: string, depth: number, options: ListDirectoryOptions): Promise<DirectoryPage>;
export async function listDirectory(
  path: string,
  depthOrOptions: number | ListDirectoryOptions = 0,
  providedOptions?: ListDirectoryOptions,
): Promise<DirectoryEntry[] | DirectoryPage> {
  const target = requirePath(path);
  const depth = typeof depthOrOptions === "number" ? depthOrOptions : 0;
  const options = typeof depthOrOptions === "number" ? providedOptions : depthOrOptions;
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("depth must be a non-negative integer");
  const page = await listDirectoryPage(target, depth, options ?? {});
  return options === undefined ? page.entries : page;
}

async function listDirectoryPage(path: string, depth: number, options: ListDirectoryOptions): Promise<DirectoryPage> {
  const limit = options.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const start = parseCursor(options.cursor);
  throwIfAborted(options.signal);

  const entries: DirectoryEntry[] = [];
  let index = 0;
  let hasMore = false;
  for await (const entry of walkDirectory(path, depth, "", options.signal)) {
    if (index < start) {
      index += 1;
      continue;
    }
    if (entries.length >= limit) {
      hasMore = true;
      break;
    }
    entries.push(entry);
    index += 1;
  }

  return {
    entries,
    hasMore,
    truncated: hasMore || undefined,
    ...(hasMore ? { cursor: String(start + entries.length) } : {}),
  };
}

async function* walkDirectory(
  path: string,
  depth: number,
  prefix: string,
  signal?: AbortSignal,
): AsyncGenerator<DirectoryEntry> {
  throwIfAborted(signal);
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      throwIfAborted(signal);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const type = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
      yield { name, type };
      if (type === "directory" && depth > 0) {
        yield* walkDirectory(join(path, entry.name), depth - 1, name, signal);
      }
    }
  } finally {
    if (typeof directory.close === "function") {
      try {
        await directory.close();
      } catch {
        // El iterador async ya cierra el descriptor cuando close no está disponible.
      }
    }
  }
}

export async function moveFile(source: string, destination: string): Promise<{
  source: string;
  destination: string;
  moved: true;
}> {
  const from = requirePath(source);
  const to = requirePath(destination);
  await rename(from, to);
  return { source: from, destination: to, moved: true };
}

function requirePath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    throw new Error("path must be a safe non-empty string");
  }
  return path;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("cursor must be a non-negative integer");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error("cursor must be a safe non-negative integer");
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw new Error("Operation aborted");
  }
}
