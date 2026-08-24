import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { lstat, mkdtemp, mkdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonIpcServer, type IpcDaemonSource } from "../../src/daemon/ipc-server";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { MAX_IPC_FRAME_BYTES, PROTOCOL_VERSION, encodeFrame, parseServerMessage, type ServerMessage } from "../../src/ipc/protocol";
import { getDesktopRemotePaths } from "../../src/platform/paths";
import { makeTestPaths } from "../helpers/desktop-remote-paths";
import type { RuntimeEvent } from "../../src/runtime/events";
import type { RuntimeSessionSnapshot } from "../../src/session/types";

const servers: DaemonIpcServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.stop();
});

async function shortSocketPaths() {
  const dir = await mkdtemp(join(tmpdir(), "dr-"));
  return makeTestPaths(dir);
}

function snapshot(callCount = 0): RuntimeSessionSnapshot {
  const rows = Array.from({ length: callCount }, (_, index) => ({
    callId: `call-${index}`,
    toolName: "read_file",
    args: { path: `/tmp/${index}` },
    metadata: {},
    status: "completed" as const,
    startedAt: index,
    completedAt: index + 1,
    resultText: "ok",
  }));
  return {
    connection: "online",
    device: { user: "user@test", deviceId: "d1", deviceName: "mac" },
    rows,
    counts: { total: rows.length, running: 0, completed: rows.length, failed: 0 },
  };
}

function source(initial = snapshot()): IpcDaemonSource & { emit(event: RuntimeEvent): void; stops: number } {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    stops: 0,
    snapshot: () => initial,
    status: () => ({
      state: "online",
      childPid: 77,
      restartCount: 0,
      consecutiveFailures: 0,
      startedAt: 1,
      retainedCalls: initial.rows.length,
    }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async stop() { this.stops += 1; },
    async execute(name, input) { return { name, input }; },
    emit(event) { for (const listener of listeners) listener(event); },
  };
}

async function tempServer(initial = snapshot(), options: { leaseTimeoutMs?: number } = {}) {
  const paths = await shortSocketPaths();
  const daemon = source(initial);
  const server = new DaemonIpcServer({ source: daemon, paths, leaseTimeoutMs: options.leaseTimeoutMs });
  await server.start();
  servers.push(server);
  return { server, daemon, paths };
}
async function connect(path: string): Promise<{ socket: Socket; messages: ServerMessage[]; waitFor(type: ServerMessage["type"]): Promise<ServerMessage> }> {
  const socket = createConnection(path);
  sockets.push(socket);
  const decoder = new JsonLineDecoder();
  const messages: ServerMessage[] = [];
  const waiters = new Map<string, Array<(message: ServerMessage) => void>>();
  socket.on("data", (chunk) => {
    for (const value of decoder.push(chunk)) {
      const message = parseServerMessage(value);
      messages.push(message);
      const queue = waiters.get(message.type);
      const resolve = queue?.shift();
      if (resolve) resolve(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    messages,
    waitFor(type) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const queue = waiters.get(type) ?? [];
        queue.push(resolve);
        waiters.set(type, queue);
      });
    },
  };
}

function send(socket: Socket, message: Parameters<typeof encodeFrame>[0]) {
  socket.write(encodeFrame(message));
}
describe("DaemonIpcServer", () => {
  test("grants one visual lease while admin status remains available", async () => {
    const { paths } = await tempServer();
    expect((await lstat(paths.socketPath)).mode & 0o777).toBe(0o600);
    const first = await connect(paths.socketPath);
    send(first.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    expect((await first.waitFor("hello.ack")).type).toBe("hello.ack");
    send(first.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });

    const second = await connect(paths.socketPath);
    send(second.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await second.waitFor("hello.ack");
    send(second.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    expect((await second.waitFor("already-attached")).type).toBe("already-attached");

    const admin = await connect(paths.socketPath);
    send(admin.socket, { type: "hello", client: "admin", protocolVersion: PROTOCOL_VERSION });
    await admin.waitFor("hello.ack");
    send(admin.socket, { type: "status.request", requestId: "s1", protocolVersion: PROTOCOL_VERSION });
    const status = await admin.waitFor("status");
    expect(status).toMatchObject({ type: "status", requestId: "s1", status: { state: "online", childPid: 77 } });
  });

  test("executes operation requests and returns their result", async () => {
    const { paths } = await tempServer();
    const client = await connect(paths.socketPath);
    send(client.socket, { type: "hello", client: "admin", protocolVersion: PROTOCOL_VERSION });
    await client.waitFor("hello.ack");
    send(client.socket, {
      type: "operation.request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: "op-1",
      name: "read_file",
      input: { path: "/tmp/example" },
    });
    await expect(client.waitFor("operation.response")).resolves.toMatchObject({
      type: "operation.response",
      requestId: "op-1",
      result: { name: "read_file", input: { path: "/tmp/example" } },
    });
  });

  test("streams snapshot as begin, one frame per call, and end", async () => {
    const { paths } = await tempServer(snapshot(50));
    const client = await connect(paths.socketPath);
    send(client.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await client.waitFor("hello.ack");
    send(client.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    send(client.socket, { type: "snapshot.request", protocolVersion: PROTOCOL_VERSION });
    await client.waitFor("snapshot.end");
    const frames = client.messages.filter((message) => message.type.startsWith("snapshot."));
    expect(frames.map((message) => message.type)).toEqual([
      "snapshot.begin", ...Array(50).fill("snapshot.call"), "snapshot.end",
    ]);
    expect(frames.every((message) => Buffer.byteLength(encodeFrame(message)) <= MAX_IPC_FRAME_BYTES)).toBe(true);
  });
  test("EOF releases the visual lease and subscribed events reach only the visual client", async () => {
    const { paths, daemon } = await tempServer();
    const first = await connect(paths.socketPath);
    send(first.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await first.waitFor("hello.ack");
    send(first.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    send(first.socket, { type: "subscribe", protocolVersion: PROTOCOL_VERSION });
    send(first.socket, { type: "ping", at: 2, protocolVersion: PROTOCOL_VERSION });
    await first.waitFor("pong");
    daemon.emit({ type: "runtime.log", source: "stdout", message: "hello", at: 2 });
    expect((await first.waitFor("event")).type).toBe("event");

    first.socket.destroy();
    await Bun.sleep(10);
    const replacement = await connect(paths.socketPath);
    send(replacement.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await replacement.waitFor("hello.ack");
    send(replacement.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    await Bun.sleep(5);
    expect(replacement.messages.some((message) => message.type === "already-attached")).toBe(false);
  });

  test("lease expires after heartbeat timeout and ping receives pong", async () => {
    const { paths } = await tempServer(snapshot(), { leaseTimeoutMs: 25 });
    const first = await connect(paths.socketPath);
    send(first.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await first.waitFor("hello.ack");
    send(first.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    send(first.socket, { type: "ping", at: 10, protocolVersion: PROTOCOL_VERSION });
    expect(await first.waitFor("pong")).toMatchObject({ type: "pong", at: 10 });

    await Bun.sleep(45);
    const replacement = await connect(paths.socketPath);
    send(replacement.socket, { type: "hello", client: "visual", protocolVersion: PROTOCOL_VERSION });
    await replacement.waitFor("hello.ack");
    send(replacement.socket, { type: "attach", protocolVersion: PROTOCOL_VERSION });
    await Bun.sleep(5);
    expect(replacement.messages.some((message) => message.type === "already-attached")).toBe(false);
  });
  test("refuses symlink socket paths", async () => {
    const paths = await shortSocketPaths();
    const { ensureDesktopRemoteDirectories } = await import("../../src/platform/paths");
    await ensureDesktopRemoteDirectories(paths);
    await symlink("/tmp/not-a-socket", paths.socketPath);
    const server = new DaemonIpcServer({ source: source(), paths });
    await expect(server.start()).rejects.toThrow(/symlink/i);
  });

  test("removes an owned stale socket but never unlinks a live socket", async () => {
    const paths = await shortSocketPaths();
    const { ensureDesktopRemoteDirectories } = await import("../../src/platform/paths");
    await ensureDesktopRemoteDirectories(paths);
    const script = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()";
    const stale = Bun.spawnSync(["python3", "-c", script, paths.socketPath]);
    expect(stale.exitCode).toBe(0);
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);

    const recovered = new DaemonIpcServer({ source: source(), paths });
    await recovered.start();
    servers.push(recovered);
    await recovered.stop();
    servers.splice(servers.indexOf(recovered), 1);

    const live = createServer();
    await new Promise<void>((resolve, reject) => {
      live.once("error", reject);
      live.listen(paths.socketPath, resolve);
    });
    const contender = new DaemonIpcServer({ source: source(), paths });
    await expect(contender.start()).rejects.toThrow(/already running|live socket/i);
    expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });
});
