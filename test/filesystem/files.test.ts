import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFile, readUrl, writeTextFile } from "../../src/filesystem/files";
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
      truncated: true,
      hasMore: true,
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

  test("stops after the requested page and one lookahead on a huge file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "huge.txt");
    await writeFile(path, `${"page\n".repeat(2)}${"tail\n".repeat(250_000)}`, "utf8");

    const result = await readTextFile(path, { offset: 0, length: 2 });

    expect(result.content).toBe("page\npage");
    expect(result.length).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.totalLines).toBeUndefined();
  }, 10_000);

  test("streams URL content with a byte guard instead of calling response.text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\n"));
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;

    try {
      const result = await readUrl("https://example.test/large", { length: 2, maxBytes: 32 });

      expect(result.content).toBe("first");
      expect(result.truncated).toBe(true);
      expect(result.hasMore).toBe(true);
      expect(result.totalLines).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("aborts URL streaming when its signal is aborted", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    }), { status: 200 })) as unknown as typeof fetch;

    try {
      const pending = readUrl("https://example.test/slow", { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "desktop-remote-files-"));
  directories.push(directory);
  return directory;
}
