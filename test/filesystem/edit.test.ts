import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  test("honors expected_replacements exactly before replacing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "old\nold\n", "utf8");

    await expect(editBlock(path, "old", "new", { expected_replacements: 2 }))
      .resolves.toEqual({ path, edited: true });
    await expect(readFile(path, "utf8")).resolves.toBe("new\nnew\n");

    await expect(editBlock(path, "new", "changed", { expected_replacements: 3 }))
      .rejects.toThrow(/expected.*3|replacement.*3/i);
    await expect(readFile(path, "utf8")).resolves.toBe("new\nnew\n");
  });

  test("replaces an explicit character range with content", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    await expect(editBlock(path, undefined, undefined, {
      range: { start: 6, end: 10 },
      content: "BETA",
    })).resolves.toEqual({ path, edited: true });
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\nBETA\ngamma");
  });

  test("rejects a stale expected_sha256 without changing the file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    const original = "before\nold\nafter";
    await writeFile(path, original, "utf8");
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    await writeFile(path, "changed\nold\nafter", "utf8");

    await expect(editBlock(path, "old", "new", { expected_sha256: expectedSha256 }))
      .rejects.toThrow(/conflict|changed|sha/i);
    await expect(readFile(path, "utf8")).resolves.toBe("changed\nold\nafter");
  });

  test("atomically replaces content while preserving the existing file mode", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "note.txt");
    await writeFile(path, "old", "utf8");
    await chmod(path, 0o754);

    await editBlock(path, "old", "new");

    expect((await stat(path)).mode & 0o777).toBe(0o754);
    await expect(readFile(path, "utf8")).resolves.toBe("new");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-edit-"));
  directories.push(directory);
  return directory;
}
