import { createConnection, type Socket } from "node:net";
import type { DaemonStatus } from "../daemon/daemon";
import { JsonLineDecoder } from "../ipc/framing";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../ipc/protocol";
import { getDesktopRemotePaths } from "../platform/paths";
import type { RuntimeEvent } from "../runtime/events";
import { SESSION_HISTORY_LIMIT } from "../session/bounds";
import type { RuntimeSessionSnapshot, ToolCallRow } from "../session/types";

export class AlreadyAttachedError extends Error {
  constructor(readonly attachedSince: number) {
    super("Desktop Remote already has an active visual session");
    this.name = "AlreadyAttachedError";
  }
}

export interface HeartbeatScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface DesktopRemoteIpcClientOptions {
  socketPath?: string;
  requestTimeoutMs?: number;
  now?: () => number;
  heartbeatScheduler?: HeartbeatScheduler;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface SnapshotBuffer {
  connection: RuntimeSessionSnapshot["connection"];
  device: RuntimeSessionSnapshot["device"];
  auth: RuntimeSessionSnapshot["auth"];
  counts: RuntimeSessionSnapshot["counts"];
  expectedCalls: number;
  rows: ToolCallRow[];
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class DesktopRemoteIpcClient {
  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly heartbeatScheduler: HeartbeatScheduler;
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly pendingStatus = new Map<string, Deferred<DaemonStatus>>();
  private socket: Socket | undefined;
  private decoder = new JsonLineDecoder();
  private mode: "visual" | "admin" | undefined;
  private helloDeferred: Deferred<void> | undefined;
  private attachDeferred: Deferred<void> | undefined;
  private snapshotDeferred: Deferred<RuntimeSessionSnapshot> | undefined;
  private snapshotBuffer: SnapshotBuffer | undefined;
  private heartbeatHandle: unknown;
  private requestCounter = 0;
  private subscribed = false;
  private intentionalClose = false;

  constructor(options: DesktopRemoteIpcClientOptions = {}) {
    this.socketPath = options.socketPath ?? getDesktopRemotePaths().socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.heartbeatScheduler = options.heartbeatScheduler ?? DEFAULT_HEARTBEAT_SCHEDULER;
  }
  async connect(mode: "visual" | "admin"): Promise<void> {
    if (this.socket && !this.socket.destroyed) throw new Error("Desktop Remote IPC client already connected");
    this.mode = mode;
    this.intentionalClose = false;
    this.decoder = new JsonLineDecoder();
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.bindSocket(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      this.helloDeferred = deferred<void>();
      this.send({ type: "hello", client: mode, protocolVersion: PROTOCOL_VERSION });
      await withTimeout(this.helloDeferred.promise, this.requestTimeoutMs, "IPC hello timed out");
      this.helloDeferred = undefined;

      if (mode === "visual") {
        this.attachDeferred = deferred<void>();
        this.send({ type: "attach", protocolVersion: PROTOCOL_VERSION });
        await withTimeout(this.attachDeferred.promise, this.requestTimeoutMs, "IPC visual attach timed out");
        this.attachDeferred = undefined;
        if (this.eventListeners.size > 0) this.ensureSubscribed();
        this.scheduleHeartbeat();
      }
    } catch (error) {
      this.intentionalClose = true;
      socket.destroy();
      this.socket = undefined;
      this.cancelHeartbeat();
      throw error;
    }
  }

  async requestStatus(): Promise<DaemonStatus> {
    this.assertConnected();
    const requestId = `status-${++this.requestCounter}`;
    const pending = deferred<DaemonStatus>();
    this.pendingStatus.set(requestId, pending);
    this.send({ type: "status.request", requestId, protocolVersion: PROTOCOL_VERSION });
    try {
      return await withTimeout(pending.promise, this.requestTimeoutMs, "IPC status request timed out");
    } finally {
      this.pendingStatus.delete(requestId);
    }
  }

  async requestSnapshot(): Promise<RuntimeSessionSnapshot> {
    this.assertConnected();
    if (this.mode !== "visual") throw new Error("Snapshot requires a visual IPC client");
    if (this.snapshotDeferred) throw new Error("Snapshot request already in progress");
    this.snapshotDeferred = deferred<RuntimeSessionSnapshot>();
    this.snapshotBuffer = undefined;
    this.send({ type: "snapshot.request", protocolVersion: PROTOCOL_VERSION });
    try {
      return await withTimeout(this.snapshotDeferred.promise, this.requestTimeoutMs, "IPC snapshot timed out");
    } finally {
      this.snapshotDeferred = undefined;
      this.snapshotBuffer = undefined;
    }
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    if (this.mode === "visual" && this.socket && !this.socket.destroyed) this.ensureSubscribed();
    return () => this.eventListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.cancelHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      if (this.mode === "visual") {
        try { socket.write(encodeFrame({ type: "detach", protocolVersion: PROTOCOL_VERSION })); } catch {}
      }
      socket.end();
      socket.destroy();
    }
    this.rejectPending(new Error("Desktop Remote IPC client closed"));
    this.mode = undefined;
    this.subscribed = false;
  }

  private bindSocket(socket: Socket): void {
    socket.on("data", (chunk) => {
      try {
        for (const value of this.decoder.push(chunk)) this.handleMessage(parseServerMessage(value));
      } catch (error) {
        this.rejectPending(error);
        socket.destroy();
      }
    });
    socket.on("error", () => {
      // The close event performs state cleanup and reconnect notification.
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.cancelHeartbeat();
      this.rejectPending(new Error("Desktop Remote IPC connection closed"));
      const intentional = this.intentionalClose;
      this.mode = undefined;
      this.subscribed = false;
      if (!intentional) {
        for (const listener of [...this.disconnectListeners]) {
          try { listener(); } catch {}
        }
      }
    });
  }
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello.ack":
        this.helloDeferred?.resolve();
        return;
      case "attached":
        this.attachDeferred?.resolve();
        return;
      case "already-attached":
        this.attachDeferred?.reject(new AlreadyAttachedError(message.attachedSince));
        return;
      case "status":
        this.pendingStatus.get(message.requestId)?.resolve(message.status);
        return;
      case "snapshot.begin":
        if (message.callCount > SESSION_HISTORY_LIMIT) {
          this.snapshotDeferred?.reject(new Error(`IPC snapshot exceeds ${SESSION_HISTORY_LIMIT} call limit`));
          return;
        }
        this.snapshotBuffer = {
          connection: message.connection,
          device: message.device,
          auth: message.auth,
          counts: message.counts,
          expectedCalls: message.callCount,
          rows: [],
        };
        return;
      case "snapshot.call":
        if (!this.snapshotBuffer) return;
        if (this.snapshotBuffer.rows.length >= SESSION_HISTORY_LIMIT) {
          this.snapshotDeferred?.reject(new Error(`IPC snapshot exceeds ${SESSION_HISTORY_LIMIT} call limit`));
          return;
        }
        this.snapshotBuffer.rows.push(message.row);
        return;
      case "snapshot.end":
        this.finishSnapshot();
        return;
      case "event":
        for (const listener of [...this.eventListeners]) {
          try { listener(message.event); } catch {}
        }
        return;
      case "error": {
        const error = new Error(`IPC ${message.code}: ${message.message}`);
        this.attachDeferred?.reject(error);
        this.snapshotDeferred?.reject(error);
        return;
      }
      case "pong":
        return;
    }
  }

  private finishSnapshot(): void {
    const buffer = this.snapshotBuffer;
    if (!buffer || !this.snapshotDeferred) return;
    if (buffer.rows.length !== buffer.expectedCalls) {
      this.snapshotDeferred.reject(new Error(
        `IPC snapshot call count mismatch: expected ${buffer.expectedCalls}, got ${buffer.rows.length}`,
      ));
      return;
    }
    this.snapshotDeferred.resolve({
      connection: buffer.connection,
      device: buffer.device,
      auth: buffer.auth,
      rows: buffer.rows,
      counts: buffer.counts,
    });
  }
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.assertConnected();
    this.subscribed = true;
    this.send({ type: "subscribe", protocolVersion: PROTOCOL_VERSION });
  }

  private scheduleHeartbeat(): void {
    this.cancelHeartbeat();
    if (this.mode !== "visual" || !this.socket || this.socket.destroyed) return;
    this.heartbeatHandle = this.heartbeatScheduler.set(() => {
      this.heartbeatHandle = undefined;
      if (this.mode !== "visual" || !this.socket || this.socket.destroyed) return;
      this.send({ type: "ping", at: this.now(), protocolVersion: PROTOCOL_VERSION });
      this.scheduleHeartbeat();
    }, DEFAULT_HEARTBEAT_MS);
  }

  private cancelHeartbeat(): void {
    if (this.heartbeatHandle === undefined) return;
    this.heartbeatScheduler.clear(this.heartbeatHandle);
    this.heartbeatHandle = undefined;
  }

  private send(message: ClientMessage): void {
    this.assertConnected();
    this.socket!.write(encodeFrame(message));
  }

  private assertConnected(): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error("Desktop Remote IPC client is not connected");
    }
  }

  private rejectPending(error: unknown): void {
    this.helloDeferred?.reject(error);
    this.helloDeferred = undefined;
    this.attachDeferred?.reject(error);
    this.attachDeferred = undefined;
    this.snapshotDeferred?.reject(error);
    this.snapshotDeferred = undefined;
    this.snapshotBuffer = undefined;
    for (const pending of this.pendingStatus.values()) pending.reject(error);
    this.pendingStatus.clear();
  }
}
const DEFAULT_HEARTBEAT_SCHEDULER: HeartbeatScheduler = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
