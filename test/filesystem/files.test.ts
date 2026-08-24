import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "../../src/filesystem/files";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("filesystem operations", () => {
  test("writes atomically and reads the requested line page", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.txt");

    await writeTextFile(path, "one\ntwo\nthree\nfour");

    expect(await readTextFile(path, { offset: 1, length: 2 })).toEqual({
      content: "two\nthree",
      totalLines: 4,
      offset: 1,
      length: 2,
    });
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\nfour");
  });

  test("rejects negative pagination and empty write paths", async () => {
    const directory = await temporaryDirectory();

    await expect(readTextFile(join(directory, "missing.txt"), { offset: -1, length: 1 }))
      .rejects.toThrow(/offset/i);
    await expect(writeTextFile("", "text")).rejects.toThrow(/path/i);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-files-"));
  directories.push(directory);
  return directory;
}
