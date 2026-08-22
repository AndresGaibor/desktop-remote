import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import { DesktopRemoteDaemon, type SupervisorController } from "../../src/daemon/daemon";
import type { SupervisorStatus } from "../../src/daemon/supervisor";

class FakeSupervisor implements SupervisorController {
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  starts = 0;
  stops = 0;
  currentStatus: SupervisorStatus = {
    state: "stopped",
    restartCount: 0,
    consecutiveFailures: 0,
    startedAt: 0,
  };

  start(): void {
    this.starts += 1;
    this.currentStatus = { ...this.currentStatus, state: "starting", startedAt: 1 };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.currentStatus = { ...this.currentStatus, state: "stopped" };
  }

  status(): SupervisorStatus {
    return { ...this.currentStatus };
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function started(callId: string): RuntimeEvent {
  return {
    type: "tool.started",
    callId,
    toolName: "read_file",
    args: { path: `/tmp/${callId}` },
    metadata: {},
    startedAt: 1,
  };
}

describe("DesktopRemoteDaemon", () => {
  test("bounds events before retaining or forwarding them", () => {
    const supervisor = new FakeSupervisor();
    const daemon = new DesktopRemoteDaemon({ supervisor });
    const forwarded: RuntimeEvent[] = [];
    daemon.onEvent((event) => forwarded.push(event));
    daemon.start();

    supervisor.emit(started("large"));
    supervisor.emit({
      type: "tool.completed",
      callId: "large",
      toolName: "read_file",
      resultText: "x".repeat(400 * 1024),
      completedAt: 2,
    });

    const row = daemon.snapshot().rows[0]!;
    expect(Buffer.byteLength(row.resultText ?? "")).toBeLessThanOrEqual(256 * 1024);
    const event = forwarded.at(-1);
    expect(event?.type).toBe("tool.completed");
    if (event?.type === "tool.completed") {
      expect(Buffer.byteLength(event.resultText)).toBeLessThanOrEqual(256 * 1024);
    }
  });

  test("start and stop are idempotent", async () => {
    const supervisor = new FakeSupervisor();
    const daemon = new DesktopRemoteDaemon({ supervisor });
    daemon.start();
    daemon.start();
    await daemon.stop();
    await daemon.stop();
    expect(supervisor.starts).toBe(1);
    expect(supervisor.stops).toBe(1);
  });

  test("runtime restarts do not clear the retained 50-call history", () => {
    const supervisor = new FakeSupervisor();
    const daemon = new DesktopRemoteDaemon({ supervisor });
    daemon.start();
    for (let index = 0; index < 55; index += 1) supervisor.emit(started(`call-${index}`));
    supervisor.emit({ type: "runtime.exited", code: 1, signal: null, at: 2 });
    for (let index = 55; index < 60; index += 1) supervisor.emit(started(`call-${index}`));

    const snapshot = daemon.snapshot();
    expect(snapshot.rows).toHaveLength(50);
    expect(snapshot.rows[0]?.callId).toBe("call-10");
    expect(snapshot.rows.at(-1)?.callId).toBe("call-59");
  });

  test("status combines supervisor health with retained call count", () => {
    const supervisor = new FakeSupervisor();
    const daemon = new DesktopRemoteDaemon({ supervisor });
    daemon.start();
    supervisor.emit(started("a"));
    expect(daemon.status()).toMatchObject({ state: "starting", retainedCalls: 1 });
  });
});
