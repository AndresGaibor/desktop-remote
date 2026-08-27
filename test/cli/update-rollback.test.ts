import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CommandRunner } from "../../src/platform/command-runner";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

describe("update/rollback binary logic", () => {
  test("promoteBinaryWithBackup crea backup .bak y promueve nuevo binario", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-test-"));
    try {
      const binPath = join(dir, "bin");
      const oldBin = join(binPath, "desktop-remote");
      const newBin = join(dir, "new-desktop-remote");

      await mkdir(binPath, { recursive: true });
      await writeFile(oldBin, "old binary content", "utf8");
      await chmod(oldBin, 0o755);
      await writeFile(newBin, "new binary content", "utf8");
      await chmod(newBin, 0o755);

      const { promoteBinaryWithBackup } = await import("../../src/platform/install");
      await promoteBinaryWithBackup(newBin, binPath, "desktop-remote");

      const promotedPath = join(binPath, "desktop-remote");
      const promoted = await stat(promotedPath);
      expect(promoted.isFile()).toBe(true);

      const backupPath = join(binPath, "desktop-remote.bak");
      const backup = await stat(backupPath);
      expect(backup.isFile()).toBe(true);

      const promotedContent = await Bun.file(promotedPath).text();
      expect(promotedContent).toBe("new binary content");

      const backupContent = await Bun.file(backupPath).text();
      expect(backupContent).toBe("old binary content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollbackBinary restaura desde backup .bak", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-test-"));
    try {
      const binPath = join(dir, "bin");
      const bin = join(binPath, "desktop-remote");
      const bak = join(binPath, "desktop-remote.bak");

      await mkdir(binPath, { recursive: true });
      await writeFile(bin, "current binary", "utf8");
      await chmod(bin, 0o755);
      await writeFile(bak, "backup binary", "utf8");
      await chmod(bak, 0o755);

      const { rollbackBinary } = await import("../../src/platform/install");
      await rollbackBinary(binPath, "desktop-remote");

      const restored = await Bun.file(bin).text();
      expect(restored).toBe("backup binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollbackBinary falla si no existe backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-test-"));
    try {
      const binPath = join(dir, "bin");

      const { rollbackBinary } = await import("../../src/platform/install");
      await expect(rollbackBinary(binPath, "desktop-remote")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("promoteBinaryWithBackup falla si source no existe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-test-"));
    try {
      const binPath = join(dir, "bin");

      const { promoteBinaryWithBackup } = await import("../../src/platform/install");
      await expect(promoteBinaryWithBackup("/nonexistent/source", binPath, "desktop-remote")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("updateLocalArtifacts prueba y promueve el checkout con metadata transaccional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-update-"));
    try {
      const paths = makeTestPaths(dir);
      const sourceRoot = join(dir, "checkout");
      const current = join(paths.binDir, "desktop-remote");
      const metadata = join(paths.binDir, "build-layout.json");
      await mkdir(paths.binDir, { recursive: true });
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(current, "old binary", "utf8");
      await writeFile(metadata, JSON.stringify({ layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"] }), "utf8");

      const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
      const run: CommandRunner = async (command, args, options) => {
        calls.push({ command, args, cwd: (options as { cwd?: string } | undefined)?.cwd });
        if (args[0] === "test" || (args[0] === "run" && args[1] === "typecheck")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "build") {
          const outfile = args[args.indexOf("--outfile") + 1];
          if (!outfile) throw new Error("missing outfile");
          await writeFile(outfile, "new binary", "utf8");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "daemon" && args[1] === "--probe") {
          return { exitCode: 0, stdout: "probe ok", stderr: "" };
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      };

      const { updateLocalArtifacts } = await import("../../src/platform/install");
      await updateLocalArtifacts(paths, { sourceRoot, bunPath: "/fake/bun", run });

      expect(calls.slice(0, 2).map((call) => call.args)).toEqual([["test"], ["run", "typecheck"]]);
      expect(calls.slice(0, 2).every((call) => call.cwd === sourceRoot)).toBe(true);
      expect(await Bun.file(current).text()).toBe("new binary");
      expect(await Bun.file(`${current}.previous`).text()).toBe("old binary");
      expect(JSON.parse(await Bun.file(metadata).text())).toMatchObject({ layout: "single", cli: "desktop-remote" });
      expect(JSON.parse(await Bun.file(`${metadata}.previous`).text())).toMatchObject({ layout: "single", cli: "desktop-remote" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollbackInstalledBuild intercambia binario y metadata de forma atómica", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-rollback-"));
    try {
      const paths = makeTestPaths(dir);
      const current = join(paths.binDir, "desktop-remote");
      const previous = `${current}.previous`;
      const metadata = join(paths.binDir, "build-layout.json");
      const previousMetadata = `${metadata}.previous`;
      await mkdir(paths.binDir, { recursive: true });
      await writeFile(current, "candidate binary", "utf8");
      await writeFile(previous, "known good binary", "utf8");
      await writeFile(metadata, JSON.stringify({ layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"], version: "candidate" }), "utf8");
      await writeFile(previousMetadata, JSON.stringify({ layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"], version: "known-good" }), "utf8");

      const { rollbackInstalledBuild } = await import("../../src/platform/install");
      await rollbackInstalledBuild(paths);

      expect(await Bun.file(current).text()).toBe("known good binary");
      expect(await Bun.file(previous).text()).toBe("candidate binary");
      expect(JSON.parse(await Bun.file(metadata).text()).version).toBe("known-good");
      expect(JSON.parse(await Bun.file(previousMetadata).text()).version).toBe("candidate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rollbackInstalledBuild falla sin previous y no modifica el runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "desktop-remote-no-rollback-"));
    try {
      const paths = makeTestPaths(dir);
      await mkdir(paths.binDir, { recursive: true });
      await writeFile(join(paths.binDir, "desktop-remote"), "current binary", "utf8");

      const { rollbackInstalledBuild } = await import("../../src/platform/install");
      await expect(rollbackInstalledBuild(paths)).rejects.toThrow(/no previous/i);
      expect(await Bun.file(join(paths.binDir, "desktop-remote")).text()).toBe("current binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
