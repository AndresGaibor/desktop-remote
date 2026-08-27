import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProduction, type ProductionBuildLayout } from "../../scripts/build-production";
import { writeAtomicJson } from "./atomic-file";
import { resolveExecutable, runCommand, type CommandRunner } from "./command-runner";
import type { DesktopRemotePaths } from "./paths";
import { ensureDesktopRemoteDirectories } from "./paths";

export interface InstallProductionOptions {
  run?: CommandRunner;
  sourceRoot?: string;
  nodePath?: string;
  bunPath?: string;
  npmPath?: string;
}

export async function installProductionArtifacts(
  paths: DesktopRemotePaths,
  options: InstallProductionOptions = {},
): Promise<ProductionBuildLayout> {
  const run = options.run ?? runCommand;
  const bunPath = options.bunPath ?? await resolveExecutable("bun");
  if (!bunPath) throw new Error("Bun is required to build/install the OpenTUI client; the daemon can run under Node.js after installation");

  await ensureDesktopRemoteDirectories(paths);

  const sourceRoot = options.sourceRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const buildDir = join(paths.appSupportDir, `.build-${process.pid}-${Date.now()}`);
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true, mode: 0o700 });
  try {
    const layout = await buildProduction({ rootDir: sourceRoot, outDir: buildDir, bunPath, run, promote: true });
    const names = new Set([layout.cli, layout.daemon]);
    for (const name of names) await promoteExecutable(join(buildDir, name), join(paths.binDir, name));
    await writeAtomicJson(join(paths.binDir, "build-layout.json"), layout, 0o600);
    return layout;
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readInstalledBuildLayout(paths: DesktopRemotePaths): Promise<ProductionBuildLayout> {
  try {
    const parsed = JSON.parse(await readFile(join(paths.binDir, "build-layout.json"), "utf8")) as ProductionBuildLayout;
    if ((parsed.layout !== "single" && parsed.layout !== "split") || !parsed.cli || !parsed.daemon || !Array.isArray(parsed.daemonArgs)) throw new Error("invalid");
    return parsed;
  } catch {
    return { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"] };
  }
}

async function promoteExecutable(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const next = `${destination}.new`;
  const previous = `${destination}.previous`;
  await rm(next, { force: true });
  await copyFile(source, next);
  await chmod(next, 0o755);
  await rm(previous, { force: true });
  try { await rename(destination, previous); } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  try { await rename(next, destination); }
  catch (error) {
    try { await rename(previous, destination); } catch {}
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export async function promoteBinaryWithBackup(
  sourcePath: string,
  binDir: string,
  binaryName: string,
): Promise<void> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const destination = join(binDir, binaryName);
  const backup = `${destination}.bak`;

  const previousBackupExists = await fileExists(backup);
  if (previousBackupExists) {
    await rm(backup, { force: true });
  }
  if (await fileExists(destination)) {
    await copyFile(destination, backup);
  }

  await copyFile(sourcePath, destination);
  await chmod(destination, 0o755);
}

export async function rollbackBinary(binDir: string, binaryName: string): Promise<void> {
  const destination = join(binDir, binaryName);
  const backup = `${destination}.bak`;

  if (!await fileExists(backup)) {
    throw new Error(`No backup found at ${backup}`);
  }

  await copyFile(backup, destination);
  await chmod(destination, 0o755);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function buildAndPromoteWithBackup(
  paths: DesktopRemotePaths,
  options: InstallProductionOptions = {},
): Promise<ProductionBuildLayout> {
  const run = options.run ?? runCommand;
  const bunPath = options.bunPath ?? await resolveExecutable("bun");
  if (!bunPath) throw new Error("Bun is required to build the client");

  await ensureDesktopRemoteDirectories(paths);

  const sourceRoot = options.sourceRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const buildDir = join(paths.appSupportDir, `.build-${process.pid}-${Date.now()}`);
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true, mode: 0o700 });
  try {
    const layout = await buildProduction({ rootDir: sourceRoot, outDir: buildDir, bunPath, run, promote: true });
    const names = new Set([layout.cli, layout.daemon]);
    for (const name of names) {
      await promoteBinaryWithBackup(join(buildDir, name), paths.binDir, name);
    }
    await writeAtomicJson(join(paths.binDir, "build-layout.json"), layout, 0o600);
    return layout;
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}
