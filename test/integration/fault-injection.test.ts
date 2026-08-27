import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRemoteDaemon } from "../../src/daemon/daemon";
import { DaemonSupervisor, type ManagedRuntime } from "../../src/daemon/supervisor";
import type { RuntimeEvent } from "../../src/runtime/events";
import { HistoryStore } from "../../src/daemon/history-store";
import { DesktopOperationExecutor } from "../../src/core/executor";
import { OperationScheduler } from "../../src/core/operation-scheduler";
import { SearchManager } from "../../src/search/manager";

class CrashRuntime implements ManagedRuntime {
  pid = 10;
  running = false;
  private listener?: (event: RuntimeEvent) => void;
  onEvent(listener: (event: RuntimeEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  start() { this.running = true; }
  async stop() { this.running = false; }
  crash() { this.running = false; this.listener?.({ type: "runtime.exited", code: 1, signal: null, at: Date.now() }); }
}

describe("fault injection", () => {
  test("a hung heavy daemon operation does not block an independent light operation", async () => {
    const searchGate = deferred<{ id: string; sessionId: string; status: "completed" }>();
    const slowSearch = {
      start: async () => searchGate.promise,
    } as unknown as SearchManager;
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 2,
      maxQueueSizeByClass: { light: 2, heavy: 2, process: 2, document: 2 },
    });
    const supervisor = new DaemonSupervisor({ createRuntime: () => new CrashRuntime(), sleep: async () => {} });
    const operationExecutor = new DesktopOperationExecutor(slowSearch, undefined, scheduler);
    const daemon = new DesktopRemoteDaemon({ supervisor, operationExecutor });
    await daemon.start();

    const heavy = daemon.execute("start_search", {
      path: "/tmp",
      pattern: "needle",
      searchType: "content",
    });
    await Bun.sleep(0);

    await expect(daemon.execute("get_config", {})).resolves.toMatchObject({
      defaultShell: expect.any(String),
    });
    expect(operationExecutor.getSchedulerSnapshot()).toMatchObject({
      active: { heavy: 1, light: 0 },
    });

    searchGate.resolve({ id: "search-1", sessionId: "search-1", status: "completed" });
    await heavy;
    await daemon.stop();
  });

  test("repeated child crashes converge to degraded without overlapping children", async () => {
    const runtimes: CrashRuntime[] = [];
    const sleeps: Array<() => void> = [];
    const supervisor = new DaemonSupervisor({
      createRuntime: () => { const runtime = new CrashRuntime(); runtimes.push(runtime); return runtime; },
      sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
      now: (() => { let n = 0; return () => ++n; })(),
    });
    supervisor.start();
    for (let i = 0; i < 10; i += 1) {
      runtimes.at(-1)!.crash();
      expect(runtimes.filter((runtime) => runtime.running)).toHaveLength(0);
      if (i === 9) {
        expect(supervisor.status().state).toBe("degraded");
        break;
      }
      sleeps.shift()?.();
      await Bun.sleep(0);
      expect(runtimes.filter((runtime) => runtime.running).length).toBeLessThanOrEqual(1);
    }
    await supervisor.stop();
  });

  test("history write failure leaves daemon alive and status queryable", async () => {
    const runtime = new CrashRuntime();
    const supervisor = new DaemonSupervisor({ createRuntime: () => runtime, sleep: async () => {} });
    const history = { loadInto: async () => {}, append: async () => { throw new Error("disk full"); } } as unknown as HistoryStore;
    const daemon = new DesktopRemoteDaemon({ supervisor, history });
    await daemon.start();
    expect(daemon.status().state).toBe("starting");
    await daemon.stop();
  });

  test("corrupt optional history never prevents a fresh daemon state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-fault-history-"));
    const path = join(dir, "history.jsonl");
    await Bun.write(path, '{"stateVersion":1,"kind":"event","event":{"type":"runtime.error","message":"old","at":1}}\nnot-json\n');
    const warnings: string[] = [];
    const history = new HistoryStore({ path, onWarning: (message) => warnings.push(message) });
    const runtime = new CrashRuntime();
    const daemon = new DesktopRemoteDaemon({ supervisor: new DaemonSupervisor({ createRuntime: () => runtime, sleep: async () => {} }), history });
    await daemon.start();
    expect(warnings).toHaveLength(1);
    expect(daemon.status().state).toBe("starting");
    await daemon.stop();
  });
});

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = (value) => nextResolve(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}
