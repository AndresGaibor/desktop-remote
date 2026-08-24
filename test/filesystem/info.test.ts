import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFileInfo } from "../../src/filesystem/info";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("returns basic metadata for a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-info-"));
  directories.push(directory);
  const path = join(directory, "note.txt");
  await writeFile(path, "hello", "utf8");

  await expect(getFileInfo(path)).resolves.toMatchObject({
    path,
    size: 5,
    isFile: true,
    isDirectory: false,
  });
});
