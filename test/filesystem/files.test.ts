import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, writeTextFile } from "../../src/filesystem/files";
import { type TextPage } from "../../src/filesystem/files";

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
      truncated: false,
    });
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\nfour");
  });

  test("rejects negative pagination and empty write paths", async () => {
    const directory = await temporaryDirectory();

    await expect(readTextFile(join(directory, "missing.txt"), { offset: -1, length: 1 }))
      .rejects.toThrow(/offset/i);
    await expect(writeTextFile("", "text")).rejects.toThrow(/path/i);
  });

  test("marks truncated when total lines exceed requested page", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.txt");

    await writeTextFile(path, "one\ntwo\nthree\nfour\nfive");

    const result = await readTextFile(path, { offset: 0, length: 2 });
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(5);
    expect(result.content).toBe("one\ntwo");
  });

  test("does not mark truncated when all lines are returned", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.txt");

    await writeTextFile(path, "one\ntwo\nthree");

    const result = await readTextFile(path, { offset: 0, length: 10 });
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe("one\ntwo\nthree");
  });

  test("file on disk is not modified by read operation", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.txt");

    await writeTextFile(path, "line1\nline2\nline3\nline4\nline5");
    await readTextFile(path, { offset: 1, length: 2 });

    expect(await readFile(path, "utf8")).toBe("line1\nline2\nline3\nline4\nline5");
  });

  test("respects lineLimit option when provided", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "notes.txt");

    await writeTextFile(path, "a\n".repeat(200));

    const result = await readTextFile(path, { offset: 0, length: 50, lineLimit: 100 });
    expect(result.content.split("\n").length - 1).toBeLessThanOrEqual(100);
    expect(result.truncated).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-files-"));
  directories.push(directory);
  return directory;
}
