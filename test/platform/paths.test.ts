import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDesktopRemoteDirectories,
  getDesktopRemotePaths,
} from "../../src/platform/paths";

test("desktop remote macOS paths are stable and directories are user-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-remote-home-"));
  const paths = getDesktopRemotePaths(home, {}, "darwin");
  expect(paths.appSupportDir).toBe(join(home, "Library", "Application Support", "desktop-remote"));
  expect(paths.cacheDir).toBe(join(home, "Library", "Caches", "desktop-remote"));
  expect(paths.socketPath).toBe(join(paths.cacheDir, "daemon.sock"));
  expect(paths.binDir).toBe(join(paths.appSupportDir, "bin"));
  expect(paths.runtimeDir).toBe(join(paths.appSupportDir, "runtime"));
  expect(paths.logsDir).toBe(join(paths.appSupportDir, "logs"));
  expect(paths.desiredStatePath).toBe(join(paths.appSupportDir, "desired-state.json"));
  expect(paths.historyPath).toBe(join(paths.appSupportDir, "history.jsonl"));
  expect(paths.runtimeMetadataPath).toBe(join(paths.appSupportDir, "runtime.json"));
  expect(paths.launchAgentPath).toBe(join(home, "Library", "LaunchAgents", "com.desktop-remote.daemon.plist"));

  await ensureDesktopRemoteDirectories(paths);
  expect((await stat(paths.appSupportDir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.cacheDir)).mode & 0o777).toBe(0o700);
});

test("Linux paths follow XDG defaults when no env vars are set", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-remote-home-"));
  const paths = getDesktopRemotePaths(home, {}, "linux");
  expect(paths.appSupportDir).toBe(join(home, ".local", "state", "desktop-remote"));
  expect(paths.cacheDir).toBe(join(home, ".cache", "desktop-remote"));
  expect(paths.socketPath).toBe(join(paths.cacheDir, "desktop-remote.sock"));
  expect(paths.binDir).toBe(join(paths.appSupportDir, "bin"));
  expect(paths.runtimeDir).toBe(join(paths.appSupportDir, "runtime"));
  expect(paths.logsDir).toBe(join(paths.appSupportDir, "logs"));
  expect(paths.desiredStatePath).toBe(join(paths.appSupportDir, "desired-state.json"));

  await ensureDesktopRemoteDirectories(paths);
  expect((await stat(paths.appSupportDir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.cacheDir)).mode & 0o777).toBe(0o700);
});

test("Linux paths honor XDG environment variables", () => {
  const home = "/home/user";
  const paths = getDesktopRemotePaths(home, {
    XDG_CACHE_HOME: "/var/cache/dr",
    XDG_STATE_HOME: "/var/lib/dr",
    XDG_RUNTIME_DIR: "/run/user/1000",
  }, "linux");
  expect(paths.appSupportDir).toBe("/var/lib/dr/desktop-remote");
  expect(paths.cacheDir).toBe("/var/cache/dr/desktop-remote");
  expect(paths.socketPath).toBe("/run/user/1000/desktop-remote.sock");
});
