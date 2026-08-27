import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import { DesktopRemoteDaemon, type SupervisorController } from "../../src/daemon/daemon";
import type { HistoryStore } from "../../src/daemon/history-store";
import type { SupervisorStatus } from "../../src/daemon/supervisor";

class FakeLogger {
  readonly entries: Array<{ level: string; message: string; data?: unknown }> = [];

  info(message: string, data?: unknown): Promise<void> {
    this.entries.push({ level: "info", message, data });
    return Promise.resolve();
  }

  warn(message: string, data?: unknown): Promise<void> {
    this.entries.push({ level: "warn", message, data });
    return Promise.resolve();
  }

  error(message: string, data?: unknown): Promise<void> {
    this.entries.push({ level: "error", message, data });
    return Promise.resolve();
  }
}

class FakeSupervisor implements SupervisorController {
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  readonly statusListeners = new Set<(status: SupervisorStatus) => void>();
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

  onStatus(listener: (status: SupervisorStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitStatus(): void {
    const status = this.status();
    for (const listener of [...this.statusListeners]) listener(status);
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

  test("records MCP operations as global activity and forwards them live", async () => {
    const supervisor = new FakeSupervisor();
    const forwarded: RuntimeEvent[] = [];
    const daemon = new DesktopRemoteDaemon({
      supervisor,
      operationExecutor: { execute: async () => ({ ok: true }) },
    });
    daemon.onEvent((event) => forwarded.push(event));
    daemon.start();

    const result = await daemon.execute("read_file", { path: "/tmp/example" }, { callId: "request-1" });

    expect(result).toEqual({ ok: true });
    expect(forwarded.map((event) => event.type)).toEqual(["tool.started", "tool.completed"]);
    expect(daemon.snapshot().rows).toMatchObject([{
      callId: "request-1",
      toolName: "read_file",
      status: "completed",
      resultText: '{"ok":true}',
    }]);
  });

  test("records failed MCP operations as global activity", async () => {
    const supervisor = new FakeSupervisor();
    const forwarded: RuntimeEvent[] = [];
    const daemon = new DesktopRemoteDaemon({
      supervisor,
      operationExecutor: { execute: async () => { throw new Error("boom"); } },
    });
    daemon.onEvent((event) => forwarded.push(event));
    daemon.start();

    await expect(daemon.execute("read_file", {}, { callId: "request-2" })).rejects.toThrow("boom");

    expect(forwarded.map((event) => event.type)).toEqual(["tool.started", "tool.failed"]);
    expect(daemon.snapshot().rows).toMatchObject([{
      callId: "request-2",
      status: "failed",
      error: "boom",
    }]);
  });

  test("logs lifecycle and operational events without logging tool calls, heartbeats, or raw lines", async () => {
    const supervisor = new FakeSupervisor();
    const logger = new FakeLogger();
    const daemon = new DesktopRemoteDaemon({ supervisor, logger });
    daemon.start();
    supervisor.emit({
      type: "tool.started",
      callId: "call-1",
      toolName: "read_file",
      args: {},
      metadata: {},
      startedAt: 1,
    });
    supervisor.emit({ type: "runtime.log", source: "stdout", message: "heartbeat", at: 2 });
    supervisor.emit({
      type: "auth.required",
      url: "https://example.test/device?token=secret",
      code: "ABCD-EFGH",
      expiresIn: "15 minutes",
      at: 3,
    });
    supervisor.emit({ type: "runtime.error", message: "child failed", at: 4 });
    supervisor.currentStatus = { ...supervisor.currentStatus, state: "recovering", restartCount: 1 };
    supervisor.emitStatus();

    const messages = logger.entries.map((entry) => entry.message);
    expect(messages).toContain("daemon.starting");
    expect(messages).toContain("authentication required");
    expect(messages).toContain("runtime error");
    expect(messages).toContain("supervisor state changed");
    expect(messages).toContain("supervisor restarted runtime");
    expect(messages).not.toContain("tool.started");
    expect(messages).not.toContain("heartbeat");
    expect(logger.entries.find((entry) => entry.message === "authentication required")?.data).toEqual({
      expiresIn: "15 minutes",
    });

    await daemon.stop();
    expect(logger.entries.map((entry) => entry.message)).toContain("daemon.stopped");
  });

  test("logs a persistence warning without terminating the daemon", async () => {
    const supervisor = new FakeSupervisor();
    const logger = new FakeLogger();
    const history = {
      loadInto: async () => {},
      append: async () => { throw new Error("disk full"); },
    } as unknown as HistoryStore;
    const daemon = new DesktopRemoteDaemon({ supervisor, history, logger });
    await daemon.start();
    supervisor.emit(started("persisted"));
    await Bun.sleep(0);

    expect(daemon.status().state).toBe("starting");
    expect(logger.entries.filter((entry) => entry.message === "daemon persistence warning")).toHaveLength(1);
  });
});
