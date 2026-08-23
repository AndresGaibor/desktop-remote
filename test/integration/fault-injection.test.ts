import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRemoteDaemon } from "../../src/daemon/daemon";
import { DaemonSupervisor, type ManagedRuntime } from "../../src/daemon/supervisor";
import type { RuntimeEvent } from "../../src/runtime/events";
import { HistoryStore } from "../../src/daemon/history-store";

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
