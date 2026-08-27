import { describe, expect, test } from "bun:test";
import {
  OperationDeadlineExceededError,
  OperationScheduler,
  OperationSchedulerBusyError,
  OperationSchedulerCancelledError,
  type OperationClass,
} from "../../src/core/operation-scheduler";

const ALL_CLASSES: OperationClass[] = ["light", "heavy", "process", "document"];

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = (value) => nextResolve(value as T | PromiseLike<T>);
  });
  return { promise, resolve };
}

describe("OperationScheduler", () => {
  test("enforces independent concurrency caps for every operation class", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 2, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 20,
      maxQueueSizeByClass: { light: 20, heavy: 20, process: 20, document: 20 },
    });
    const gates = new Map<OperationClass, ReturnType<typeof deferred>>();
    const active: Record<OperationClass, number> = {
      light: 0,
      heavy: 0,
      process: 0,
      document: 0,
    };
    const maximum: Record<OperationClass, number> = { ...active };
    for (const operationClass of ALL_CLASSES) gates.set(operationClass, deferred());

    const run = (operationClass: OperationClass) => scheduler.run(operationClass, async () => {
      active[operationClass] += 1;
      maximum[operationClass] = Math.max(maximum[operationClass], active[operationClass]);
      await gates.get(operationClass)!.promise;
      active[operationClass] -= 1;
    });

    const operations = [
      run("light"), run("light"), run("light"),
      run("heavy"), run("heavy"),
      run("process"), run("process"),
      run("document"), run("document"),
    ];
    await Bun.sleep(0);

    expect(maximum).toEqual({ light: 2, heavy: 1, process: 1, document: 1 });

    for (const gate of gates.values()) gate.resolve();
    await Promise.all(operations);
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 0, totalQueued: 0 });
  });

  test("starts queued work FIFO within each class", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 10,
      maxQueueSizeByClass: { light: 10, heavy: 10, process: 10, document: 10 },
    });
    const firstGate = deferred();
    const started: string[] = [];

    const first = scheduler.run("light", async () => {
      started.push("first");
      await firstGate.promise;
    });
    const second = scheduler.run("light", async () => { started.push("second"); });
    const third = scheduler.run("light", async () => { started.push("third"); });
    await Bun.sleep(0);

    expect(started).toEqual(["first"]);
    expect(scheduler.snapshot().queued.light).toBe(2);

    firstGate.resolve();
    await Promise.all([first, second, third]);
    expect(started).toEqual(["first", "second", "third"]);
  });

  test("rejects with a typed busy error when the class queue is full", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 10,
      maxQueueSizeByClass: { light: 1, heavy: 10, process: 10, document: 10 },
    });
    const gate = deferred();
    const running = scheduler.run("light", () => gate.promise);
    const queued = scheduler.run("light", async () => "queued");

    await expect(scheduler.run("light", async () => "rejected"))
      .rejects.toBeInstanceOf(OperationSchedulerBusyError);
    await expect(scheduler.run("light", async () => "rejected"))
      .rejects.toMatchObject({ code: "OPERATION_SCHEDULER_BUSY", operationClass: "light", limit: "class" });

    gate.resolve();
    await Promise.all([running, queued]);
  });

  test("rejects with a typed busy error when the global queue is full", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 1,
      maxQueueSizeByClass: { light: 10, heavy: 10, process: 10, document: 10 },
    });
    const lightGate = deferred();
    const heavyGate = deferred();
    const light = scheduler.run("light", () => lightGate.promise);
    const heavy = scheduler.run("heavy", () => heavyGate.promise);
    const queued = scheduler.run("light", async () => "queued");

    await expect(scheduler.run("heavy", async () => "rejected"))
      .rejects.toMatchObject({ code: "OPERATION_SCHEDULER_BUSY", limit: "global" });

    lightGate.resolve();
    heavyGate.resolve();
    await Promise.all([light, heavy, queued]);
  });

  test("removes queued work when cancelled before start without leaking queue capacity", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 1,
      maxQueueSizeByClass: { light: 1, heavy: 10, process: 10, document: 10 },
    });
    const gate = deferred();
    const running = scheduler.run("light", () => gate.promise);
    const controller = new AbortController();
    let started = false;
    const cancelled = scheduler.run("light", async () => {
      started = true;
      return "should not run";
    }, { signal: controller.signal });

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(OperationSchedulerCancelledError);
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 1, totalQueued: 0 });

    const replacement = scheduler.run("light", async () => "replacement");
    gate.resolve();
    await expect(replacement).resolves.toBe("replacement");
    await running;
    expect(started).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 0, totalQueued: 0 });
  });

  test("removes queued work when its deadline expires without leaking a slot", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 1,
      maxQueueSizeByClass: { light: 1, heavy: 10, process: 10, document: 10 },
    });
    const gate = deferred();
    const running = scheduler.run("light", () => gate.promise);
    const deadline = scheduler.run("light", async () => "expired", { deadlineAt: Date.now() + 20 });

    await expect(deadline).rejects.toBeInstanceOf(OperationDeadlineExceededError);
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 1, totalQueued: 0 });

    const replacement = scheduler.run("light", async () => "replacement");
    gate.resolve();
    await expect(replacement).resolves.toBe("replacement");
    await running;
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 0, totalQueued: 0 });
  }, 10_000);

  test("does not start queued work after its deadline when a slot drains late", async () => {
    let now = 1_000;
    const scheduler = new OperationScheduler({
      now: () => now,
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 1,
      maxQueueSizeByClass: { light: 1, heavy: 1, process: 1, document: 1 },
    });
    const gate = deferred();
    const running = scheduler.run("light", () => gate.promise);
    let started = false;
    const expired = scheduler.run("light", async () => {
      started = true;
      return "expired";
    }, { deadlineAt: 2_000 });

    now = 3_000;
    gate.resolve();
    await expect(expired).rejects.toBeInstanceOf(OperationDeadlineExceededError);
    await running;
    expect(started).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 0, totalQueued: 0 });
  });

  test("releases a slot after failure so the next queued operation can run", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 2,
      maxQueueSizeByClass: { light: 2, heavy: 2, process: 2, document: 2 },
    });
    const failure = scheduler.run("light", async () => { throw new Error("boom"); });
    const next = scheduler.run("light", async () => "ok");

    await expect(failure).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    expect(scheduler.snapshot()).toMatchObject({ totalActive: 0, totalQueued: 0 });
  });

  test("a hung heavy operation does not block an independent light operation", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 2,
      maxQueueSizeByClass: { light: 2, heavy: 2, process: 2, document: 2 },
    });
    const heavyGate = deferred();
    const heavy = scheduler.run("heavy", () => heavyGate.promise);
    await Bun.sleep(0);

    await expect(scheduler.run("light", async () => "light-result")).resolves.toBe("light-result");
    expect(scheduler.snapshot()).toMatchObject({
      active: { heavy: 1, light: 0 },
      queued: { heavy: 0, light: 0 },
    });

    heavyGate.resolve();
    await heavy;
  });

  test("returns a safe metrics snapshot that callers cannot mutate", async () => {
    const scheduler = new OperationScheduler({
      concurrency: { light: 1, heavy: 1, process: 1, document: 1 },
      maxQueueSize: 1,
      maxQueueSizeByClass: { light: 1, heavy: 1, process: 1, document: 1 },
    });
    const gate = deferred();
    const running = scheduler.run("light", () => gate.promise);
    const queued = scheduler.run("light", async () => "queued");
    await Bun.sleep(0);

    const snapshot = scheduler.snapshot();
    snapshot.active.light = 99;
    snapshot.queued.light = 99;
    expect(scheduler.snapshot()).toMatchObject({ active: { light: 1 }, queued: { light: 1 } });

    gate.resolve();
    await Promise.all([running, queued]);
  });
});
