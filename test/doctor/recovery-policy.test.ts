import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateRecovery, type RecoveryHistory, type RecoveryObservation } from "../../src/doctor/recovery-policy";
import { repairTunnel } from "../../src/doctor/repair";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

const healthyLocal = { configured: true, liveness: true, readiness: true, processAlive: true };

function observation(overrides: Partial<RecoveryObservation> = {}): RecoveryObservation {
  return {
    now: 1_000_000,
    local: healthyLocal,
    controlPlane: { reachable: true, stale: false },
    ...overrides,
  };
}

describe("evaluateRecovery", () => {
  test("no reinicia por una caída del control plane si el túnel local está sano", () => {
    const result = evaluateRecovery(observation({ controlPlane: { reachable: false, stale: true } }), {});

    expect(result.action).toBe("observe");
    expect(result.reason).toMatch(/control plane/i);
    expect(result.history.restartTimes).toEqual([]);
  });

  test("reinicia solo cuando la liveness local prueba que el túnel está muerto", () => {
    const result = evaluateRecovery(observation({
      local: { ...healthyLocal, liveness: false, processAlive: false },
      controlPlane: { reachable: false, stale: true },
    }), {});

    expect(result.action).toBe("restart_tunnel");
    expect(result.reason).toMatch(/local/i);
    expect(result.history.restartTimes).toEqual([1_000_000]);
  });

  test("permite reparar un túnel local explícitamente atascado aunque siga vivo", () => {
    const result = evaluateRecovery(observation({
      local: { ...healthyLocal, readiness: false, stuck: true },
    }), {});

    expect(result.action).toBe("restart_tunnel");
  });

  test("abre el circuito cuando se agota el presupuesto dentro de la ventana", () => {
    const history: RecoveryHistory = { restartTimes: [999_000, 999_500, 999_900] };
    const result = evaluateRecovery(observation({
      local: { ...healthyLocal, liveness: false, processAlive: false },
    }), history, { maxRestarts: 3, windowMs: 10_000 });

    expect(result.action).toBe("circuit_open");
    expect(result.history.restartTimes).toEqual(history.restartTimes);
  });

  test("respeta cooldown y limpia el historial después de un periodo sano", () => {
    const cooling = evaluateRecovery(observation({
      local: { ...healthyLocal, liveness: false, processAlive: false },
    }), { restartTimes: [999_950] }, { cooldownMs: 100 });
    expect(cooling.action).toBe("observe");

    const recovered = evaluateRecovery(observation(), { restartTimes: [900_000] }, { healthyResetMs: 50_000 });
    expect(recovered.action).toBe("healthy");
    expect(recovered.history.restartTimes).toEqual([]);
  });

  test("repair es de una sola ejecución y solo invoca el reinicio con evidencia local", async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-remote-repair-"));
    try {
      let restarts = 0;
      const paths = makeTestPaths(root);
      const result = await repairTunnel(paths, {
        now: () => 1_000_000,
        collect: async () => ({
          daemonAlive: true,
          mcpReachable: true,
          tunnelHealthy: false,
          tunnelDiagnostics: {
            baseUrl: "http://127.0.0.1:4321",
            state: "unreachable",
            healthz: { ok: false, status: null },
            readyz: { ok: false, status: null },
            api: {
              status: { available: false, status: null },
              system: { available: false, status: null },
            },
            metrics: { available: false, status: null },
            selected: { liveness: false, readiness: false },
          },
          diskFreeBytes: 1n,
          diskTotalBytes: 2n,
          recentErrors: [],
          schemaHashCurrent: "same",
          schemaHashStored: "same",
          configValid: true,
          configErrors: [],
        }),
        restartTunnel: async () => { restarts += 1; },
      });

      expect(result.action).toBe("restart_tunnel");
      expect(restarts).toBe(1);
      expect(JSON.parse(await readFile(join(root, "recovery-state.json"), "utf8")).restartTimes).toEqual([1_000_000]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
