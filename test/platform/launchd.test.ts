import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchdManager } from "../../src/platform/launchd";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

describe("LaunchdManager", () => {
  test("writes a bounded user LaunchAgent and uses launchctl arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-launchd-"));
    const paths = makeTestPaths(dir);
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new LaunchdManager({ paths, run, uid: 501, daemonCommand: "/opt/dr/desktop-remote-daemon" });
    await manager.install();
    const plist = await readFile(paths.launchAgentPath!, "utf8");
    expect(plist).toContain("com.desktop-remote.daemon");
    expect(plist).toContain("/opt/dr/desktop-remote-daemon");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(plist).not.toContain("StandardOutPath");
    expect(plist).not.toContain("StandardErrorPath");

    await manager.start();
    await manager.restart();
    await manager.stop();
    expect(calls).toContainEqual(["launchctl", "enable", "gui/501/com.desktop-remote.daemon"]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", paths.launchAgentPath!]);
    expect(calls).toContainEqual(["launchctl", "kickstart", "-k", "gui/501/com.desktop-remote.daemon"]);
    expect(calls).toContainEqual(["launchctl", "disable", "gui/501/com.desktop-remote.daemon"]);
    expect(calls).toContainEqual(["launchctl", "bootout", "gui/501/com.desktop-remote.daemon"]);
  });

  test("treats a generic bootstrap error as already loaded when launchctl print confirms the service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-launchd-loaded-"));
    const paths = makeTestPaths(dir);
    const calls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args[0] === "bootstrap") return { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      if (args[0] === "print") return { exitCode: 0, stdout: "state = running\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new LaunchdManager({ paths, run, uid: 501, daemonCommand: "/opt/dr/desktop-remote" });

    await manager.start();

    expect(calls).toContainEqual(["launchctl", "print", "gui/501/com.desktop-remote.daemon"]);
    expect(calls).toContainEqual(["launchctl", "kickstart", "-k", "gui/501/com.desktop-remote.daemon"]);
  });
});
