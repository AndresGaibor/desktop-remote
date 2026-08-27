import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
});
