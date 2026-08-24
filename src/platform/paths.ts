import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform as nodePlatform } from "node:os";
import { dirname, join } from "node:path";

export type Platform = "darwin" | "linux" | "win32" | "freebsd" | "openbsd";

export interface DesktopRemotePaths {
  appSupportDir: string;
  cacheDir: string;
  binDir: string;
  runtimeDir: string;
  logsDir: string;
  socketPath: string;
  desiredStatePath: string;
  configPath?: string;
  historyPath: string;
  runtimeMetadataPath: string;
  tunnelProfilePath: string;
  launchAgentPath?: string;
  systemdUserUnitPath?: string;
  tunnelLaunchAgentPath?: string;
  tunnelSystemdUserUnitPath?: string;
}

export function getDesktopRemotePaths(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform: Platform = nodePlatform() as Platform,
): DesktopRemotePaths {
  return currentPlatform === "darwin"
    ? macosPaths(homeDir)
    : xdgPaths(homeDir, env);
}

function macosPaths(homeDir: string): DesktopRemotePaths {
  const appSupportDir = join(homeDir, "Library", "Application Support", "desktop-remote");
  const cacheDir = join(homeDir, "Library", "Caches", "desktop-remote");
  return commonPaths(appSupportDir, cacheDir, join(cacheDir, "daemon.sock"), {
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", "com.desktop-remote.daemon.plist"),
    tunnelLaunchAgentPath: join(homeDir, "Library", "LaunchAgents", "com.desktop-remote.tunnel.plist"),
  });
}

function xdgPaths(homeDir: string, env: NodeJS.ProcessEnv): DesktopRemotePaths {
  const xdgCache = env.XDG_CACHE_HOME || join(homeDir, ".cache");
  const xdgState = env.XDG_STATE_HOME || join(homeDir, ".local", "state");
  const xdgConfig = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  const xdgRuntime = env.XDG_RUNTIME_DIR || undefined;
  const appSupportDir = join(xdgState, "desktop-remote");
  const cacheDir = join(xdgCache, "desktop-remote");
  return commonPaths(
    appSupportDir,
    cacheDir,
    join(xdgRuntime ?? cacheDir, "desktop-remote.sock"),
    {
      systemdUserUnitPath: join(xdgConfig, "systemd", "user", "desktop-remote.service"),
      tunnelSystemdUserUnitPath: join(xdgConfig, "systemd", "user", "desktop-remote-tunnel.service"),
    },
  );
}

function commonPaths(
  appSupportDir: string,
  cacheDir: string,
  socketPath: string,
  platformPaths: Pick<DesktopRemotePaths, "launchAgentPath" | "systemdUserUnitPath" | "tunnelLaunchAgentPath" | "tunnelSystemdUserUnitPath">,
): DesktopRemotePaths {
  return {
    appSupportDir,
    cacheDir,
    binDir: join(appSupportDir, "bin"),
    runtimeDir: join(appSupportDir, "runtime"),
    logsDir: join(appSupportDir, "logs"),
    socketPath,
    desiredStatePath: join(appSupportDir, "desired-state.json"),
    configPath: join(appSupportDir, "config.json"),
    historyPath: join(appSupportDir, "history.jsonl"),
    runtimeMetadataPath: join(appSupportDir, "runtime.json"),
    tunnelProfilePath: join(appSupportDir, "tunnel.yaml"),
    ...platformPaths,
  };
}

export async function ensureDesktopRemoteDirectories(paths: DesktopRemotePaths): Promise<void> {
  const directories = new Set([
    paths.appSupportDir,
    paths.cacheDir,
    paths.binDir,
    paths.runtimeDir,
    paths.logsDir,
    dirname(paths.socketPath),
  ]);

  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}
