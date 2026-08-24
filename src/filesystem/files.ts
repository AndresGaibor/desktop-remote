import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TextPage {
  content: string;
  totalLines: number;
  offset: number;
  length: number;
}

export interface ReadTextFileOptions {
  offset?: number;
  length?: number;
}

export async function readTextFile(path: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");

  const lines = (await readFile(requirePath(path), "utf8")).split("\n");
  const page = lines.slice(offset, offset + length);
  return { content: page.join("\n"), totalLines: lines.length, offset, length: page.length };
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

function requirePath(path: string): string {
  if (!path.trim()) throw new Error("path is required");
  if (!dirname(path)) throw new Error("path is required");
  return path;
}
