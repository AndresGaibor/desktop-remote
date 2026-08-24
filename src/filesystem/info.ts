import { lstat } from "node:fs/promises";

export interface FileInfo {
  path: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  accessedAt: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export async function getFileInfo(path: string): Promise<FileInfo> {
  const target = requirePath(path);
  const stats = await lstat(target);
  return {
    path: target,
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

function requirePath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    throw new Error("path must be a safe non-empty string");
  }
  return path;
}
