import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import type { ManagedRuntime } from "../../src/daemon/supervisor";
import type { HistoryStore } from "../../src/daemon/history-store";
import type { DaemonIpcServer } from "../../src/daemon/ipc-server";
import { LocalRuntime, parseDaemonDevArgs, runDaemon, type DaemonSignalSource } from "../../src/daemon/run-daemon";

class FakeRuntime implements ManagedRuntime {
  running = false;
  pid = 777;
  starts = 0;
  stops = 0;
  onEvent(_listener: (event: RuntimeEvent) => void): () => void {
    return () => {};
  }
  start(): void {
    this.starts += 1;
    this.running = true;
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
}

class FakeSignals implements DaemonSignalSource {
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();
  on(signal: NodeJS.Signals, listener: () => void): void {
    const set = this.listeners.get(signal) ?? new Set();
    set.add(listener);
    this.listeners.set(signal, set);
  }
  off(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }
  emit(signal: NodeJS.Signals): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }
}

describe("runDaemon", () => {
  test("local runtime stays running and emits lifecycle events without spawning", async () => {
    const runtime = new LocalRuntime({ now: () => 10 });
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    runtime.start();
    expect(runtime.running).toBe(true);
    expect(events).toEqual([{
      type: "device.ready",
      user: "local",
      deviceId: "desktop-remote",
      deviceName: "Desktop Remote Local Runtime",
      at: 10,
    }]);

    await runtime.stop();
    expect(runtime.running).toBe(false);
    expect(events.at(-1)).toEqual({ type: "runtime.exited", code: 0, signal: null, at: 10 });
  });

  test("starts foreground daemon and shuts down once on SIGTERM", async () => {
    const runtime = new FakeRuntime();
    const signals = new FakeSignals();
    const history = { loadInto: async () => {}, append: async () => {} } as unknown as HistoryStore;
    const logger = { info: async () => {}, warn: async () => {}, error: async () => {} };
    const ipc = { start: async () => {}, stop: async () => {} } as unknown as DaemonIpcServer;
    const running = runDaemon({ createRuntime: () => runtime, signals, history, logger, ipcServer: ipc });
    for (let i = 0; i < 10 && runtime.starts === 0; i += 1) await Bun.sleep(0);
    expect(runtime.starts).toBe(1);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    await running;
    expect(runtime.stops).toBe(1);
  });

  test("waits for history restore before starting runtime or IPC", async () => {
    const runtime = new FakeRuntime();
    const signals = new FakeSignals();
    let release!: () => void;
    const loading = new Promise<void>((resolve) => { release = resolve; });
    const history = { loadInto: async () => loading, append: async () => {} } as unknown as HistoryStore;
    const ipcCalls: string[] = [];
    const ipc = {
      start: async () => { ipcCalls.push("start"); },
      stop: async () => { ipcCalls.push("stop"); },
    } as unknown as DaemonIpcServer;

    const running = runDaemon({ createRuntime: () => runtime, signals, history, ipcServer: ipc });
    await Bun.sleep(0);
    expect(runtime.starts).toBe(0);
    expect(ipcCalls).toEqual([]);
    release();
    await Bun.sleep(0);
    expect(runtime.starts).toBe(1);
    expect(ipcCalls).toEqual(["start"]);
    signals.emit("SIGTERM");
    await running;
    expect(ipcCalls).toEqual(["start", "stop"]);
  });

  test("parses the development command override without changing production defaults", () => {
    expect(parseDaemonDevArgs([])).toEqual({});
    expect(parseDaemonDevArgs(["--cmd", "/tmp/fake", "--", "arg-a", "arg-b"]))
      .toEqual({ command: "/tmp/fake", args: ["arg-a", "arg-b"] });
  });
});
