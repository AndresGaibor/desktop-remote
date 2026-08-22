import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import type { ManagedRuntime } from "../../src/daemon/supervisor";
import { parseDaemonDevArgs, runDaemon, type DaemonSignalSource } from "../../src/daemon/run-daemon";

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
  test("starts foreground daemon and shuts down once on SIGTERM", async () => {
    const runtime = new FakeRuntime();
    const signals = new FakeSignals();
    const running = runDaemon({ createRuntime: () => runtime, signals });
    await Bun.sleep(0);
    expect(runtime.starts).toBe(1);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    await running;
    expect(runtime.stops).toBe(1);
  });

  test("parses the development command override without changing production defaults", () => {
    expect(parseDaemonDevArgs([])).toEqual({});
    expect(parseDaemonDevArgs(["--cmd", "/tmp/fake", "--", "arg-a", "arg-b"]))
      .toEqual({ command: "/tmp/fake", args: ["arg-a", "arg-b"] });
  });
});
