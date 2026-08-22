import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DesktopRemotePaths {
  appSupportDir: string;
  cacheDir: string;
  socketPath: string;
}

export function getDesktopRemotePaths(homeDir = homedir()): DesktopRemotePaths {
  const appSupportDir = join(homeDir, "Library", "Application Support", "desktop-remote");
  const cacheDir = join(homeDir, "Library", "Caches", "desktop-remote");
  return {
    appSupportDir,
    cacheDir,
    socketPath: join(cacheDir, "daemon.sock"),
  };
}

export async function ensureDesktopRemoteDirectories(paths: DesktopRemotePaths): Promise<void> {
  await mkdir(paths.appSupportDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  await chmod(paths.appSupportDir, 0o700);
  await chmod(paths.cacheDir, 0o700);
}
