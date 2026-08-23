import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "../src/platform/command-runner";

export interface ProductionBuildOptions {
  rootDir?: string;
  outDir?: string;
  bunPath?: string;
  run?: CommandRunner;
  promote?: boolean;
}
export interface ProductionBuildLayout {
  layout: "single" | "split";
  cli: string;
  daemon: string;
  daemonArgs: string[];
}

export async function buildProduction(options: ProductionBuildOptions = {}): Promise<ProductionBuildLayout> {
  const rootDir = options.rootDir ?? process.cwd();
  const outDir = options.outDir ?? join(rootDir, "dist");
  const bunPath = options.bunPath ?? process.execPath;
  const run = options.run ?? runCommand;
  const promote = options.promote ?? true;
  await mkdir(outDir, { recursive: true });

  const candidate = join(outDir, ".desktop-remote-candidate");
  await rm(candidate, { force: true }).catch(() => {});
  const singleBuild = await run(bunPath, ["build", "--compile", "--no-compile-autoload-bunfig", join(rootDir, "bin", "cli.ts"), "--outfile", candidate]);
  if (singleBuild.exitCode === 0) {
    const probe = await run(candidate, ["daemon", "--probe"]);
    if (probe.exitCode === 0 && !/libopentui|@opentui/i.test(`${probe.stdout}\n${probe.stderr}`)) {
      const final = join(outDir, "desktop-remote");
      if (promote) {
        await rm(final, { force: true }).catch(() => {});
        await rename(candidate, final);
        await chmod(final, 0o755);
      }
      const layout: ProductionBuildLayout = { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"] };
      await writeLayout(outDir, layout);
      return layout;
    }
  }

  const cli = join(outDir, "desktop-remote");
  const daemon = join(outDir, "desktop-remote-daemon");
  const cliBuild = await run(bunPath, ["build", "--compile", "--no-compile-autoload-bunfig", join(rootDir, "bin", "cli.ts"), "--outfile", cli]);
  if (cliBuild.exitCode !== 0) throw new Error(`CLI production build failed: ${cliBuild.stderr || cliBuild.stdout}`);
  const daemonBuild = await run(bunPath, ["build", "--compile", "--no-compile-autoload-bunfig", join(rootDir, "bin", "daemon.ts"), "--outfile", daemon]);
  if (daemonBuild.exitCode !== 0) throw new Error(`Daemon production build failed: ${daemonBuild.stderr || daemonBuild.stdout}`);
  const daemonProbe = await run(daemon, ["--probe"]);
  if (daemonProbe.exitCode !== 0 || /libopentui|@opentui/i.test(`${daemonProbe.stdout}\n${daemonProbe.stderr}`)) {
    throw new Error("Split daemon production probe failed or loaded OpenTUI");
  }
  if (promote) {
    await chmod(cli, 0o755);
    await chmod(daemon, 0o755);
  }
  const layout: ProductionBuildLayout = { layout: "split", cli: "desktop-remote", daemon: "desktop-remote-daemon", daemonArgs: [] };
  await writeLayout(outDir, layout);
  return layout;
}

async function writeLayout(outDir: string, layout: ProductionBuildLayout): Promise<void> {
  await writeFile(join(outDir, "build-layout.json"), `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o600 });
}

if (import.meta.main) {
  const result = await buildProduction();
  console.log(JSON.stringify(result));
}
