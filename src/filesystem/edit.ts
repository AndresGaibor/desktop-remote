import { readFile, writeFile } from "node:fs/promises";

export async function editBlock(path: string, oldString: string, newString: string): Promise<{
  path: string;
  edited: true;
}> {
  const target = requirePath(path);
  const content = await readFile(target, "utf8");
  const matches = countMatches(content, oldString);
  if (matches === 0) throw new Error("edit block must match exactly once: found 0 matches");
  if (matches > 1) throw new Error(`edit block must match exactly once: found ${matches} matches`);
  await writeFile(target, content.replace(oldString, newString), "utf8");
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
