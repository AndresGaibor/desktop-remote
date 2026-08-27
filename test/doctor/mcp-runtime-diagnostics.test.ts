import { describe, expect, test } from "bun:test";
import { parseMcpRuntimeDiagnostics } from "../../src/doctor/mcp-runtime-diagnostics";

describe("parseMcpRuntimeDiagnostics", () => {
  test("reconstruye ultimo lifecycle y backpressure sin guardar argumentos", () => {
    const diagnostics = parseMcpRuntimeDiagnostics([
      JSON.stringify({ timestamp: "2026-08-27T19:10:00.000Z", level: "info", message: "mcp.lifecycle.request.arrival", data: {
        runtimeInstanceId: "runtime-1", connectionId: "runtime-1:1", currentSchemaHash: "abc", method: "tools/list",
        initializeCount: 1, toolsListCount: 2, toolsCallCount: 3, activeRequests: 0,
        lastInitializeAt: 1000, lastToolsListAt: 2000, lastToolsCallAt: 1500,
      }}),
      JSON.stringify({ timestamp: "2026-08-27T19:10:01.000Z", level: "info", message: "mcp.backpressure.state", data: {
        active: 3, activeLimit: 8, queued: 4, queueLimit: 64, rejected: 2, queueTimeouts: 1,
      }}),
      JSON.stringify({ timestamp: "2026-08-27T19:10:02.000Z", level: "info", message: "mcp.lifecycle.request.completion", data: {
        runtimeInstanceId: "runtime-1", connectionId: "runtime-1:1", currentSchemaHash: "abc", method: "tools/call", toolName: "get_config",
        initializeCount: 1, toolsListCount: 2, toolsCallCount: 4, toolsCallSuccessCount: 4, toolsCallFailureCount: 0, activeRequests: 0,
        lastInitializeAt: 1000, lastToolsListAt: 2000, lastToolsCallAt: 3000,
      }}),
    ]);

    expect(diagnostics.lifecycle).toEqual({
      runtimeInstanceId: "runtime-1",
      connectionId: "runtime-1:1",
      currentSchemaHash: "abc",
      initializeCount: 1,
      toolsListCount: 2,
      toolsCallCount: 4,
      toolsCallSuccessCount: 4,
      toolsCallFailureCount: 0,
      activeRequests: 0,
      lastInitializeAt: 1000,
      lastToolsListAt: 2000,
      lastToolsCallAt: 3000,
      observedAt: "2026-08-27T19:10:02.000Z",
    });
    expect(diagnostics.backpressure).toEqual({
      active: 3,
      activeLimit: 8,
      queued: 4,
      queueLimit: 64,
      rejected: 2,
      queueTimeouts: 1,
      observedAt: "2026-08-27T19:10:01.000Z",
    });
  });

  test("ignora JSON roto y campos no confiables", () => {
    const diagnostics = parseMcpRuntimeDiagnostics([
      "not-json",
      JSON.stringify({ timestamp: "bad", message: "mcp.backpressure.state", data: { active: "many" } }),
    ]);
    expect(diagnostics).toEqual({});
  });
});
