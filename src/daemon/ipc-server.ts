import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { RuntimeEvent } from "../runtime/events";
import type { RuntimeSessionSnapshot } from "../session/types";
import { JsonLineDecoder } from "../ipc/framing";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../ipc/protocol";
import {
  ensureDesktopRemoteDirectories,
  getDesktopRemotePaths,
  type DesktopRemotePaths,
} from "../platform/paths";
import type { DaemonStatus } from "./daemon";
import type { OperationExecutionOptions } from "../mcp/handler";

type OperationRequest = Extract<ClientMessage, { type: "operation.request" }>;
const MAX_OPERATION_ERROR_BYTES = 4_096;

export interface IpcDaemonSource {
  snapshot(): RuntimeSessionSnapshot;
  status(): DaemonStatus;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  stop(): Promise<void>;
  execute(name: string, input: Record<string, unknown>, options?: OperationExecutionOptions): Promise<unknown>;
}

export interface DaemonIpcServerOptions {
  source: IpcDaemonSource;
  paths?: DesktopRemotePaths;
  now?: () => number;
  daemonPid?: number;
  leaseTimeoutMs?: number;
}
interface ClientState {
  decoder: JsonLineDecoder;
  mode?: "visual" | "admin";
  subscribed: boolean;
}

interface VisualLease {
  socket: Socket;
  attachedSince: number;
  lastHeartbeatAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class DaemonIpcServer {
  private readonly source: IpcDaemonSource;
  private readonly paths: DesktopRemotePaths;
  private readonly now: () => number;
  private readonly daemonPid: number;
  private readonly leaseTimeoutMs: number;
  private readonly clients = new Map<Socket, ClientState>();
  private server: Server | undefined;
  private visualLease: VisualLease | undefined;
  private unsubscribeSource: (() => void) | undefined;
  private ownsSocketPath = false;

  constructor(options: DaemonIpcServerOptions) {
    this.source = options.source;
    this.paths = options.paths ?? getDesktopRemotePaths();
    this.now = options.now ?? Date.now;
    this.daemonPid = options.daemonPid ?? process.pid;
    this.leaseTimeoutMs = options.leaseTimeoutMs ?? 90_000;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await ensureDesktopRemoteDirectories(this.paths);
    await this.prepareSocketPath();

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await listen(server, this.paths.socketPath);
      this.ownsSocketPath = true;
      await chmod(this.paths.socketPath, 0o600);
      this.unsubscribeSource = this.source.onEvent((event) => this.forwardEvent(event));
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.unsubscribeSource?.();
    this.unsubscribeSource = undefined;
    this.releaseVisualLease();
    for (const socket of this.clients.keys()) socket.destroy();
    this.clients.clear();

    const server = this.server;
    this.server = undefined;
    if (server) await closeServer(server);
    if (this.ownsSocketPath) {
      await unlinkIfPresent(this.paths.socketPath);
      this.ownsSocketPath = false;
    }
  }

  private accept(socket: Socket): void {
    const state: ClientState = { decoder: new JsonLineDecoder(), subscribed: false };
    this.clients.set(socket, state);
    socket.on("data", (chunk) => {
      try {
        for (const value of state.decoder.push(chunk)) {
          const message = parseClientMessage(value);
          void this.handleMessage(socket, state, message);
        }
      } catch (error) {
        this.sendError(socket, "invalid-frame", error);
        socket.destroy();
      }
    });
    socket.on("error", () => {
      // Close handling below owns cleanup; socket errors must not crash the daemon.
    });
    socket.on("close", () => {
      if (this.visualLease?.socket === socket) this.releaseVisualLease();
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: Socket, state: ClientState, message: ClientMessage) {
    switch (message.type) {
      case "hello":
        state.mode = message.client;
        this.send(socket, { type: "hello.ack", protocolVersion: PROTOCOL_VERSION, daemonPid: this.daemonPid });
        return;
      case "attach":
        this.attachVisual(socket, state);
        return;
      case "snapshot.request":
        this.sendSnapshot(socket);
        return;
      case "subscribe":
        if (this.requireVisualLease(socket)) state.subscribed = true;
        return;
      case "status.request":
        this.send(socket, {
          type: "status",
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          status: this.source.status(),
        });
        return;
      case "operation.request":
        await this.handleOperation(socket, message);
        return;
      case "ping":
        if (this.visualLease?.socket === socket) {
          this.visualLease.lastHeartbeatAt = this.now();
          this.scheduleLeaseExpiry();
        }
        this.send(socket, { type: "pong", protocolVersion: PROTOCOL_VERSION, at: message.at });
        return;
      case "detach":
        if (this.visualLease?.socket === socket) this.releaseVisualLease();
        state.subscribed = false;
        return;
      case "shutdown":
        await this.source.stop();
        return;
    }
  }

  private async handleOperation(socket: Socket, message: OperationRequest): Promise<void> {
    const controller = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let onSocketClose: (() => void) | undefined;

    const deadlinePromise = message.deadlineAt === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
        const abortAtDeadline = () => {
          controller.abort();
          reject(new Error("Desktop Remote operation deadline exceeded"));
        };
        const remainingMs = message.deadlineAt! - this.now();
        if (remainingMs <= 0) {
          abortAtDeadline();
          return;
        }
        deadlineTimer = setTimeout(abortAtDeadline, remainingMs);
        deadlineTimer.unref?.();
      });

    const socketClosedPromise = new Promise<never>((_, reject) => {
      onSocketClose = () => {
        controller.abort();
        reject(new Error("Desktop Remote operation IPC connection closed"));
      };
      socket.once("close", onSocketClose);
      if (socket.destroyed) onSocketClose();
    });

    const executePromise = Promise.resolve().then(() => this.source.execute(message.name, message.input, {
      signal: controller.signal,
      ...(message.traceId !== undefined ? { traceId: message.traceId } : {}),
      ...(message.deadlineAt !== undefined ? { deadlineAt: message.deadlineAt } : {}),
    }));

    try {
      const pending = [executePromise, socketClosedPromise];
      if (deadlinePromise) pending.push(deadlinePromise);
      const result = await Promise.race(pending);
      this.send(socket, {
        type: "operation.response",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        result,
        ...(message.traceId !== undefined ? { traceId: message.traceId } : {}),
      });
    } catch (error) {
      if (!socket.destroyed) {
        this.send(socket, {
          type: "operation.response",
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          error: boundedOperationError(error),
          ...(message.traceId !== undefined ? { traceId: message.traceId } : {}),
        });
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (onSocketClose !== undefined) socket.off("close", onSocketClose);
    }
  }

  private attachVisual(socket: Socket, state: ClientState): void {
    if (state.mode !== "visual") {
      this.sendError(socket, "visual-required", new Error("Visual attach requires visual hello"));
      return;
    }
    if (this.visualLease && this.visualLease.socket !== socket) {
      this.send(socket, {
        type: "already-attached",
        protocolVersion: PROTOCOL_VERSION,
        attachedSince: this.visualLease.attachedSince,
      });
      return;
    }
    if (!this.visualLease) {
      const now = this.now();
      this.visualLease = { socket, attachedSince: now, lastHeartbeatAt: now };
      this.scheduleLeaseExpiry();
    }
    this.send(socket, {
      type: "attached",
      protocolVersion: PROTOCOL_VERSION,
      attachedSince: this.visualLease.attachedSince,
    });
  }

  private requireVisualLease(socket: Socket): boolean {
    if (this.visualLease?.socket === socket) return true;
    this.sendError(socket, "not-attached", new Error("Visual client is not attached"));
    return false;
  }
  private sendSnapshot(socket: Socket): void {
    if (!this.requireVisualLease(socket)) return;
    const snapshot = this.source.snapshot();
    this.send(socket, {
      type: "snapshot.begin",
      protocolVersion: PROTOCOL_VERSION,
      connection: snapshot.connection,
      device: snapshot.device,
      auth: snapshot.auth,
      counts: snapshot.counts,
      callCount: snapshot.rows.length,
    });
    for (const row of snapshot.rows) {
      this.send(socket, { type: "snapshot.call", protocolVersion: PROTOCOL_VERSION, row });
    }
    this.send(socket, { type: "snapshot.end", protocolVersion: PROTOCOL_VERSION });
  }

  private forwardEvent(event: RuntimeEvent): void {
    const lease = this.visualLease;
    if (!lease) return;
    const state = this.clients.get(lease.socket);
    if (!state?.subscribed || lease.socket.destroyed) return;
    this.send(lease.socket, { type: "event", protocolVersion: PROTOCOL_VERSION, event });
  }

  private scheduleLeaseExpiry(): void {
    const lease = this.visualLease;
    if (!lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    const elapsed = Math.max(0, this.now() - lease.lastHeartbeatAt);
    const remaining = Math.max(1, this.leaseTimeoutMs - elapsed);
    lease.timer = setTimeout(() => {
      if (this.visualLease !== lease) return;
      if (this.now() - lease.lastHeartbeatAt >= this.leaseTimeoutMs) {
        lease.socket.destroy();
        this.releaseVisualLease();
      } else {
        this.scheduleLeaseExpiry();
      }
    }, remaining);
    lease.timer.unref?.();
  }

  private releaseVisualLease(): void {
    const lease = this.visualLease;
    if (!lease) return;
    if (lease.timer) clearTimeout(lease.timer);
    const state = this.clients.get(lease.socket);
    if (state) state.subscribed = false;
    this.visualLease = undefined;
  }
  private send(socket: Socket, message: ServerMessage): void {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(encodeFrame(message));
    } catch (error) {
      this.sendError(socket, "frame-too-large", error);
    }
  }

  private sendError(socket: Socket, code: string, error: unknown): void {
    if (socket.destroyed || !socket.writable) return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      socket.write(encodeFrame({
        type: "error",
        protocolVersion: PROTOCOL_VERSION,
        code,
        message: message.slice(0, 4096),
      }));
    } catch {
      socket.destroy();
    }
  }

  private async prepareSocketPath(): Promise<void> {
    let info;
    try {
      info = await lstat(this.paths.socketPath);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("Refusing symlink at daemon socket path");
    if (!info.isSocket()) throw new Error("Refusing non-socket file at daemon socket path");
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw new Error("Daemon socket is not owned by current user");
    if (await socketIsLive(this.paths.socketPath)) {
      throw new Error("Desktop Remote daemon already running on live socket");
    }
    await unlink(this.paths.socketPath);
  }
}

function boundedOperationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (Buffer.byteLength(message) <= MAX_OPERATION_ERROR_BYTES) return message;
  let end = Math.min(message.length, MAX_OPERATION_ERROR_BYTES);
  while (end > 0 && Buffer.byteLength(message.slice(0, end)) > MAX_OPERATION_ERROR_BYTES) end -= 1;
  return message.slice(0, end);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else if (!settled) { settled = true; reject(error); }
    });
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
