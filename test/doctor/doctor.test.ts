import { describe, expect, test } from "bun:test";
import { runDoctor, type DoctorReport } from "../../src/doctor/doctor";
import type { TunnelDiagnostics } from "../../src/platform/tunnel-health";

function tunnelDiagnostics(overrides: Partial<TunnelDiagnostics["selected"]> = {}): TunnelDiagnostics {
  return {
    baseUrl: "http://127.0.0.1:4321",
    state: "ready",
    healthz: { ok: true, status: 200, body: "live" },
    readyz: { ok: true, status: 200, body: "ready" },
    api: {
      status: { available: true, status: 200, selected: { liveness: true, readiness: true } },
      system: { available: true, status: 200, selected: { liveness: true, readiness: true, pid: 123 } },
    },
    metrics: { available: true, status: 200, selected: { liveness: true, readiness: true } },
    selected: { liveness: true, readiness: true, ...overrides },
  };
}

describe("runDoctor", () => {
  test("produce un reporte bien formado en formato json", async () => {
    const report = await runDoctor("json", {
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
      mcpCatalogFingerprint: "a".repeat(64),
      configValid: true,
      configErrors: [],
    });

    expect(report).toBeTypeOf("object");
    expect(report.daemon.alive).toBe(true);
    expect(report.daemon.pid).toBe(12345);
    expect(report.mcp.reachable).toBe(true);
    expect(report.mcp.catalogFingerprint).toBe("a".repeat(64));
    expect(report.tunnel.healthy).toBe(true);
    expect(report.tunnel.detail).toBe("ready");
    expect(report.disk.freeBytes).toBe(1_000_000n);
    expect(report.disk.totalBytes).toBe(100_000_000n);
    expect(report.logs.recentErrors).toEqual([]);
    expect(report.schemaHash.current).toBe("abc123");
    expect(report.schemaHash.drift).toBe(false);
    expect(report.config.valid).toBe(true);
    expect(report.config.errors).toBeUndefined();
    expect(report.timestamp).toBeTypeOf("string");
    expect(report.healthy).toBe(true);
  });

  test("reporta healthy=false cuando daemon no esta vivo", async () => {
    const report = await runDoctor("json", {
      daemonAlive: false,
      daemonPid: undefined,
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
    });

    expect(report.healthy).toBe(false);
    expect(report.daemon.alive).toBe(false);
  });

  test("reporta healthy=false cuando hay drift de schema hash", async () => {
    const report = await runDoctor("json", {
      daemonAlive: true,
      daemonPid: 12345,
      mcpReachable: true,
      tunnelHealthy: true,
      tunnelDetail: "ready",
      diskFreeBytes: 1_000_000n,
      diskTotalBytes: 100_000_000n,
      recentErrors: [],
      schemaHashCurrent: "abc123",
      schemaHashStored: "xyz789",
      configValid: true,
      configErrors: [],
    });

    expect(report.healthy).toBe(false);
    expect(report.schemaHash.drift).toBe(true);
  });

  test("reporta historicalWarnings cuando hay errores recientes en logs", async () => {
    const report = await runDoctor("json", {
      daemonAlive: true,
      daemonPid: 12345,
      mcpReachable: true,
      tunnelHealthy: true,
      tunnelDetail: "ready",
      diskFreeBytes: 1_000_000n,
      diskTotalBytes: 100_000_000n,
      recentErrors: ["Connection refused", "Timeout error"],
      schemaHashCurrent: "abc123",
      schemaHashStored: "abc123",
      configValid: true,
      configErrors: [],
    });

    expect(report.healthy).toBe(true);
    expect(report.historicalWarnings).toEqual(["Connection refused", "Timeout error"]);
    expect(report.logs.recentErrors).toEqual([]);
  });

  test("reporta healthy=false cuando config es invalido", async () => {
    const report = await runDoctor("json", {
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
      configValid: false,
      configErrors: ["missing required field: defaultShell"],
    });

    expect(report.healthy).toBe(false);
    expect(report.config.valid).toBe(false);
    expect(report.config.errors).toEqual(["missing required field: defaultShell"]);
  });

  test("formato text produce una cadena legible", async () => {
    const text = await runDoctor("text", {
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
    });

    expect(text).toBeTypeOf("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("daemon");
    expect(text.toLowerCase()).toContain("tunnel");
    expect(text.toLowerCase()).toContain("disk");
    expect(text.toLowerCase()).toContain("schema");
    expect(text.toLowerCase()).toContain("config");
  });

  test("agrega detalle de tunnel no saludable al reporte", async () => {
    const report = await runDoctor("json", {
      daemonAlive: true,
      daemonPid: 12345,
      mcpReachable: true,
      tunnelHealthy: false,
      tunnelDetail: "unreachable",
      diskFreeBytes: 1_000_000n,
      diskTotalBytes: 100_000_000n,
      recentErrors: [],
      schemaHashCurrent: "abc123",
      schemaHashStored: "abc123",
      configValid: true,
      configErrors: [],
    });

    expect(report.tunnel.healthy).toBe(false);
    expect(report.tunnel.detail).toBe("unreachable");
    expect(report.healthy).toBe(false);
  });

  test("distingue salud local de polling stale del control plane", async () => {
    const report = await runDoctor("json", {
      daemonAlive: true,
      daemonPid: 12345,
      mcpReachable: true,
      tunnelHealthy: true,
      tunnelDetail: "ready",
      tunnelDiagnostics: tunnelDiagnostics({
        mcp: { status: "connected", pid: 234 },
        channel: { status: "ready", pid: 235 },
        polling: { lastSuccessAt: "2026-08-27T11:00:00.000Z", ageMs: 3_600_000, stale: true },
        queue: { depth: 2 },
        workers: { active: 2, capacity: 4, occupancy: 0.5 },
        controlPlane: { reachable: false, stale: true },
      }),
      diskFreeBytes: 1_000_000n,
      diskTotalBytes: 100_000_000n,
      recentErrors: [],
      schemaHashCurrent: "abc123",
      schemaHashStored: "abc123",
      configValid: true,
      configErrors: [],
      buildMetadata: { layout: "single", cli: "desktop-remote", daemon: "desktop-remote", version: "1.0.0" },
      logPaths: { "daemon.log": true, "mcp.log": false },
      serviceStatus: { loaded: true, enabled: true, active: true, pid: 12345 },
    });

    expect(report.local.healthy).toBe(true);
    expect(report.controlPlane).toMatchObject({ status: "stale", stale: true, reachable: false });
    expect(report.tunnel.selected.workers).toEqual({ active: 2, capacity: 4, occupancy: 0.5 });
    expect(report.mcp).toMatchObject({ status: "connected", pid: 234, channel: { status: "ready", pid: 235 } });
    expect(report.build).toMatchObject({ layout: "single", version: "1.0.0" });
    expect(report.daemon.service).toEqual({ loaded: true, enabled: true, active: true, pid: 12345 });
    expect(report.logs.paths).toEqual({ "daemon.log": true, "mcp.log": false });
    expect(report.healthy).toBe(false);
  });

  test("limita errores recientes y nunca expone un arreglo sin cota", async () => {
    const report = await runDoctor("json", {
      daemonAlive: true,
      mcpReachable: true,
      tunnelHealthy: true,
      diskFreeBytes: 1_000_000n,
      diskTotalBytes: 100_000_000n,
      recentErrors: Array.from({ length: 100 }, (_, index) => `${index}:${"x".repeat(1000)}`),
      schemaHashCurrent: "abc123",
      schemaHashStored: "abc123",
      configValid: true,
      configErrors: [],
    });

    expect(report.historicalWarnings ?? []).toHaveLength(10);
    expect((report.historicalWarnings ?? []).every((entry) => entry.length <= 256)).toBe(true);
  });
});
