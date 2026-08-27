import { appendFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "readline";
import { dirname } from "node:path";

export interface TextPage {
  content: string;
  totalLines: number;
  offset: number;
  length: number;
  truncated: boolean;
}

export interface ReadTextFileOptions {
  offset?: number;
  length?: number;
  lineLimit?: number;
}

const DEFAULT_LINE_LIMIT = 1000;

export async function readTextFile(path: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");
  if (!Number.isSafeInteger(lineLimit) || lineLimit < 1) throw new Error("lineLimit must be a positive integer");
  const effectiveLength = Math.min(length, lineLimit);

  const target = requirePath(path);
  const page = await streamReadLines(target, offset, effectiveLength);
  const allLines = await streamReadAllLines(target, lineLimit);
  const totalLines = allLines.length;
  const truncated = (offset === 0 && effectiveLength < totalLines) || (effectiveLength >= lineLimit && offset + effectiveLength < totalLines);
  return { content: page.join("\n"), totalLines, offset, length: page.length, truncated };
}

async function streamReadLines(path: string, skipLines: number, takeLines: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let linesRead = 0;
    let skipped = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (skipped < skipLines) {
        skipped++;
        return;
      }
      if (linesRead < takeLines) {
        lines.push(line);
        linesRead++;
      }
      if (linesRead >= takeLines) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

async function streamReadAllLines(path: string, lineLimit: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let linesRead = 0;
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (linesRead < lineLimit) {
        lines.push(line);
        linesRead++;
      }
    });

    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

export async function readUrl(url: string, options: ReadTextFileOptions = {}): Promise<TextPage> {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");
  if (!Number.isSafeInteger(lineLimit) || lineLimit < 1) throw new Error("lineLimit must be a positive integer");

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Unable to read URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Unable to read URL: ${response.status} ${response.statusText}`);
  return paginateText(await response.text(), { offset, length, lineLimit });
}

function paginateText(text: string, options: ReadTextFileOptions): TextPage {
  const offset = options.offset ?? 0;
  const length = options.length ?? 200;
  const lineLimit = options.lineLimit ?? DEFAULT_LINE_LIMIT;
  const effectiveLength = Math.min(length, lineLimit);
  const lines = text.split("\n");
  const page = lines.slice(offset, offset + effectiveLength);
  const beyondPage = offset + effectiveLength;
  const truncated = beyondPage < lines.length;
  return { content: page.join("\n"), totalLines: lines.length, offset, length: page.length, truncated };
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
