import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyAttachedError, DesktopRemoteIpcClient } from "../../src/client/ipc-client";
import { DaemonIpcServer, type IpcDaemonSource } from "../../src/daemon/ipc-server";
import { makeTestPaths } from "../helpers/desktop-remote-paths";
import type { RuntimeEvent } from "../../src/runtime/events";
import type { RuntimeSessionSnapshot } from "../../src/session/types";

const servers: DaemonIpcServer[] = [];
const clients: DesktopRemoteIpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function shortSocketPaths() {
  const dir = await mkdtemp(join(tmpdir(), "dr-"));
  return makeTestPaths(dir);
}

function makeSnapshot(): RuntimeSessionSnapshot {
  return {
    connection: "online",
    device: { user: "user@test", deviceId: "d1", deviceName: "mac" },
    rows: [{
      callId: "c1", toolName: "read_file", args: { path: "/tmp/a" }, metadata: {},
      status: "completed", startedAt: 1, completedAt: 2, resultText: "ok",
    }],
    counts: { total: 1, running: 0, completed: 1, failed: 0 },
  };
}
function makeSource(snapshot = makeSnapshot()): IpcDaemonSource & { emit(event: RuntimeEvent): void } {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    snapshot: () => snapshot,
    status: () => ({
      state: "online",
      childPid: 77,
      restartCount: 2,
      consecutiveFailures: 0,
      startedAt: 1,
      retainedCalls: snapshot.rows.length,
    }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async stop() {},
    emit(event) { for (const listener of listeners) listener(event); },
  };
}

async function setupServer() {
  const paths = await shortSocketPaths();
  const source = makeSource();
  const server = new DaemonIpcServer({ source, paths });
  await server.start();
  servers.push(server);
  return { paths, source, server };
}

function createClient(socketPath: string, options: ConstructorParameters<typeof DesktopRemoteIpcClient>[0] = {}) {
  const client = new DesktopRemoteIpcClient({ socketPath, ...options });
  clients.push(client);
  return client;
}
describe("DesktopRemoteIpcClient", () => {
  test("connects visually, requests status/snapshot, and receives events", async () => {
    const { paths, source } = await setupServer();
    const client = createClient(paths.socketPath);
    await client.connect("visual");

    expect(await client.requestStatus()).toMatchObject({ state: "online", childPid: 77, restartCount: 2 });
    expect(await client.requestSnapshot()).toEqual(makeSnapshot());

    const events: RuntimeEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.requestStatus(); // same-socket barrier: subscribe has reached the daemon
    source.emit({ type: "runtime.log", source: "stdout", message: "hello", at: 5 });
    await Bun.sleep(5);
    expect(events).toEqual([{ type: "runtime.log", source: "stdout", message: "hello", at: 5 }]);
  });

  test("a second visual client receives AlreadyAttachedError", async () => {
    const { paths } = await setupServer();
    const first = createClient(paths.socketPath);
    await first.connect("visual");
    const second = createClient(paths.socketPath);
    await expect(second.connect("visual")).rejects.toBeInstanceOf(AlreadyAttachedError);
  });

  test("admin client can request status without consuming the visual lease", async () => {
    const { paths } = await setupServer();
    const admin = createClient(paths.socketPath);
    await admin.connect("admin");
    expect(await admin.requestStatus()).toMatchObject({ state: "online", childPid: 77 });
    const visual = createClient(paths.socketPath);
    await visual.connect("visual");
  });
  test("schedules one 30-second visual heartbeat and cancels it on close", async () => {
    const { paths } = await setupServer();
    const callbacks = new Map<number, () => void>();
    const delays: number[] = [];
    const cleared: number[] = [];
    let nextId = 0;
    const client = createClient(paths.socketPath, {
      heartbeatScheduler: {
        set(callback, delayMs) {
          const id = ++nextId;
          callbacks.set(id, callback);
          delays.push(delayMs);
          return id;
        },
        clear(handle) {
          cleared.push(handle as number);
          callbacks.delete(handle as number);
        },
      },
    });
    await client.connect("visual");
    expect(delays).toEqual([30_000]);
    callbacks.get(1)?.();
    await Bun.sleep(5);
    expect(delays).toEqual([30_000, 30_000]);
    await client.close();
    expect(cleared).toContain(2);
  });

  test("notifies connection loss and rejects pending work when the daemon disappears", async () => {
    const { paths, server } = await setupServer();
    const client = createClient(paths.socketPath);
    await client.connect("visual");
    let losses = 0;
    client.onDisconnect(() => { losses += 1; });
    await server.stop();
    await Bun.sleep(10);
    expect(losses).toBe(1);
    await expect(client.requestStatus()).rejects.toThrow(/not connected/i);
  });
});


test("visual connect is idempotent for a preflight-attached client", async () => {
  const { paths } = await setupServer();
  const client = createClient(paths.socketPath);
  await client.connect("visual");
  await client.connect("visual");
  const snapshot = await client.requestSnapshot();
  expect(snapshot.rows).toHaveLength(1);
  await client.close();
});
