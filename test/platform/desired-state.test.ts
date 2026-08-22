import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDesiredState, writeDesiredState } from "../../src/platform/desired-state";
import { writeAtomicJson } from "../../src/platform/atomic-file";

describe("desired state", () => {
  test("missing desired-state file defaults to running without creating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-state-"));
    const path = join(dir, "desired-state.json");
    expect(await readDesiredState(path)).toBe("running");
    expect(Bun.file(path).size).toBe(0);
  });

  test("running and stopped round-trip with user-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-state-"));
    const path = join(dir, "desired-state.json");
    await writeDesiredState(path, "stopped");
    expect(await readDesiredState(path)).toBe("stopped");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeDesiredState(path, "running");
    expect(await readDesiredState(path)).toBe("running");
  });

  test("malformed or unsupported desired state is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-state-"));
    const path = join(dir, "desired-state.json");
    await writeFile(path, "not-json", "utf8");
    await expect(readDesiredState(path)).rejects.toThrow(/desired state/i);
    await writeFile(path, JSON.stringify({ state: "paused" }), "utf8");
    await expect(readDesiredState(path)).rejects.toThrow(/desired state/i);
  });

  test("failed atomic replacement preserves the previous valid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-state-"));
    const path = join(dir, "desired-state.json");
    await writeAtomicJson(path, { state: "running" });
    await expect(writeAtomicJson(path, { state: "stopped" }, 0o600, {
      rename: async () => { throw new Error("rename failed"); },
    })).rejects.toThrow("rename failed");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ state: "running" });
  });
});
