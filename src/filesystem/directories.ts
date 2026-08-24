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

export async function listDirectory(path: string): Promise<DirectoryEntry[]> {
  const target = requirePath(path);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
    } as DirectoryEntry))
    .sort((left, right) => left.name.localeCompare(right.name));
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
