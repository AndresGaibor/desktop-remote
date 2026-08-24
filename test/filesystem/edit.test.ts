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

  test("fails when the block is absent or ambiguous", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "same\nsame", "utf8");

    await expect(editBlock(path, "missing", "new")).rejects.toThrow(/0|match/i);
    await expect(editBlock(path, "same", "new")).rejects.toThrow(/multiple|match/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-edit-"));
  directories.push(directory);
  return directory;
}
