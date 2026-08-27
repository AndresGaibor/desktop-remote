import { createHash } from "node:crypto";
import { open, readFile, rename, stat, unlink, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EditRange {
  start: number;
  end: number;
}

export interface EditBlockOptions {
  replace_all?: boolean;
  range?: EditRange;
  content?: string;
  expected_replacements?: number;
  expected_sha256?: string;
}

export async function editBlock(
  path: string,
  oldString?: string,
  newString?: string,
  options: EditBlockOptions = {},
): Promise<{ path: string; edited: true }> {
  const target = requirePath(path);
  const originalBytes = await readFile(target);
  verifyExpectedHash(originalBytes, options.expected_sha256);

  const original = originalBytes.toString("utf8");
  const replacement = createReplacement(original, oldString, newString, options);
  const fileMode = (await stat(target)).mode & 0o7777;
  await atomicReplace(target, Buffer.from(replacement, "utf8"), fileMode);
  return { path: target, edited: true };
}

function createReplacement(
  original: string,
  oldString: string | undefined,
  newString: string | undefined,
  options: EditBlockOptions,
): string {
  const hasExactMode = oldString !== undefined || newString !== undefined;
  const hasRangeMode = options.range !== undefined || options.content !== undefined;

  if (hasExactMode && hasRangeMode) {
    throw new Error("edit_block accepts either old_string/new_string or range/content, not both");
  }

  if (hasRangeMode) {
    if (options.range === undefined || typeof options.content !== "string") {
      throw new Error("range and content are required together");
    }
    validateRange(options.range, original.length);
    return original.slice(0, options.range.start) + options.content + original.slice(options.range.end);
  }

  if (typeof oldString !== "string" || typeof newString !== "string") {
    throw new Error("old_string and new_string are required together");
  }
  if (!oldString) {
    throw new Error("old_string must not be empty");
  }

  const matches = countMatches(original, oldString);
  if (matches === 0) {
    throw new Error("old_string not found");
  }
  const expected = options.expected_replacements ?? (options.replace_all ? matches : 1);
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    throw new Error("expected_replacements must be a positive integer");
  }
  if (matches !== expected) {
    if (expected === 1 && matches > 1 && !options.replace_all) {
      throw new Error("old_string is not unique");
    }
    throw new Error(`expected ${expected} replacements but found ${matches}`);
  }

  return expected === 1 && !options.replace_all
    ? original.replace(oldString, newString)
    : original.replaceAll(oldString, newString);
}

function validateRange(range: EditRange, length: number): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > length
  ) {
    throw new Error("range must contain valid character offsets");
  }
}

function verifyExpectedHash(content: Buffer, expectedSha256: string | undefined): void {
  if (expectedSha256 === undefined) return;
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("expected_sha256 must be a 64-character hexadecimal SHA-256 hash");
  }
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`edit conflict: expected sha256 ${expectedSha256}, found ${actual}`);
  }
}

async function atomicReplace(target: string, content: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(target), `.${target.split(/[\\/]/).pop() ?? "edit"}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await chmod(temporary, mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function countMatches(content: string, search: string): number {
  let count = 0;
  let position = 0;
  while ((position = content.indexOf(search, position)) !== -1) {
    count += 1;
    position += search.length;
  }
  return count;
}

function requirePath(path: string): string {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    throw new Error("path must be a safe non-empty string");
  }
  return path;
}
