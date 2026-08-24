import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    const search = await manager.start({ root, pattern: ".ts", mode: "files", maxResults: 2 });

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
    const search = await manager.start({ root, pattern: "needle", mode: "content" });
    const result = await manager.getMore(search.id, 0, 10);

    expect(result.results).toEqual([join(root, "alpha.ts"), join(root, "beta.ts")]);
    expect(result.total).toBe(2);
    expect(result.done).toBe(true);
    expect(manager.list()).toEqual([{ id: search.id, status: "completed" }]);
  });

  test("stops a search and rejects unknown searches", async () => {
    const manager = new SearchManager();
    const search = await manager.start({ root, pattern: ".", mode: "files" });

    await manager.stop(search.id);
    expect(manager.list()).toEqual([{ id: search.id, status: "stopped" }]);
    await expect(manager.getMore("missing", 0, 1)).rejects.toThrow("Search not found");
  });
});
