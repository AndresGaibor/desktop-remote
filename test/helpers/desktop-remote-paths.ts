import { join } from "node:path";
import type { DesktopRemotePaths } from "../../src/platform/paths";

export function makeTestPaths(dir: string, socketName = "s.sock"): DesktopRemotePaths {
  return {
    appSupportDir: dir,
    cacheDir: dir,
    binDir: join(dir, "bin"),
    runtimeDir: join(dir, "runtime"),
    logsDir: join(dir, "logs"),
    socketPath: join(dir, socketName),
    desiredStatePath: join(dir, "desired-state.json"),
    historyPath: join(dir, "history.jsonl"),
    runtimeMetadataPath: join(dir, "runtime.json"),
    launchAgentPath: join(dir, "launch.plist"),
    systemdUserUnitPath: join(dir, "desktop-remote.service"),
  };
}
