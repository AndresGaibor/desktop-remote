import { describe, expect, test } from "bun:test";
import { classifyIncident, parseIncidentOptions, type IncidentInput } from "../../src/incident/incident";

const healthy = (overrides: Partial<IncidentInput> = {}): IncidentInput => ({
  timestamp: "2026-08-27T20:00:00.000Z",
  daemon: { alive: true },
  mcp: { reachable: true, lifecycle: { toolsCallCount: 12, toolsCallSuccessCount: 12, toolsCallFailureCount: 0, lastToolsCallAt: Date.parse("2026-08-27T19:59:00.000Z") }, backpressure: { active: 0, activeLimit: 8, queued: 0, queueLimit: 64, rejected: 0, queueTimeouts: 0 } },
  tunnel: { healthy: true, healthzOk: true, readyzOk: true, queueDepth: 0, queueCapacity: 20, workersActive: 1, workersCapacity: 10 },
  controlPlane: { stale: false },
  schema: { drift: false },
  ...overrides,
});

describe("incident classifier", () => {
  test("healthy runtime has no active local incident", () => expect(classifyIncident(healthy()).boundary).toBe("NO_ACTIVE_LOCAL_INCIDENT"));
  test("reported incident after last MCP call points before MCP", () => {
    const result = classifyIncident(healthy({ incidentAt: "2026-08-27T20:00:00.000Z" }));
    expect(result.boundary).toBe("CHATGPT_HOST_BEFORE_MCP");
  });
  test("current queue saturation is backpressure", () => expect(classifyIncident(healthy({ mcp: { ...healthy().mcp, backpressure: { ...healthy().mcp.backpressure!, queued: 64 } } })).boundary).toBe("MCP_BACKPRESSURE"));
  test("daemon, MCP, tunnel, control plane and schema boundaries", () => {
    expect(classifyIncident(healthy({ daemon: { alive: false } })).boundary).toBe("DAEMON_FAILURE");
    expect(classifyIncident(healthy({ mcp: { ...healthy().mcp, reachable: false } })).boundary).toBe("MCP_RUNTIME_FAILURE");
    expect(classifyIncident(healthy({ tunnel: { ...healthy().tunnel, healthy: false, healthzOk: false } })).boundary).toBe("TUNNEL_FAILURE");
    expect(classifyIncident(healthy({ controlPlane: { stale: true } })).boundary).toBe("CONTROL_PLANE_STALE");
    expect(classifyIncident(healthy({ schema: { drift: true } })).boundary).toBe("SCHEMA_DRIFT");
  });
  test("strictly parses at and durations", () => {
    expect(parseIncidentOptions(["--at", "2026-08-27T20:00:00Z"])).toEqual({ incidentAt: "2026-08-27T20:00:00Z" });
    expect(parseIncidentOptions(["--since", "500ms"])).toMatchObject({ sinceMs: 500 });
    expect(parseIncidentOptions(["--since", "30s"])).toMatchObject({ sinceMs: 30_000 });
    expect(parseIncidentOptions(["--since", "2m"])).toMatchObject({ sinceMs: 120_000 });
    expect(parseIncidentOptions(["--since", "1h"])).toMatchObject({ sinceMs: 3_600_000 });
    expect(() => parseIncidentOptions(["--since", "soon"])).toThrow();
    expect(() => parseIncidentOptions(["--since", "-5m"])).toThrow();
    expect(() => parseIncidentOptions(["--at", "yesterday"])).toThrow();
    expect(() => parseIncidentOptions(["--at", "2026-08-27T20:00:00Z", "--since", "1m"])).toThrow();
  });
  test("returns indeterminate when a reported incident has no temporal MCP evidence", () => {
    const input = healthy();
    input.mcp.lifecycle = undefined;
    expect(classifyIncident({ ...input, incidentAt: "2026-08-27T20:00:00.000Z" }).boundary).toBe("INDETERMINATE");
  });
  test("distinguishes historical backpressure from current saturation", () => {
    const result = classifyIncident(healthy({ mcp: { ...healthy().mcp, backpressure: { ...healthy().mcp.backpressure!, rejected: 2 } } }));
    expect(result.boundary).toBe("MCP_BACKPRESSURE");
    expect(result.summary).toContain("has occurred");
  });
});
