import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionDesktopCommander } from "../../src/platform/runtime-install";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

const VERSION = "0.2.47";

describe("runtime provisioning", () => {
  test("pins Desktop Commander 0.2.47 and stores absolute runtime metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-runtime-"));
    const paths = makeTestPaths(dir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "--version") return { exitCode: 0, stdout: "v22.4.1\n", stderr: "" };
      if (args[0] === "install") return { exitCode: 0, stdout: "installed\n", stderr: "" };
      if (args.some((arg) => arg.endsWith("package.json"))) return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const metadata = await provisionDesktopCommander(paths, run, {
      nodePath: "/usr/local/bin/node",
      bunPath: "/opt/homebrew/bin/bun",
      resolveDesktopCommanderEntry: () => join(paths.runtimeDir, "node_modules/@wonderwhy-er/desktop-commander/dist/index.js"),
    });

    const manifest = JSON.parse(await readFile(join(paths.runtimeDir, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@wonderwhy-er/desktop-commander": VERSION });
    expect(calls).toContainEqual({ command: "/usr/local/bin/node", args: ["--version"] });
    expect(calls.some((call) => call.command === "/opt/homebrew/bin/bun" && call.args[0] === "install")).toBe(true);
    expect(metadata).toEqual({
      version: 1,
      nodePath: "/usr/local/bin/node",
      desktopCommanderEntry: join(paths.runtimeDir, "node_modules/@wonderwhy-er/desktop-commander/dist/index.js"),
      desktopCommanderVersion: VERSION,
    });
    const persisted = JSON.parse(await readFile(paths.runtimeMetadataPath, "utf8"));
    expect(persisted).toEqual(metadata);
  });

  test("rejects Node versions below 18", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-runtime-old-node-"));
    const paths = makeTestPaths(dir);
    const run = async () => ({ exitCode: 0, stdout: "v16.20.2\n", stderr: "" });
    await expect(provisionDesktopCommander(paths, run, {
      nodePath: "/usr/bin/node",
      bunPath: "/usr/bin/bun",
      resolveDesktopCommanderEntry: () => "/tmp/index.js",
    })).rejects.toThrow(/Node.*18/i);
  });
});
