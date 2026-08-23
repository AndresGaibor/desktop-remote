import { join } from "node:path";
import type { DesktopRemotePaths } from "../src/platform/paths";
export function makePaths(dir: string): DesktopRemotePaths {
  return {
    appSupportDir: dir,
    cacheDir: dir,
    binDir: join(dir, "bin"),
    runtimeDir: join(dir, "runtime"),
    logsDir: join(dir, "logs"),
    socketPath: join(dir, "daemon.sock"),
    desiredStatePath: join(dir, "desired-state.json"),
    historyPath: join(dir, "history.jsonl"),
    runtimeMetadataPath: join(dir, "runtime.json"),
    launchAgentPath: join(dir, "launch.plist"),
    systemdUserUnitPath: join(dir, "desktop-remote.service"),
  };
}
