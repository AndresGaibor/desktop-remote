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

  test("treats a generic bootstrap error as fatal", async () => {
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

    await expect(manager.start()).rejects.toThrow("launchctl bootstrap failed");

    expect(calls).not.toContainEqual(["launchctl", "print", "gui/501/com.desktop-remote.daemon"]);
    expect(calls).not.toContainEqual(["launchctl", "kickstart", "-k", "gui/501/com.desktop-remote.daemon"]);
  });

  test("reloads the LaunchAgent when its ProgramArguments change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-launchd-reload-"));
    const paths = makeTestPaths(dir);
    const calls: Array<{ args: string[] }> = [];
    let activeDefinition: { command: string; args: string[] } | undefined;
    const run = async (_command: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "bootout") {
        activeDefinition = undefined;
      }
      if (args[0] === "bootstrap") {
        const plist = await readFile(args[2]!, "utf8");
        const programArgumentsXml = plist.split("<key>ProgramArguments</key><array>")[1]?.split("</array>")[0] ?? "";
        const programArguments = [...programArgumentsXml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
        activeDefinition = { command: programArguments[0]!, args: programArguments.slice(1) };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const splitManager = new LaunchdManager({
      paths,
      run,
      uid: 501,
      daemonCommand: "desktop-remote-daemon",
      daemonArgs: [],
    });
    await splitManager.install();
    await splitManager.start();

    const singleManager = new LaunchdManager({ paths, run, uid: 501, daemonCommand: "desktop-remote", daemonArgs: ["daemon"] });
    await singleManager.install();
    calls.length = 0;
    await singleManager.start();

    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ["bootout", "gui/501/com.desktop-remote.daemon"],
      ["bootstrap", "gui/501"],
      ["enable", "gui/501/com.desktop-remote.daemon"],
      ["kickstart", "-k"],
    ]);
    expect(activeDefinition).toEqual({ command: "desktop-remote", args: ["daemon"] });
  });
});
