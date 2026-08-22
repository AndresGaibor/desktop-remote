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
  const paths = getDesktopRemotePaths(home);
  expect(paths.appSupportDir).toBe(join(home, "Library", "Application Support", "desktop-remote"));
  expect(paths.cacheDir).toBe(join(home, "Library", "Caches", "desktop-remote"));
  expect(paths.socketPath).toBe(join(paths.cacheDir, "daemon.sock"));

  await ensureDesktopRemoteDirectories(paths);
  expect((await stat(paths.appSupportDir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.cacheDir)).mode & 0o777).toBe(0o700);
});
