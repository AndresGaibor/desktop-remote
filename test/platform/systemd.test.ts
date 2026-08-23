import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemdUserManager } from "../../src/platform/systemd";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

describe("SystemdUserManager", () => {
  test("writes a user service and manages it with systemctl --user", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-systemd-"));
    const paths = makeTestPaths(dir);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
      return { exitCode: 0, stdout: "active\n", stderr: "" };
    };
    const manager = new SystemdUserManager({
      paths, run, daemonCommand: "/home/u/.local/bin/desktop-remote-daemon", uid: 1000,
      env: { HOME: "/home/u", PATH: "/usr/bin:/bin" },
    });
    await manager.install();
    const unit = await readFile(paths.systemdUserUnitPath!, "utf8");
    expect(unit).toContain("ExecStart=/home/u/.local/bin/desktop-remote-daemon");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10");
    expect(unit).toContain("WantedBy=default.target");

    await manager.start();
    await manager.restart();
    await manager.stop();
    expect(calls.map(({ command, args }) => [command, ...args])).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls.map(({ command, args }) => [command, ...args])).toContainEqual(["systemctl", "--user", "enable", "--now", "desktop-remote.service"]);
    expect(calls.map(({ command, args }) => [command, ...args])).toContainEqual(["systemctl", "--user", "restart", "desktop-remote.service"]);
    expect(calls.map(({ command, args }) => [command, ...args])).toContainEqual(["systemctl", "--user", "disable", "--now", "desktop-remote.service"]);
    expect(calls.every((call) => call.env?.XDG_RUNTIME_DIR === "/run/user/1000")).toBe(true);
    expect(calls.every((call) => call.env?.DBUS_SESSION_BUS_ADDRESS === "unix:path=/run/user/1000/bus")).toBe(true);
  });
});
