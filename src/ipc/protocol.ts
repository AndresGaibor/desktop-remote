import type { DaemonStatus } from "../daemon/daemon";
import type { RuntimeEvent } from "../runtime/events";
import type {
  ConnectionStatus,
  SessionAuth,
  SessionCounts,
  SessionDevice,
  ToolCallRow,
} from "../session/types";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_IPC_FRAME_BYTES = 512 * 1024;

type Versioned = { protocolVersion: typeof PROTOCOL_VERSION };

export type ClientMessage =
  | (Versioned & { type: "hello"; client: "visual" | "admin" })
  | (Versioned & { type: "attach" })
  | (Versioned & { type: "snapshot.request" })
  | (Versioned & { type: "subscribe" })
  | (Versioned & { type: "status.request"; requestId: string })
  | (Versioned & { type: "operation.request"; requestId: string; name: string; input: Record<string, unknown>; traceId?: string; deadlineAt?: number })
  | (Versioned & { type: "ping"; at: number })
  | (Versioned & { type: "detach" })
  | (Versioned & { type: "shutdown" });

export type ServerMessage =
  | (Versioned & { type: "hello.ack"; daemonPid: number })
  | (Versioned & { type: "attached"; attachedSince: number })
  | (Versioned & {
      type: "snapshot.begin";
      connection: ConnectionStatus;
      device?: SessionDevice;
      auth?: SessionAuth;
      counts: SessionCounts;
      callCount: number;
    })
  | (Versioned & { type: "snapshot.call"; row: ToolCallRow })
  | (Versioned & { type: "snapshot.end" })
  | (Versioned & { type: "event"; event: RuntimeEvent })
  | (Versioned & { type: "status"; requestId: string; status: DaemonStatus })
  | (Versioned & { type: "operation.response"; requestId: string; result?: unknown; error?: string; traceId?: string })
  | (Versioned & { type: "pong"; at: number })
  | (Versioned & { type: "already-attached"; attachedSince: number })
  | (Versioned & { type: "error"; code: string; message: string });

export function parseClientMessage(value: unknown): ClientMessage {
  const message = requireVersionedRecord(value);
  switch (message.type) {
    case "hello": {
      const client = message.client;
      if (client !== "visual" && client !== "admin") throw new Error("Invalid hello client mode");
      return message as ClientMessage;
    }
    case "attach":
    case "snapshot.request":
    case "subscribe":
    case "detach":
    case "shutdown":
      return message as ClientMessage;
    case "status.request":
      requireString(message.requestId, "status.request requestId");
      return message as ClientMessage;
    case "operation.request":
      requireString(message.requestId, "operation.request requestId");
      requireString(message.name, "operation.request name");
      requireRecord(message.input, "operation.request input");
      if (message.deadlineAt !== undefined) requireNumber(message.deadlineAt, "operation.request deadlineAt");
      return message as ClientMessage;
    case "ping":
      requireNumber(message.at, "ping at");
      return message as ClientMessage;
    default:
      throw new Error(`Unknown client message type: ${String(message.type)}`);
  }
}

export function parseServerMessage(value: unknown): ServerMessage {
  const message = requireVersionedRecord(value);
  switch (message.type) {
    case "hello.ack":
      requireNumber(message.daemonPid, "hello.ack daemonPid");
      return message as ServerMessage;
    case "attached":
      requireNumber(message.attachedSince, "attached timestamp");
      return message as ServerMessage;
    case "snapshot.begin":
      requireConnection(message.connection);
      requireRecord(message.counts, "snapshot counts");
      requireNumber(message.callCount, "snapshot callCount");
      if (message.device !== undefined) requireRecord(message.device, "snapshot device");
      if (message.auth !== undefined) requireRecord(message.auth, "snapshot auth");
      return message as ServerMessage;
    case "snapshot.call":
      requireRecord(message.row, "snapshot row");
      return message as ServerMessage;
    case "snapshot.end":
      return message as ServerMessage;
    case "event": {
      const event = requireRecord(message.event, "event payload");
      requireString(event.type, "event type");
      return message as ServerMessage;
    }
    case "status":
      requireString(message.requestId, "status requestId");
      requireRecord(message.status, "status payload");
      return message as ServerMessage;
    case "operation.response":
      requireString(message.requestId, "operation.response requestId");
      if (message.error !== undefined) requireString(message.error, "operation.response error");
      return message as ServerMessage;
    case "pong":
      requireNumber(message.at, "pong at");
      return message as ServerMessage;
    case "already-attached":
      requireNumber(message.attachedSince, "already-attached timestamp");
      return message as ServerMessage;
    case "error":
      requireString(message.code, "error code");
      requireString(message.message, "error message");
      return message as ServerMessage;
    default:
      throw new Error(`Unknown server message type: ${String(message.type)}`);
  }
}

export function encodeFrame(message: ClientMessage | ServerMessage): string {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > MAX_IPC_FRAME_BYTES) {
    throw new Error("IPC frame exceeds 512 KiB limit");
  }
  return frame;
}

function requireVersionedRecord(value: unknown): Record<string, unknown> & Versioned {
  const message = requireRecord(value, "IPC message");
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported IPC protocol version: ${String(message.protocolVersion)}; expected ${PROTOCOL_VERSION}`,
    );
  }
  requireString(message.type, "IPC message type");
  return message as Record<string, unknown> & Versioned;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
}

function requireNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
}

function requireConnection(value: unknown): asserts value is ConnectionStatus {
  if (!["starting", "auth", "online", "offline", "error"].includes(String(value))) {
    throw new Error(`Invalid connection status: ${String(value)}`);
  }
}
