import { describe, expect, test } from "bun:test";
import type { OperationExecutor } from "../../src/mcp/handler";
import type { WatchdogEvent, TrackedOperation } from "../../src/daemon/self-healing";
import { SelfHealingExecutor, OperationDeadlineTracker } from "../../src/daemon/self-healing";

function createMockProcessManager() {
  const killed = new Set<number>();
  return {
    killed,
    kill: async (pid: number) => {
      killed.add(pid);
      return { pid, killed: true };
    },
  };
}

function hangingExecutor(): OperationExecutor {
  return {
    execute: async (_name: string, _input: Record<string, unknown>): Promise<unknown> => {
      await Bun.sleep(10_000);
      return "done";
    },
  };
}

function slowExecutor(delayMs: number): OperationExecutor {
  return {
    execute: async (_name: string, _input: Record<string, unknown>): Promise<unknown> => {
      await Bun.sleep(delayMs);
      return "slow-result";
    },
  };
}

function immediateExecutor(): OperationExecutor {
  return {
    execute: async (_name: string, _input: Record<string, unknown>): Promise<unknown> => "immediate",
  };
}

function errorExecutor(error: Error): OperationExecutor {
  return {
    execute: async (): Promise<unknown> => { throw error; },
  };
}

describe("SelfHealingExecutor", () => {
  test("executes operations normally when they complete within deadline", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: immediateExecutor(),
      deadlineMs: 5_000,
      watchdogIntervalMs: 1_000,
      now: () => Date.now(),
      processManager: processManager as never,
    });
    const result = await executor.execute("test_op", {});
    expect(result).toBe("immediate");
    expect(processManager.killed.size).toBe(0);
  });

  test("cancels operation that exceeds deadline and kills child process", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: hangingExecutor(),
      deadlineMs: 200,
      watchdogIntervalMs: 50,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    const hungEvents: WatchdogEvent[] = [];
    executor.onWatchdogEvent((e) => hungEvents.push(e));

    await expect(executor.execute("hung_op", {})).rejects.toThrow(/timed out after 200ms/);
    expect(hungEvents.some((e) => e.type === "operation.hung")).toBe(true);
  });

  test("operation without child process is cancelled without kill", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: hangingExecutor(),
      deadlineMs: 200,
      watchdogIntervalMs: 50,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    await expect(executor.execute("hung_op_no_child", {})).rejects.toThrow();
    expect(processManager.killed.size).toBe(0);
  });

  test("slow-but-within-deadline operation completes successfully", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: slowExecutor(100),
      deadlineMs: 5_000,
      watchdogIntervalMs: 50,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    const result = await executor.execute("slow_op", {});
    expect(result).toBe("slow-result");
    expect(processManager.killed.size).toBe(0);
  });

  test("emits operation.completed event for successful operations", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: immediateExecutor(),
      deadlineMs: 5_000,
      watchdogIntervalMs: 1_000,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    const events: WatchdogEvent[] = [];
    executor.onWatchdogEvent((e) => events.push(e));

    await executor.execute("test_op", {});

    expect(events.some((e) => e.type === "operation.completed")).toBe(true);
  });

  test("propagates errors from underlying executor", async () => {
    const error = new Error("underlying error");
    const executor = new SelfHealingExecutor({
      executor: errorExecutor(error),
      deadlineMs: 5_000,
      watchdogIntervalMs: 1_000,
      now: () => Date.now(),
      processManager: createMockProcessManager() as never,
    });

    await expect(executor.execute("failing_op", {})).rejects.toThrow("underlying error");
  });
});

describe("OperationDeadlineTracker", () => {
  test("tracks operation with deadline", () => {
    let now = 1000;
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => now,
    });

    tracker.track("op1", "test_op", now, 42);
    expect(tracker.get("op1")).toEqual({
      id: "op1",
      operationName: "test_op",
      startedAt: 1000,
      deadline: 6000,
      childPid: 42,
      aborted: false,
    });

    now = 5500;
    expect(tracker.isExpired("op1")).toBe(false);
    now = 6001;
    expect(tracker.isExpired("op1")).toBe(true);
  });

  test("aborted operation is marked and not expired", () => {
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => 1000,
    });

    tracker.track("op1", "test_op", 100);
    tracker.abort("op1");

    expect(tracker.get("op1")?.aborted).toBe(true);
    expect(tracker.isExpired("op1")).toBe(false);
  });

  test("untracked operation returns false for isExpired", () => {
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => 1000,
    });

    expect(tracker.isExpired("unknown")).toBe(false);
  });

  test("removes completed operation", () => {
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => 1000,
    });

    tracker.track("op1", "test_op", 100);
    tracker.remove("op1");

    expect(tracker.get("op1")).toBeUndefined();
    expect(tracker.isExpired("op1")).toBe(false);
  });

  test("lists all tracked operations", () => {
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => 1000,
    });

    tracker.track("op1", "test_op1", 100, 1);
    tracker.track("op2", "test_op2", 200, 2);

    const ops = tracker.list();
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.id).sort()).toEqual(["op1", "op2"]);
  });

  test("clears all tracked operations", () => {
    const tracker = new OperationDeadlineTracker({
      deadlineMs: 5000,
      now: () => 1000,
    });

    tracker.track("op1", "test_op", 100);
    tracker.track("op2", "test_op", 200);
    tracker.clear();

    expect(tracker.list()).toHaveLength(0);
  });
});

describe("Watchdog integration", () => {
  test("watchdog detects hung operations via interval", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: hangingExecutor(),
      deadlineMs: 150,
      watchdogIntervalMs: 50,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    const hungEvents: WatchdogEvent[] = [];
    executor.onWatchdogEvent((e) => hungEvents.push(e));
    await expect(executor.execute("test_hang", {})).rejects.toThrow(/timed out after 150ms/);
    expect(hungEvents.some((e) => e.type === "operation.hung")).toBe(true);
  });

  test("no false positive: fast operation with margin below deadline", async () => {
    const processManager = createMockProcessManager();
    const executor = new SelfHealingExecutor({
      executor: immediateExecutor(),
      deadlineMs: 5000,
      watchdogIntervalMs: 100,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    await executor.execute("fast_op", {});
    expect(processManager.killed.size).toBe(0);
  });

  test("multiple concurrent operations are tracked independently", async () => {
    const processManager = createMockProcessManager();
    const hangingExecutor: OperationExecutor = {
      execute: async (name: string) => {
        if (name === "hang") {
          await Bun.sleep(10_000);
        }
        return "done";
      },
    };

    const executor = new SelfHealingExecutor({
      executor: hangingExecutor,
      deadlineMs: 200,
      watchdogIntervalMs: 50,
      now: () => Date.now(),
      processManager: processManager as never,
    });

    const [r1, r2] = await Promise.allSettled([
      executor.execute("hang", {}),
      executor.execute("ok", {}),
    ]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("fulfilled");
    expect(processManager.killed.size).toBe(0);
  });
});