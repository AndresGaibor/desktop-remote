import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

  return paginateText(await readFile(requirePath(path), "utf8"), { offset, length });
}

export async function readUrl(url: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Unable to read URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Unable to read URL: ${response.status} ${response.statusText}`);
  return paginateText(await response.text(), { offset, length });
}

function paginateText(text: string, options: ReadTextFileOptions): TextPage {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lines = text.split("\n");
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

export async function appendTextFile(path: string, content: string): Promise<void> {
  await appendFile(requirePath(path), content, "utf8");
}

function requirePath(path: string): string {
  if (!path.trim()) throw new Error("path is required");
  if (!dirname(path)) throw new Error("path is required");
  return path;
}
