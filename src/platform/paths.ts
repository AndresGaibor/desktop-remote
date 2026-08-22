import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform as nodePlatform } from "node:os";
import { dirname, join } from "node:path";

export type Platform = "darwin" | "linux" | "win32" | "freebsd" | "openbsd";

export interface DesktopRemotePaths {
  appSupportDir: string;
  cacheDir: string;
  socketPath: string;
}

export function getDesktopRemotePaths(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform: Platform = nodePlatform() as Platform,
): DesktopRemotePaths {
  if (currentPlatform === "darwin") {
    return macosPaths(homeDir);
  }
  return xdgPaths(homeDir, env);
}

function macosPaths(homeDir: string): DesktopRemotePaths {
  const cacheDir = join(homeDir, "Library", "Caches", "desktop-remote");
  return {
    appSupportDir: join(homeDir, "Library", "Application Support", "desktop-remote"),
    cacheDir,
    socketPath: join(cacheDir, "daemon.sock"),
  };
}

function xdgPaths(homeDir: string, env: NodeJS.ProcessEnv): DesktopRemotePaths {
  const xdgCache = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
    ? env.XDG_CACHE_HOME
    : join(homeDir, ".cache");
  const xdgState = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homeDir, ".local", "state");
  const xdgRuntime = env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR.length > 0
    ? env.XDG_RUNTIME_DIR
    : undefined;
  const cacheDir = join(xdgCache, "desktop-remote");
  return {
    appSupportDir: join(xdgState, "desktop-remote"),
    cacheDir,
    socketPath: join(xdgRuntime ?? cacheDir, "desktop-remote.sock"),
  };
}

export async function ensureDesktopRemoteDirectories(paths: DesktopRemotePaths): Promise<void> {
  await mkdir(paths.appSupportDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
  await chmod(paths.appSupportDir, 0o700);
  await chmod(paths.cacheDir, 0o700);

  const socketDir = dirname(paths.socketPath);
  if (socketDir !== paths.cacheDir && socketDir !== paths.appSupportDir) {
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    await chmod(socketDir, 0o700);
  }
}
