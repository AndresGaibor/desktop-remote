import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchManager } from "../../src/search/manager";

describe("SearchManager", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "search-manager-"));
    await writeFile(join(root, "alpha.ts"), "needle\n");
    await writeFile(join(root, "beta.ts"), "needle again\n");
    await writeFile(join(root, "notes.md"), "other text\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("searches file names and paginates limited results", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: ".ts",
      mode: "files",
      maxResults: 2,
    });

    expect(search.status).toBe("running");
    await waitForDone(manager, search.id);
    const page = await manager.getMore(search.id, 0, 1);

    expect(page.results).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.done).toBe(false);
    expect(page.results[0]).toEndWith("alpha.ts");

    const rest = await manager.getMore(search.id, 1, 1);
    expect(rest.results[0]).toEndWith("beta.ts");
    expect(rest.done).toBe(true);
  });

  test("searches file content and reports completed status", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results).toEqual([
      { path: join(root, "alpha.ts"), line: 1, column: 1, match: "needle", before: [], after: [] },
      { path: join(root, "beta.ts"), line: 1, column: 1, match: "needle", before: [], after: [] },
    ]);
    expect(result.total).toBe(2);
    expect(result.done).toBe(true);
    expect(manager.list()).toEqual([{ id: search.id, status: "completed" }]);
  });

  test("stops a search and rejects unknown searches", async () => {
    const manager = new SearchManager();
    const search = await manager.start({ root, pattern: ".", mode: "files" });

    await manager.stop(search.id);
    expect(manager.list()).toEqual([{ id: search.id, status: "stopped" }]);
    await expect(manager.getMore("missing", 0, 1)).rejects.toThrow(
      "Search not found",
    );
  });

  test("maxResults trunca y marca truncated true", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: ".",
      mode: "files",
      maxResults: 1,
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results).toHaveLength(1);
    expect(result.done).toBe(true);
    expect(result.truncated).toBe(true);

    const full = await manager.getMore(search.id, 0, 100);
    expect(full.results).toHaveLength(1);
    expect(full.truncated).toBe(true);
  });

  test("timeoutMs corta la busqueda antes de terminar", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      timeoutMs: 0,
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  test("returns content matches with line, column, and surrounding context", async () => {
    const manager = new SearchManager();
    const path = join(root, "context.txt");
    await writeFile(path, "zero\nneedle one\nmiddle\nneedle two\nlast\n");

    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      contextLines: 1,
      filePattern: "context.txt",
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results).toEqual([
      { path, line: 2, column: 1, match: "needle", before: ["zero"], after: ["middle"] },
      { path, line: 4, column: 1, match: "needle", before: ["middle"], after: ["last"] },
    ]);
  });

  test("returns every match on a line in source order", async () => {
    const manager = new SearchManager();
    const path = join(root, "multiple.txt");
    await writeFile(path, "x needle y needle z\n");

    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      contextLines: 0,
      filePattern: "multiple.txt",
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results).toEqual([
      { path, line: 1, column: 3, match: "needle", before: [], after: [] },
      { path, line: 1, column: 12, match: "needle", before: [], after: [] },
    ]);
  });

  test("getMore returns the current page without waiting for traversal completion", async () => {
    const manager = new SearchManager();
    await Promise.all(Array.from({ length: 300 }, async (_, index) => {
      const directory = join(root, `dir-${String(index).padStart(3, "0")}`);
      await mkdir(directory);
      await Bun.write(join(directory, "match.txt"), "needle");
    }));

    const search = await manager.start({ root, pattern: "match", mode: "files" });
    const page = await Promise.race([
      manager.getMore(search.id, 0, 1),
      Bun.sleep(10).then(() => null),
    ]);

    expect(page).not.toBeNull();
  });

  test("earlyTermination stops after the first matching result", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      earlyTermination: true,
    });

    const result = await waitForDone(manager, search.id);

    expect(result.results).toHaveLength(1);
    expect(result.done).toBe(true);
  });

  test("earlyTermination stops after the first match on a line", async () => {
    const manager = new SearchManager();
    const path = join(root, "early.txt");
    await writeFile(path, "needle and needle\n");
    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      contextLines: 0,
      filePattern: "early.txt",
      earlyTermination: true,
    });

    const result = await waitForDone(manager, search.id);

    expect(result.results).toHaveLength(1);
    expect((result.results[0] as { column: number }).column).toBe(1);
  });

  test("expires completed search sessions after their bounded TTL", async () => {
    const manager = new SearchManager({ sessionTtlMs: 10 });
    const search = await manager.start({ root, pattern: "needle", mode: "content" });
    await manager.getMore(search.id, 0, 10);
    await Bun.sleep(30);

    expect(manager.list()).toEqual([]);
    await expect(manager.getMore(search.id, 0, 1)).rejects.toThrow("Search not found");
  });

  test("onResult recibe resultados de forma incremental sin cargar archivo entero", async () => {
    const manager = new SearchManager();
    const received: string[] = [];

    const largeFile = join(root, "large.txt");
    const ws = createWriteStream(largeFile);
    for (let i = 0; i < 1000; i++) {
      ws.write(`line ${i} contains needle here\n`);
    }
    ws.end();
    await new Promise<void>((res) => ws.on("finish", res));

    await manager.start({
      root,
      pattern: "needle",
      mode: "content",
      onResult: (file) => {
        received.push(file);
      },
    });

    await Bun.sleep(50);
    expect(received.length).toBeGreaterThan(0);
    expect(received.some((f) => f.includes("large.txt"))).toBe(true);
  });

  test("comportamiento por defecto sigue funcionando sin onResult ni maxResults", async () => {
    const manager = new SearchManager();
    const search = await manager.start({
      root,
      pattern: "needle",
      mode: "content",
    });
    const result = await waitForDone(manager, search.id);

    expect(result.results).toContainEqual(expect.objectContaining({ path: join(root, "alpha.ts") }));
    expect(result.results).toContainEqual(expect.objectContaining({ path: join(root, "beta.ts") }));
    expect(result.truncated).toBeUndefined();
  });
});

async function waitForDone(manager: SearchManager, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await manager.getMore(id, 0, 100);
    if (result.done) return result;
    await Bun.sleep(1);
  }
  throw new Error("search did not complete within the test deadline");
}
