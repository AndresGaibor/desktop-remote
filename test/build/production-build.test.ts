import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProduction } from "../../scripts/build-production";

describe("production build", () => {
  test("keeps a clean single binary when daemon probe has no OpenTUI native load", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dr-build-single-"));
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const result = await buildProduction({ rootDir: "/repo", outDir, bunPath: "/usr/bin/bun", run, promote: false });
    expect(result.layout).toBe("single");
    expect(calls.some((call) => call.includes("--compile") && call.includes("/repo/bin/cli.ts"))).toBe(true);
    expect(calls.filter((call) => call.includes("--compile")).every((call) => call.includes("--no-compile-autoload-bunfig"))).toBe(true);
    expect(calls.some((call) => call.at(-2) === "daemon" && call.at(-1) === "--probe")).toBe(true);
    expect(JSON.parse(await readFile(join(outDir, "build-layout.json"), "utf8"))).toMatchObject({ layout: "single" });
  });

  test("falls back to split artifacts when single daemon probe loads OpenTUI", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "dr-build-split-"));
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (command.includes("candidate") && args.includes("--probe")) return { exitCode: 0, stdout: "", stderr: "loaded libopentui.dylib" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await buildProduction({ rootDir: "/repo", outDir, bunPath: "/usr/bin/bun", run, promote: false });
    expect(result.layout).toBe("split");
    expect(calls.some((call) => call.includes("/repo/bin/daemon.ts"))).toBe(true);
    expect(JSON.parse(await readFile(join(outDir, "build-layout.json"), "utf8"))).toMatchObject({ layout: "split", daemon: "desktop-remote-daemon" });
  });
});
