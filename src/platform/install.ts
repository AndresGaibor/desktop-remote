import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProduction, type ProductionBuildLayout } from "../../scripts/build-production";
import { writeAtomicJson } from "./atomic-file";
import { requireSuccess, resolveExecutable, runCommand, type CommandRunner } from "./command-runner";
import type { DesktopRemotePaths } from "./paths";
import { ensureDesktopRemoteDirectories } from "./paths";

export interface InstallProductionOptions {
  run?: CommandRunner;
  sourceRoot?: string;
  nodePath?: string;
  bunPath?: string;
  npmPath?: string;
}

export interface InstalledBuildMetadata extends ProductionBuildLayout {
  installedAt: string;
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
    await promoteInstalledBuild(paths, buildDir, layout);
    return layout;
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function updateLocalArtifacts(
  paths: DesktopRemotePaths,
  options: InstallProductionOptions = {},
): Promise<ProductionBuildLayout> {
  const run = options.run ?? runCommand;
  const bunPath = options.bunPath ?? await resolveExecutable("bun");
  if (!bunPath) throw new Error("Bun is required to test/build the current checkout");

  const sourceRoot = options.sourceRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  requireSuccess(await run(bunPath, ["test"], { cwd: sourceRoot }), "Local checkout tests");
  requireSuccess(await run(bunPath, ["run", "typecheck"], { cwd: sourceRoot }), "Local checkout typecheck");
  return buildAndPromoteWithBackup(paths, options);
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
    await promoteInstalledBuild(paths, buildDir, layout);
    return layout;
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function rollbackInstalledBuild(paths: DesktopRemotePaths): Promise<ProductionBuildLayout> {
  await ensureDesktopRemoteDirectories(paths);

  const metadataPath = join(paths.binDir, "build-layout.json");
  const previousMetadataPath = `${metadataPath}.previous`;
  const previousLayout = await readBuildLayoutFile(previousMetadataPath);
  if (!previousLayout) throw new Error("No previous installed build available");

  const currentLayout = await readBuildLayoutFile(metadataPath) ?? await readInstalledBuildLayout(paths);
  const names = new Set([...
    artifactNames(currentLayout),
    ...artifactNames(previousLayout),
  ]);
  const swapped: string[] = [];
  const schemaHashPath = join(paths.appSupportDir, "schema-hash.json");
  try {
    for (const name of names) {
      const destination = join(paths.binDir, name);
      if (!await fileExists(`${destination}.previous`)) continue;
      await swapCurrentAndPrevious(destination);
      swapped.push(destination);
    }
    if (await fileExists(`${schemaHashPath}.previous`)) {
      await swapCurrentAndPrevious(schemaHashPath);
      swapped.push(schemaHashPath);
    }
    await swapCurrentAndPrevious(metadataPath);
    swapped.push(metadataPath);
  } catch (error) {
    for (const destination of swapped.reverse()) {
      await swapCurrentAndPrevious(destination).catch(() => {});
    }
    throw error;
  }

  return readInstalledBuildLayout(paths);
}

async function promoteInstalledBuild(
  paths: DesktopRemotePaths,
  buildDir: string,
  layout: ProductionBuildLayout,
): Promise<void> {
  await ensureDesktopRemoteDirectories(paths);
  const destinations = [...artifactNames(layout)].map((name) => join(paths.binDir, name));
  const staged = destinations.map((destination) => ({
    destination,
    next: `${destination}.new`,
    source: join(buildDir, basename(destination)),
  }));
  const metadataPath = join(paths.binDir, "build-layout.json");
  const stagedMetadataPath = `${metadataPath}.new`;
  const schemaHashPath = join(paths.appSupportDir, "schema-hash.json");
  const stagedSchemaHashPath = `${schemaHashPath}.new`;

  try {
    for (const item of staged) {
      await rm(item.next, { force: true });
      await copyFile(item.source, item.next);
      await chmod(item.next, 0o755);
    }
    await writeAtomicJson(stagedMetadataPath, installedBuildMetadata(layout), 0o600);
    const schemaHashStaged = await stageSchemaHash(stagedSchemaHashPath);

    const promoted: string[] = [];
    try {
      for (const item of staged) {
        await promoteStagedFile(item.next, item.destination);
        promoted.push(item.destination);
      }
      await promoteStagedFile(stagedMetadataPath, metadataPath);
      promoted.push(metadataPath);
      if (schemaHashStaged) {
        await promoteStagedFile(stagedSchemaHashPath, schemaHashPath);
        promoted.push(schemaHashPath);
      }
    } catch (error) {
      for (const destination of promoted.reverse()) {
        await swapCurrentAndPrevious(destination).catch(() => {});
      }
      throw error;
    }
  } finally {
    for (const item of staged) await rm(item.next, { force: true }).catch(() => {});
    await rm(stagedMetadataPath, { force: true }).catch(() => {});
    await rm(stagedSchemaHashPath, { force: true }).catch(() => {});
  }
}

function artifactNames(layout: ProductionBuildLayout): Set<string> {
  return new Set([layout.cli, layout.daemon]);
}

function installedBuildMetadata(layout: ProductionBuildLayout): InstalledBuildMetadata {
  return { ...layout, installedAt: new Date().toISOString() };
}

async function stageSchemaHash(path: string): Promise<boolean> {
  try {
    const { computeToolSchemaHash } = await import("../config/schema-hash");
    await writeAtomicJson(path, { hash: computeToolSchemaHash(), recordedAt: new Date().toISOString() }, 0o600);
    return true;
  } catch {
    await rm(path, { force: true }).catch(() => {});
    return false;
  }
}

async function promoteStagedFile(next: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const previous = `${destination}.previous`;
  await rm(previous, { force: true });
  let movedCurrent = false;
  try {
    await rename(destination, previous);
    movedCurrent = true;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  try {
    await rename(next, destination);
  } catch (error) {
    if (movedCurrent) await rename(previous, destination).catch(() => {});
    throw error;
  }
}

async function swapCurrentAndPrevious(destination: string): Promise<void> {
  const previous = `${destination}.previous`;
  if (!await fileExists(previous)) throw new Error(`No previous file found at ${previous}`);
  const temporary = `${destination}.swap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let movedCurrent = false;
  let movedPrevious = false;
  try {
    try {
      await rename(destination, temporary);
      movedCurrent = true;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    await rename(previous, destination);
    movedPrevious = true;
    if (movedCurrent) await rename(temporary, previous);
  } catch (error) {
    if (movedPrevious) await rename(destination, previous).catch(() => {});
    if (movedCurrent) await rename(temporary, destination).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readBuildLayoutFile(path: string): Promise<ProductionBuildLayout | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProductionBuildLayout>;
    if ((parsed.layout !== "single" && parsed.layout !== "split") || !parsed.cli || !parsed.daemon || !Array.isArray(parsed.daemonArgs)) {
      throw new Error(`Invalid build metadata at ${path}`);
    }
    return parsed as ProductionBuildLayout;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}
