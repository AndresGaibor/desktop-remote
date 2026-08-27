import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceController } from "../../src/platform/service-controller";
import { readDesiredState } from "../../src/platform/desired-state";
import { makeTestPaths } from "../helpers/desktop-remote-paths";

class FakeManager {
  calls: string[] = [];
  async install() { this.calls.push("install"); }
  async start() { this.calls.push("start"); }
  async restart() { this.calls.push("restart"); }
  async stop() { this.calls.push("stop"); }
  async status() { this.calls.push("status"); return { loaded: true, enabled: true, pid: 123 }; }
}

describe("ServiceController", () => {
  test("restart recarga servicios companion antes de reiniciar el daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-service-restart-"));
    const paths = makeTestPaths(dir);
    const calls: string[] = [];
    const controller = new ServiceController({
      paths,
      manager: {
        install: async () => {},
        start: async () => {},
        stop: async () => {},
        restart: async () => { calls.push("daemon.restart"); },
      },
      requestStatus: async () => ({
        state: "online",
        restartCount: 0,
        consecutiveFailures: 0,
        startedAt: Date.now(),
        retainedCalls: 0,
      }),
      onBeforeManagerRestart: async () => { calls.push("companion.restart"); },
    });

    await controller.restart();

    expect(calls).toEqual(["companion.restart", "daemon.restart"]);
  });

  test("stop persists stopped before disabling the service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-service-stop-"));
    const paths = makeTestPaths(dir);
    const manager = new FakeManager();
    const observed: string[] = [];
    const controller = new ServiceController({ paths, manager, onBeforeManagerStop: async () => { observed.push(await readDesiredState(paths.desiredStatePath)); } });
    await controller.stop();
    expect(observed).toEqual(["stopped"]);
    expect(manager.calls).toEqual(["stop"]);
    expect(await readDesiredState(paths.desiredStatePath)).toBe("stopped");
  });

  test("start persists running, starts service and waits for healthy IPC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-service-start-"));
    const paths = makeTestPaths(dir);
    const manager = new FakeManager();
    let checks = 0;
    const controller = new ServiceController({
      paths,
      manager,
      requestStatus: async () => {
        checks += 1;
        if (checks < 2) throw new Error("offline");
        return { state: "online", restartCount: 0, consecutiveFailures: 0, startedAt: 1, retainedCalls: 0 };
      },
      sleep: async () => {},
    });
    const status = await controller.start();
    expect(await readDesiredState(paths.desiredStatePath)).toBe("running");
    expect(manager.calls).toEqual(["start"]);
    expect(checks).toBe(2);
    expect(status.state).toBe("online");
  });

  test("ensureRunning respects intentional stopped state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-service-intent-"));
    const paths = makeTestPaths(dir);
    const manager = new FakeManager();
    const controller = new ServiceController({ paths, manager });
    await controller.stop();
    await expect(controller.ensureRunning()).rejects.toThrow(/intentionally stopped/i);
    expect(manager.calls).toEqual(["stop"]);
  });
});
