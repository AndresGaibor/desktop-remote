import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopRemotePaths } from "./paths";
import { ensureDesktopRemoteDirectories } from "./paths";
import { writeAtomicJson } from "./atomic-file";
import { requireSuccess, type CommandRunner } from "./command-runner";

export const DESKTOP_COMMANDER_VERSION = "0.2.47" as const;

export interface RuntimeMetadata {
  version: 1;
  nodePath: string;
  desktopCommanderEntry: string;
  desktopCommanderVersion: typeof DESKTOP_COMMANDER_VERSION;
}

export interface RuntimeInstallOptions {
  nodePath: string;
  bunPath: string;
  resolveDesktopCommanderEntry?: () => string;
}

export async function provisionDesktopCommander(
  paths: DesktopRemotePaths,
  run: CommandRunner,
  options: RuntimeInstallOptions,
): Promise<RuntimeMetadata> {
  const nodePath = absolute(options.nodePath, "node");
  const bunPath = absolute(options.bunPath, "bun");
  const version = requireSuccess(await run(nodePath, ["--version"]), "Node version check").stdout.trim();
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 18) throw new Error(`Node 18 or newer is required; found ${version || "unknown"}`);

  await ensureDesktopRemoteDirectories(paths);
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runtimeDir, 0o700);
  const manifestPath = join(paths.runtimeDir, "package.json");
  await writeFile(manifestPath, `${JSON.stringify({ private: true, dependencies: { "@wonderwhy-er/desktop-commander": DESKTOP_COMMANDER_VERSION } }, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);

  requireSuccess(await run(bunPath, ["install", "--production", "--cwd", paths.runtimeDir]), "Desktop Commander install");
  const packagePath = join(paths.runtimeDir, "node_modules", "@wonderwhy-er", "desktop-commander", "package.json");
  const installed = requireSuccess(
    await run(nodePath, ["-p", "require(process.argv[1]).version", packagePath]),
    "Desktop Commander version verification",
  ).stdout.trim();
  if (installed !== DESKTOP_COMMANDER_VERSION) {
    throw new Error(`Expected Desktop Commander ${DESKTOP_COMMANDER_VERSION}, found ${installed || "unknown"}`);
  }

  const entry = resolve(options.resolveDesktopCommanderEntry?.() ?? join(paths.runtimeDir, "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js"));
  const metadata: RuntimeMetadata = { version: 1, nodePath, desktopCommanderEntry: entry, desktopCommanderVersion: DESKTOP_COMMANDER_VERSION };
  await writeAtomicJson(paths.runtimeMetadataPath, metadata, 0o600);
  await chmod(paths.runtimeMetadataPath, 0o600);
  return metadata;
}

function absolute(value: string, name: string): string {
  if (!value.startsWith("/")) throw new Error(`${name} path must be absolute`);
  return value;
}
