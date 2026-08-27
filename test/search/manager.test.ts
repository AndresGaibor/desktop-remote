import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const result = await manager.getMore(search.id, 0, 10);

    expect(result.results).toEqual([
      join(root, "alpha.ts"),
      join(root, "beta.ts"),
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
    const result = await manager.getMore(search.id, 0, 10);

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
    const result = await manager.getMore(search.id, 0, 10);

    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
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
    const result = await manager.getMore(search.id, 0, 10);

    expect(result.results).toContain(join(root, "alpha.ts"));
    expect(result.results).toContain(join(root, "beta.ts"));
    expect(result.truncated).toBeUndefined();
  });
});
