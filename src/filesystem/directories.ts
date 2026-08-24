import { mkdir, readdir, rename } from "node:fs/promises";

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export async function createDirectory(path: string): Promise<{ path: string; created: true }> {
  const target = requirePath(path);
  await mkdir(target, { recursive: true });
  return { path: target, created: true };
}

export async function listDirectory(path: string, depth = 0): Promise<DirectoryEntry[]> {
  const target = requirePath(path);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("depth must be a non-negative integer");
  return listDirectoryEntries(target, depth, "");
}

async function listDirectoryEntries(path: string, depth: number, prefix: string): Promise<DirectoryEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const result: DirectoryEntry[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const type = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
    result.push({ name, type });
    if (type === "directory" && depth > 0) {
      result.push(...await listDirectoryEntries(`${path}/${entry.name}`, depth - 1, name));
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
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
