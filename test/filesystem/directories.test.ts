import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectory, listDirectory, moveFile } from "../../src/filesystem/directories";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("filesystem directories", () => {
  test("creates a directory and lists its entries with their types", async () => {
    const directory = await temporaryDirectory();
    const nested = join(directory, "nested");
    await createDirectory(nested);
    await writeFile(join(nested, "note.txt"), "text", "utf8");

    await expect(listDirectory(directory)).resolves.toEqual([{ name: "nested", type: "directory" }]);
    await expect(listDirectory(nested)).resolves.toEqual([{ name: "note.txt", type: "file" }]);
  });

  test("moves a file to a new path", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "old.txt");
    const destination = join(directory, "new.txt");
    await writeFile(source, "content", "utf8");

    await expect(moveFile(source, destination)).resolves.toEqual({ source, destination, moved: true });
    await expect(readFile(destination, "utf8")).resolves.toBe("content");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-directories-"));
  directories.push(directory);
  return directory;
}
