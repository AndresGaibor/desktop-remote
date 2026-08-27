import { describe, expect, test } from "bun:test";
import { runDoctor, type DoctorReport } from "../../src/doctor/doctor";

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
      configValid: true,
      configErrors: [],
    });

    expect(report).toBeTypeOf("object");
    expect(report.daemon.alive).toBe(true);
    expect(report.daemon.pid).toBe(12345);
    expect(report.mcp.reachable).toBe(true);
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

  test("reporta healthy=false cuando hay errores recientes en logs", async () => {
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

    expect(report.healthy).toBe(false);
    expect(report.logs.recentErrors).toEqual(["Connection refused", "Timeout error"]);
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
});
