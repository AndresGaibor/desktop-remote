import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopOperationExecutor } from "../../src/core/executor";
import { ConfigStore } from "../../src/config/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DesktopOperationExecutor", () => {
  test("executes read_file through the local filesystem implementation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-executor-"));
    directories.push(directory);
    const path = join(directory, "note.txt");
    await writeFile(path, "first\nsecond", "utf8");

    await expect(new DesktopOperationExecutor().execute("read_file", { path, offset: 1, length: 1 }))
      .resolves.toEqual({ content: "second", totalLines: 2, offset: 1, length: 1, truncated: false });
  });

  test("rejects operations that have no implementation", async () => {
    await expect(new DesktopOperationExecutor().execute("unknown", {}))
      .rejects.toThrow(/not implemented/i);
  });

  test("executes write_file through the local filesystem implementation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-executor-"));
    directories.push(directory);
    const path = join(directory, "note.txt");

    await expect(new DesktopOperationExecutor().execute("write_file", { path, content: "created" }))
      .resolves.toEqual({ path, written: true });
    await expect(readFile(path, "utf8")).resolves.toBe("created");
  });

  test("executes edit_block find/replace with expected_replacements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-edit-executor-"));
    directories.push(directory);
    const path = join(directory, "note.txt");
    await writeFile(path, "old\nold\n", "utf8");

    await expect(new DesktopOperationExecutor().execute("edit_block", {
      file_path: path,
      old_string: "old",
      new_string: "new",
      expected_replacements: 2,
    })).resolves.toEqual({ path, edited: true });
    await expect(readFile(path, "utf8")).resolves.toBe("new\nnew\n");
  });

  test("paginates list_directory using limit and cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-directory-executor-"));
    directories.push(directory);
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(directory, `entry-${index}.txt`), "", "utf8")));

    const executor = new DesktopOperationExecutor();
    const first = await executor.execute("list_directory", { path: directory, depth: 0, limit: 3 }) as {
      entries: Array<{ name: string }>;
      cursor?: string;
      hasMore: boolean;
    };
    const second = await executor.execute("list_directory", {
      path: directory,
      depth: 0,
      limit: 3,
      cursor: first.cursor,
    }) as { entries: Array<{ name: string }>; hasMore: boolean };

    expect(first.entries).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(second.entries).toHaveLength(3);
    expect(second.entries[0]?.name).not.toBe(first.entries[0]?.name);
  });

  test("usa el formato Excel para escribir y leer archivos de hoja de cálculo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-excel-executor-"));
    directories.push(directory);
    const path = join(directory, "datos.xlsm");
    const content = JSON.stringify([["a", "b"], [1, 2]]);

    await expect(new DesktopOperationExecutor().execute("write_file", { path, content }))
      .resolves.toEqual({ path, written: true, format: "excel" });
    await expect(new DesktopOperationExecutor().execute("read_file", { path }))
      .resolves.toEqual({ content: [["a", "b"], [1, 2]], format: "excel" });
  });

  test("usa los formatos de documento para escribir PDF y DOCX", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-document-executor-"));
    directories.push(directory);
    const executor = new DesktopOperationExecutor();

    await expect(executor.execute("write_file", { path: join(directory, "nota.pdf"), content: "Hola" }))
      .resolves.toMatchObject({ written: true, format: "pdf" });
    await expect(executor.execute("write_file", { path: join(directory, "nota.docx"), content: "Hola" }))
      .resolves.toMatchObject({ written: true, format: "docx" });
  });

  test("starts a process and returns its captured output", async () => {
    const executor = new DesktopOperationExecutor();
    const started = await executor.execute("start_process", { command: ["bun", "-e", "console.info('ready')"] });
    const id = (started as { id: string }).id;

    expect(started).toMatchObject({ id: expect.any(String), pid: expect.any(Number) });
    const output = await executor.execute("read_process_output", { id });
    expect(output).toMatchObject({ status: "completed", output: "ready\n", exitCode: 0 });
  });

  test("dispatches cwd and env overrides for managed processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-process-cwd-"));
    directories.push(directory);
    const executor = new DesktopOperationExecutor();
    const started = await executor.execute("start_process", {
      command: [process.execPath, "-e", "process.stdout.write(process.cwd() + ':' + process.env.EXECUTOR_MARKER)"],
      cwd: directory,
      env: { EXECUTOR_MARKER: "configured" },
      timeout_ms: 5000,
    }) as { id: string };

    const resolved = await realpath(directory);
    await expect(executor.execute("read_process_output", { id: started.id }))
      .resolves.toMatchObject({ stdout: `${resolved}:configured`, cwd: directory });
  });

  test("executes search lifecycle operations through SearchManager", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-search-"));
    directories.push(directory);
    await writeFile(join(directory, "match.txt"), "needle", "utf8");
    await writeFile(join(directory, "other.txt"), "other", "utf8");

    const executor = new DesktopOperationExecutor();
    const started = await executor.execute("start_search", {
      path: directory,
      pattern: "needle",
      searchType: "content",
      contextLines: 0,
      earlyTermination: true,
    }) as { id: string; status: string };
    const searchId = started.id;
    expect(started.id).toEqual(expect.any(String));
    expect(started.status).toBe("running");
    const page = await executor.execute("get_more_search_results", {
      sessionId: searchId,
      offset: 0,
      length: 10,
    });
    expect(page).toMatchObject({
      id: searchId,
      results: [{ path: join(directory, "match.txt"), line: 1, column: 1, match: "needle", before: [], after: [] }],
      total: 1,
      done: true,
    });
    await expect(executor.execute("list_searches", {})).resolves.toEqual([
      { id: searchId, status: "completed" },
    ]);
    await expect(executor.execute("stop_search", { sessionId: searchId })).resolves.toBeUndefined();
  });

  test("validates search operation inputs", async () => {
    const executor = new DesktopOperationExecutor();
    await expect(executor.execute("start_search", { path: "/tmp", pattern: "x", searchType: "invalid" }))
      .rejects.toThrow(/searchType/i);
    await expect(executor.execute("get_more_search_results", { sessionId: "x", offset: -1, length: 1 }))
      .rejects.toThrow(/offset/i);
  });

  test("telemetry persistence failure never turns an operational success into failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-telemetry-"));
    directories.push(directory);
    const path = join(directory, "note.txt");
    const executor = new DesktopOperationExecutor(undefined, new FailingRecordConfigStore(join(directory, "config.json")));

    await expect(executor.execute("write_file", { path, content: "created" }))
      .resolves.toEqual({ path, written: true });
    await expect(readFile(path, "utf8")).resolves.toBe("created");
  });

  test("telemetry persistence failure never masks the original operational error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-remote-telemetry-"));
    directories.push(directory);
    const executor = new DesktopOperationExecutor(undefined, new FailingRecordConfigStore(join(directory, "config.json")));

    await expect(executor.execute("unknown", {})).rejects.toThrow("Operation is not implemented: unknown");
  });
});

class FailingRecordConfigStore extends ConfigStore {
  override async recordToolCall(): Promise<void> {
    throw new Error("telemetry disk unavailable");
  }
}
