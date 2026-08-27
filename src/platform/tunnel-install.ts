import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseTunnelProfile, serializeTunnelProfile } from "../tunnel/config";
import type { DesktopRemotePaths } from "./paths";
import { launchAgentTunnelPlist, systemdTunnelUnit } from "./tunnel-services";
import { requireSuccess, type CommandRunner } from "./command-runner";
import type { Platform } from "./paths";

export interface InitializeTunnelOptions {
  tunnelId: string;
  profile: string;
  tunnelCommand?: string;
}

export interface TunnelInitializationResult {
  profilePath: string;
  servicePath: string;
}

export interface TunnelDoctorResult {
  valid: true;
  tunnelId: string;
}

export async function initializeTunnel(
  paths: DesktopRemotePaths,
  options: InitializeTunnelOptions,
): Promise<TunnelInitializationResult> {
  const profile = parseTunnelProfile(options.profile);
  if (profile.tunnelId !== options.tunnelId) throw new Error("--tunnel-id does not match tunnel profile");
  await mkdir(dirname(paths.tunnelProfilePath), { recursive: true, mode: 0o700 });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  await chmod(paths.logsDir, 0o700);
  await writeAtomic(paths.tunnelProfilePath, serializeTunnelProfile(profile, "yaml"));

  const command = options.tunnelCommand ?? Bun.which("tunnel-client") ?? join(paths.binDir, "tunnel-client");
  const servicePath = servicePathFor(paths);
  const service = servicePath === paths.tunnelLaunchAgentPath
    ? launchAgentTunnelPlist(command, paths.tunnelProfilePath)
    : systemdTunnelUnit(command, paths.tunnelProfilePath);
  await mkdir(dirname(servicePath), { recursive: true, mode: 0o700 });
  await writeAtomic(servicePath, service);
  return { profilePath: paths.tunnelProfilePath, servicePath };
}

export async function doctorTunnel(paths: DesktopRemotePaths): Promise<TunnelDoctorResult> {
  const profile = parseTunnelProfile(await readFile(paths.tunnelProfilePath, "utf8"));
  return { valid: true, tunnelId: profile.tunnelId };
}

export async function restartTunnelServiceIfConfigured(
  paths: DesktopRemotePaths,
  options: { platform: Platform; run: CommandRunner; uid?: number },
): Promise<void> {
  if (options.platform === "darwin") {
    const servicePath = paths.tunnelLaunchAgentPath;
    if (!servicePath || !await fileExists(servicePath)) return;
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("Unable to determine macOS user id");
    requireSuccess(
      await options.run("launchctl", ["kickstart", "-k", `gui/${uid}/com.desktop-remote.tunnel`]),
      "launchctl restart tunnel",
    );
    return;
  }

  if (options.platform === "linux") {
    const servicePath = paths.tunnelSystemdUserUnitPath;
    if (!servicePath || !await fileExists(servicePath)) return;
    requireSuccess(
      await options.run("systemctl", ["--user", "restart", "desktop-remote-tunnel.service"]),
      "systemctl restart tunnel",
    );
  }
}

function servicePathFor(paths: DesktopRemotePaths): string {
  if (paths.tunnelLaunchAgentPath) return paths.tunnelLaunchAgentPath;
  if (paths.tunnelSystemdUserUnitPath) return paths.tunnelSystemdUserUnitPath;
  throw new Error("tunnel service path is unavailable on this platform");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporaryPath, path);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
