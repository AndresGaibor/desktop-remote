import { describe, expect, test } from "bun:test";
import type { DesktopRemoteIpcClient } from "../../src/client/ipc-client";
import { IpcTuiSessionSource, TUI_RECONNECT_DELAYS_MS, type SessionIpcClient } from "../../src/client/session-source";
import type { RuntimeEvent } from "../../src/runtime/events";
import { SessionStore } from "../../src/session/store";
import type { RuntimeSessionSnapshot } from "../../src/session/types";

function runtimeSnapshot(callId = "c1", resultText = "old"): RuntimeSessionSnapshot {
  return {
    connection: "online",
    rows: [{
      callId,
      toolName: "read_file",
      args: { path: `/${callId}` },
      metadata: {},
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      resultText,
    }],
    counts: { total: 1, running: 0, completed: 1, failed: 0 },
  };
}

class FakeClient implements SessionIpcClient {
  events = new Set<(event: RuntimeEvent) => void>();
  disconnects = new Set<() => void>();
  connectError: Error | undefined;
  closes = 0;
  connects = 0;
  actions: string[] = [];
  constructor(public snapshot = runtimeSnapshot()) {}
  async connect(_mode: "visual" | "admin") {
    this.actions.push("connect");
    this.connects += 1;
    if (this.connectError) throw this.connectError;
  }
  async requestSnapshot() { this.actions.push("snapshot"); return this.snapshot; }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.actions.push("subscribe");
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onDisconnect(listener: () => void) {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }
  async close() { this.closes += 1; }
  emit(event: RuntimeEvent) { for (const listener of this.events) listener(event); }
  loseConnection() { for (const listener of [...this.disconnects]) listener(); }
}

function createSource(options: {
  store?: SessionStore;
  clients: FakeClient[];
  sleep?: (ms: number) => Promise<void>;
}) {
  const store = options.store ?? new SessionStore();
  let index = 0;
  const source = new IpcTuiSessionSource({
    store,
    createClient: () => options.clients[Math.min(index++, options.clients.length - 1)]!,
    sleep: options.sleep ?? (async () => {}),
  });
  return { source, store, created: () => index };
}

describe("IpcTuiSessionSource", () => {
  test("applies initial snapshot and incremental events without replacing local filters", async () => {
    const store = new SessionStore();
    store.setQuery("read_file");
    store.setStatusFilter("completed");
    const client = new FakeClient(runtimeSnapshot());
    const { source } = createSource({ store, clients: [client] });
    let changes = 0;
    await source.start(() => { changes += 1; });

    expect(source.connectionState()).toBe("connected");
    expect(client.actions.slice(0, 3)).toEqual(["connect", "subscribe", "snapshot"]);
    expect(store.snapshot()).toMatchObject({ query: "read_file", statusFilter: "completed" });
    expect(store.snapshot().rows[0]?.resultText).toBe("old");

    client.emit({ type: "tool.completed", callId: "c1", toolName: "read_file", resultText: "new", completedAt: 3 });
    expect(store.snapshot().rows[0]?.resultText).toBe("new");
    expect(changes).toBeGreaterThan(0);
    await source.stop();
  });
  test("reconnects with the approved bounded delay sequence and refreshes from a new snapshot", async () => {
    expect(TUI_RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
    const initial = new FakeClient(runtimeSnapshot("old-call", "old"));
    const failures = Array.from({ length: 5 }, () => {
      const client = new FakeClient();
      client.connectError = new Error("daemon restarting");
      return client;
    });
    const recovered = new FakeClient(runtimeSnapshot("new-call", "fresh"));
    const delays: number[] = [];
    const { source, store } = createSource({
      clients: [initial, ...failures, recovered],
      sleep: async (ms) => { delays.push(ms); },
    });
    await source.start(() => {});
    initial.loseConnection();

    for (let i = 0; i < 20 && source.connectionState() !== "connected"; i += 1) await Bun.sleep(0);
    expect(delays).toEqual([...TUI_RECONNECT_DELAYS_MS]);
    expect(source.connectionState()).toBe("connected");
    expect(store.snapshot().rows.map((row) => row.callId)).toEqual(["new-call"]);

    initial.emit({ type: "tool.completed", callId: "old-call", toolName: "read_file", resultText: "stale", completedAt: 9 });
    expect(store.snapshot().rows.map((row) => row.callId)).toEqual(["new-call"]);
    await source.stop();
  });

  test("stop invalidates a pending reconnect sleep", async () => {
    const initial = new FakeClient();
    const failing = new FakeClient();
    failing.connectError = new Error("down");
    const extra = new FakeClient();
    let release!: () => void;
    const sleeping = new Promise<void>((resolve) => { release = resolve; });
    const delays: number[] = [];
    const { source, created } = createSource({
      clients: [initial, failing, extra],
      sleep: async (ms) => { delays.push(ms); await sleeping; },
    });
    await source.start(() => {});
    initial.loseConnection();
    for (let i = 0; i < 10 && delays.length === 0; i += 1) await Bun.sleep(0);
    expect(delays).toEqual([1_000]);
    const attemptsBeforeStop = created();
    await source.stop();
    release();
    await Bun.sleep(0);
    expect(created()).toBe(attemptsBeforeStop);
    expect(source.connectionState()).toBe("stopped");
  });
});


test("default reconnect wait is cancelled promptly by stop", async () => {
  const failing = new FakeClient();
  failing.connectError = new Error("daemon unavailable");
  const source = new IpcTuiSessionSource({
    store: new SessionStore(),
    createClient: () => failing,
  });

  const starting = source.start(() => {});
  for (let i = 0; i < 20 && source.connectionState() !== "reconnecting"; i += 1) {
    await Bun.sleep(0);
  }
  expect(source.connectionState()).toBe("reconnecting");
  await source.stop();
  const stoppedPromptly = await Promise.race([
    starting.then(() => true),
    Bun.sleep(250).then(() => false),
  ]);
  expect(stoppedPromptly).toBe(true);
});
