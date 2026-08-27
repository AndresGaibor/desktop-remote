import { describe, expect, test } from "bun:test";
import { runDoctor, type DoctorReport } from "../../src/doctor/doctor";

function baseDeps() {
  return {
    daemonAlive: true,
    daemonPid: 12345,
    mcpReachable: true,
    tunnelHealthy: true,
    tunnelDetail: "ready",
    diskFreeBytes: 1_000_000n,
    diskTotalBytes: 100_000_000n,
    recentErrors: [],
    schemaHashCurrent: "abc123",
    schemaHashStored: "abc123",
    configValid: true,
    configErrors: [],
    mcpCatalogFingerprint: "a".repeat(64),
  };
}

describe("contract health", () => {
  test("matching installed/loaded single layout is healthy", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      buildMetadata: { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "1.0.0" },
      serviceStatus: { loaded: true, enabled: true, active: true, pid: 12345 },
      expectedLayout: { layout: "single", daemonArgs: ["daemon"] },
      mcpHash: "same",
      daemonHash: "same",
    });

    expect(report.contract).toEqual({ mcpHash: "same", daemonHash: "same", matches: true });
    expect(report.healthy).toBe(true);
    expect(report.installedBuild).toEqual({ layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "1.0.0" });
    expect(report.loadedService).toEqual({ loaded: true, enabled: true, active: true, pid: 12345 });
  });

  test("stale loaded split command is unhealthy", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      buildMetadata: { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", daemonArgs: ["daemon"], version: "1.0.0" },
      serviceStatus: { loaded: true, enabled: true, active: true, pid: 12345 },
      expectedLayout: { layout: "split", daemonArgs: ["daemon"] },
      mcpHash: "same",
      daemonHash: "same",
    });

    expect(report.contract).toEqual({ mcpHash: "same", daemonHash: "same", matches: false });
    expect(report.healthy).toBe(false);
  });

  test("MCP/daemon hash mismatch is unhealthy", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      mcpHash: "abc123",
      daemonHash: "xyz789",
    });

    expect(report.contract).toEqual({ mcpHash: "abc123", daemonHash: "xyz789", matches: false });
    expect(report.healthy).toBe(false);
  });
});

describe("historical warnings vs active health", () => {
  test("historical errors with healthy active components yields healthy=true and historicalWarnings", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      recentErrors: ["runtime error"],
      mcpHash: "same",
      daemonHash: "same",
    });

    expect(report.healthy).toBe(true);
    expect(report.historicalWarnings).toEqual(["runtime error"]);
    expect(report.contract).toEqual({ mcpHash: "same", daemonHash: "same", matches: true });
  });

  test("recentErrors appear in historicalWarnings not logs.recentErrors", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      recentErrors: ["connection refused", "timeout error"],
      mcpHash: "same",
      daemonHash: "same",
    });

    expect(report.healthy).toBe(true);
    expect(report.historicalWarnings).toEqual(["connection refused", "timeout error"]);
    expect(report.logs.recentErrors).toEqual([]);
  });
});

describe("controlPlane stale vs local health", () => {
  test("controlPlane.stale=true with healthy locals yields healthy=false", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      tunnelDiagnostics: {
        baseUrl: "http://127.0.0.1:4321",
        state: "ready",
        healthz: { ok: true, status: 200, body: "live" },
        readyz: { ok: true, status: 200, body: "ready" },
        api: { status: { available: true, status: 200 }, system: { available: true, status: 200 } },
        metrics: { available: true, status: 200 },
        selected: {
          liveness: true,
          readiness: true,
          controlPlane: { reachable: false, stale: true },
          polling: { lastSuccessAt: "2026-08-27T11:00:00.000Z", ageMs: 3_600_000, stale: true },
        },
      },
      mcpHash: "same",
      daemonHash: "same",
    });

    expect(report.local.healthy).toBe(true);
    expect(report.controlPlane.stale).toBe(true);
    expect(report.healthy).toBe(false);
  });
});

describe("installedBuild and loadedService sections", () => {
  test("report exposes installedBuild section", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      buildMetadata: { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "2.0.0" },
      mcpHash: "hash1",
      daemonHash: "hash2",
    });

    expect(report.installedBuild).toEqual({ layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "2.0.0" });
  });

  test("report exposes loadedService section", async () => {
    const report = await runDoctor("json", {
      ...baseDeps(),
      serviceStatus: { loaded: true, enabled: true, active: false, pid: undefined, lastExitCode: 1 },
      mcpHash: "hash1",
      daemonHash: "hash2",
    });

    expect(report.loadedService).toEqual({ loaded: true, enabled: true, active: false, pid: undefined, lastExitCode: 1 });
  });
});
