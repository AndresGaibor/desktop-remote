import { readFile, writeFile } from "node:fs/promises";

export interface EditBlockOptions {
  replace_all?: boolean;
}

export async function editBlock(
  path: string,
  oldString: string,
  newString: string,
  options: EditBlockOptions = {},
): Promise<{ path: string; edited: true }> {
  const target = requirePath(path);
  const content = await readFile(target, "utf8");
  const matches = countMatches(content, oldString);
  if (matches === 0) throw new Error("old_string not found");
  if (matches > 1 && !options.replace_all) throw new Error("old_string is not unique");
  const replacement = options.replace_all ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
  await writeFile(target, replacement, "utf8");
  return { path: target, edited: true };
}

function countMatches(content: string, search: string): number {
  if (!search) return 0;
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
