import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editBlock } from "../../src/filesystem/edit";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("edit block", () => {
  test("replaces exactly one matching block", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "before\nold\nafter", "utf8");

    await expect(editBlock(path, "old", "new")).resolves.toEqual({ path, edited: true });
    await expect(readFile(path, "utf8")).resolves.toBe("before\nnew\nafter");
  });

  test("fails when the block is absent", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "before\nold\nafter", "utf8");

    await expect(editBlock(path, "missing", "new")).rejects.toThrow(/not found/i);
  });

  test("fails when the block is ambiguous (multiple matches without replace_all)", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "same\nsame", "utf8");

    await expect(editBlock(path, "same", "new")).rejects.toThrow(/not unique|ambiguous/i);
  });

  test("replace_all replaces all occurrences", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "foo\nold\nbar\nold\nbaz", "utf8");

    await expect(editBlock(path, "old", "new", { replace_all: true })).resolves.toEqual({ path, edited: true });
    await expect(readFile(path, "utf8")).resolves.toBe("foo\nnew\nbar\nnew\nbaz");
  });

  test("replace_all with zero matches fails", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "foo\nbar\nbaz", "utf8");

    await expect(editBlock(path, "missing", "new", { replace_all: true })).rejects.toThrow(/not found/i);
  });

  test("content outside edited block is preserved byte-for-byte", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    const original = "line1\nold_target\nline3\nold_target\nline5";
    await writeFile(path, original, "utf8");

    await expect(editBlock(path, "old_target", "new", { replace_all: true })).resolves.toEqual({ path, edited: true });
    const result = await readFile(path, "utf8");
    expect(result).toBe("line1\nnew\nline3\nnew\nline5");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-edit-"));
  directories.push(directory);
  return directory;
}
