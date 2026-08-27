import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSupportBundle } from "../../src/doctor/support-bundle";
import { runDoctor, type DoctorReport } from "../../src/doctor/doctor";

async function report(): Promise<DoctorReport> {
  return await runDoctor("json", {
    daemonAlive: true,
    daemonPid: 123,
    mcpReachable: true,
    tunnelHealthy: true,
    tunnelDetail: "ready",
    diskFreeBytes: 10_000n,
    diskTotalBytes: 20_000n,
    recentErrors: ["authorization=Bearer secret-value"],
    schemaHashCurrent: "same",
    schemaHashStored: "same",
    configValid: true,
    configErrors: [],
    buildMetadata: { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "1.0.0" },
  });
}

describe("createSupportBundle", () => {
  test("escribe solo diagnósticos permitidos, redacted y con límites", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-remote-bundle-"));
    const outputPath = join(root, "bundle");
    try {
      const result = await createSupportBundle({
        outputPath,
        report: await report(),
        logFiles: [
          { name: "daemon.log", content: `${JSON.stringify({ token: "sk-live-secret-value", payload: { content: "full tool payload" }, message: "x".repeat(100_000) })}\n` },
          { name: "config.json", content: JSON.stringify({ apiKey: "sk-live-config-secret" }) },
          { name: "tool-payload.json", content: JSON.stringify({ content: "should not be copied" }) },
        ],
        now: () => new Date("2026-08-27T12:34:56.000Z"),
      });

      expect(result.path).toBe(outputPath);
      expect((await readdir(outputPath)).sort()).toEqual(["build.json", "daemon.log", "doctor.json", "tunnel.json"]);
      expect(await Bun.file(join(outputPath, "doctor.json")).text()).not.toContain("secret-value");
      expect(await Bun.file(join(outputPath, "daemon.log")).text()).not.toContain("sk-live-secret-value");
      expect(await Bun.file(join(outputPath, "daemon.log")).text()).not.toContain("full tool payload");
      expect((await Bun.file(join(outputPath, "daemon.log")).text()).length).toBeLessThanOrEqual(32 * 1024);
      expect((await stat(outputPath)).mode & 0o777).toBe(0o700);
      expect((await stat(join(outputPath, "doctor.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});
