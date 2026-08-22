import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import { DaemonSupervisor, type ManagedRuntime } from "../../src/daemon/supervisor";

class FakeRuntime implements ManagedRuntime {
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  running = false;
  stops = 0;

  constructor(readonly pid: number) {}

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) throw new Error("fake runtime already running");
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  emit(event: RuntimeEvent): void {
    if (event.type === "runtime.exited") this.running = false;
    for (const listener of [...this.listeners]) listener(event);
  }
}
class RuntimeFactory {
  readonly runtimes: FakeRuntime[] = [];
  maxLive = 0;

  create = (): ManagedRuntime => {
    const runtime = new FakeRuntime(4_000 + this.runtimes.length);
    const originalStart = runtime.start.bind(runtime);
    runtime.start = () => {
      originalStart();
      this.maxLive = Math.max(this.maxLive, this.liveCount());
    };
    this.runtimes.push(runtime);
    return runtime;
  };

  liveCount(): number {
    return this.runtimes.filter((runtime) => runtime.running).length;
  }
}

class ControlledSleeps {
  readonly delays: number[] = [];
  private readonly resolvers: Array<() => void> = [];

  sleep = (delayMs: number): Promise<void> => {
    this.delays.push(delayMs);
    return new Promise((resolve) => this.resolvers.push(resolve));
  };

  async releaseNext(): Promise<void> {
    const resolve = this.resolvers.shift();
    if (!resolve) throw new Error("no pending sleep");
    resolve();
    await Bun.sleep(0);
  }
}
function exited(at = 1): RuntimeEvent {
  return { type: "runtime.exited", code: 1, signal: null, at };
}

function setupSupervisor() {
  const factory = new RuntimeFactory();
  const sleeps = new ControlledSleeps();
  let now = 0;
  const supervisor = new DaemonSupervisor({
    createRuntime: factory.create,
    sleep: sleeps.sleep,
    now: () => now,
  });
  return {
    supervisor,
    factory,
    sleeps,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("DaemonSupervisor", () => {
  test("starts one child and follows auth/online state", () => {
    const { supervisor, factory } = setupSupervisor();
    supervisor.start();
    expect(factory.liveCount()).toBe(1);
    expect(supervisor.status()).toMatchObject({ state: "starting", childPid: 4_000 });

    factory.runtimes[0]!.emit({
      type: "auth.required", url: "https://example.test", code: "ABCD-EFGH", expiresIn: "15m", at: 1,
    });
    expect(supervisor.status().state).toBe("auth");
    factory.runtimes[0]!.emit({
      type: "device.ready", user: "u@example.test", deviceId: "d1", deviceName: "mac", at: 2,
    });
    expect(supervisor.status().state).toBe("online");
  });

  test("restarts exactly once after an unexpected exit and never overlaps children", async () => {
    const { supervisor, factory, sleeps, setNow } = setupSupervisor();
    supervisor.start();
    setNow(1_000);
    factory.runtimes[0]!.emit(exited(1_000));

    expect(supervisor.status()).toMatchObject({ state: "recovering", restartCount: 0 });
    expect(sleeps.delays).toEqual([1_000]);
    expect(factory.liveCount()).toBe(0);

    await sleeps.releaseNext();
    expect(factory.runtimes).toHaveLength(2);
    expect(factory.liveCount()).toBe(1);
    expect(factory.maxLive).toBe(1);
    expect(supervisor.status()).toMatchObject({
      state: "starting",
      childPid: 4_001,
      restartCount: 1,
      lastRestartAt: 1_000,
    });
  });

  test("stop during backoff prevents a stale retry from resurrecting the runtime", async () => {
    const { supervisor, factory, sleeps, setNow } = setupSupervisor();
    supervisor.start();
    setNow(1_000);
    factory.runtimes[0]!.emit(exited(1_000));
    await supervisor.stop();

    expect(supervisor.status().state).toBe("stopped");
    await sleeps.releaseNext();
    expect(factory.runtimes).toHaveLength(1);
    expect(factory.liveCount()).toBe(0);
  });

  test("ten unstable exits enter degraded five-minute retries", async () => {
    const { supervisor, factory, sleeps, setNow } = setupSupervisor();
    supervisor.start();

    for (let failure = 1; failure <= 10; failure += 1) {
      setNow(failure * 1_000);
      factory.runtimes.at(-1)!.emit(exited(failure * 1_000));
      if (failure < 10) await sleeps.releaseNext();
    }

    expect(sleeps.delays.at(-1)).toBe(300_000);
    expect(supervisor.status()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 10,
      restartCount: 9,
    });
    expect(factory.maxLive).toBe(1);
  });

  test("forwards runtime events to daemon listeners", () => {
    const { supervisor, factory } = setupSupervisor();
    const events: RuntimeEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    supervisor.start();
    factory.runtimes[0]!.emit({ type: "runtime.log", source: "stdout", message: "hello", at: 1 });
    expect(events.at(-1)).toMatchObject({ type: "runtime.log", message: "hello" });
  });

  test("stop gracefully stops the current child once", async () => {
    const { supervisor, factory } = setupSupervisor();
    supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(factory.runtimes[0]!.stops).toBe(1);
    expect(factory.liveCount()).toBe(0);
  });
});