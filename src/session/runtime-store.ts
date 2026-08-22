import type { RuntimeEvent } from "../runtime/events";
import {
  ARGUMENT_MAX_BYTES,
  CONTROL_TEXT_MAX_BYTES,
  ERROR_MAX_BYTES,
  METADATA_MAX_BYTES,
  RESULT_MAX_BYTES,
  SESSION_HISTORY_LIMIT,
  boundRuntimeEvent,
  boundText,
  boundUnknown,
} from "./bounds";
import type {
  ConnectionStatus,
  RuntimeSessionSnapshot,
  SessionAuth,
  SessionDevice,
  ToolCallRow,
} from "./types";

export class RuntimeSessionStore {
  private connection: ConnectionStatus = "starting";
  private device: SessionDevice | undefined;
  private auth: SessionAuth | undefined;
  private readonly calls = new Map<string, ToolCallRow>();
  private readonly order: string[] = [];

  constructor(private readonly maxHistory = SESSION_HISTORY_LIMIT) {}

  consume(rawEvent: RuntimeEvent): void {
    const event = boundRuntimeEvent(rawEvent);
    switch (event.type) {
      case "device.ready":
        this.connection = "online";
        this.auth = undefined;
        this.device = {
          user: event.user,
          deviceId: event.deviceId,
          deviceName: event.deviceName,
        };
        return;
      case "auth.required":
        this.connection = "auth";
        this.auth = { url: event.url, code: event.code, expiresIn: event.expiresIn };
        return;
      case "runtime.exited":
        this.connection = "offline";
        return;
      case "runtime.error":
        this.connection = "error";
        return;
      case "tool.started":
        this.setCall(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          args: event.args,
          metadata: event.metadata,
          status: "running",
          startedAt: event.startedAt,
        });
        return;
      case "tool.completed": {
        const current = this.calls.get(event.callId);
        this.setCall(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          args: current?.args ?? {},
          metadata: current?.metadata ?? {},
          status: "completed",
          startedAt: current?.startedAt ?? event.completedAt - (event.durationMs ?? 0),
          completedAt: event.completedAt,
          durationMs: event.durationMs,
          resultText: event.resultText,
        });
        return;
      }
      case "tool.failed": {
        const current = this.calls.get(event.callId);
        this.setCall(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          args: current?.args ?? {},
          metadata: current?.metadata ?? {},
          status: "failed",
          startedAt: current?.startedAt ?? event.completedAt - (event.durationMs ?? 0),
          completedAt: event.completedAt,
          durationMs: event.durationMs,
          error: event.error,
        });
        return;
      }
      default:
        return;
    }
  }

  restore(snapshot: RuntimeSessionSnapshot): void {
    this.connection = snapshot.connection;
    this.device = snapshot.device ? { ...snapshot.device } : undefined;
    this.auth = snapshot.auth ? { ...snapshot.auth } : undefined;
    this.calls.clear();
    this.order.length = 0;
    for (const row of snapshot.rows.slice(-this.maxHistory)) {
      this.setCall(row.callId, boundRow(row));
    }
  }

  snapshot(): RuntimeSessionSnapshot {
    const rows = this.order
      .map((callId) => this.calls.get(callId))
      .filter((row): row is ToolCallRow => row !== undefined)
      .map((row) => ({ ...row }));
    return {
      connection: this.connection,
      device: this.device ? { ...this.device } : undefined,
      auth: this.auth ? { ...this.auth } : undefined,
      rows,
      counts: {
        total: rows.length,
        running: rows.filter((row) => row.status === "running").length,
        completed: rows.filter((row) => row.status === "completed").length,
        failed: rows.filter((row) => row.status === "failed").length,
      },
    };
  }

  private setCall(callId: string, row: ToolCallRow): void {
    if (!this.calls.has(callId)) this.order.push(callId);
    this.calls.set(callId, row);
    while (this.order.length > this.maxHistory) {
      const removed = this.order.shift();
      if (removed) this.calls.delete(removed);
    }
  }
}

function boundRow(row: ToolCallRow): ToolCallRow {
  return {
    ...row,
    callId: boundText(row.callId, CONTROL_TEXT_MAX_BYTES),
    toolName: boundText(row.toolName, CONTROL_TEXT_MAX_BYTES),
    args: boundUnknown(row.args, ARGUMENT_MAX_BYTES),
    metadata: boundUnknown(row.metadata, METADATA_MAX_BYTES),
    resultText:
      row.resultText === undefined ? undefined : boundText(row.resultText, RESULT_MAX_BYTES),
    error: row.error === undefined ? undefined : boundText(row.error, ERROR_MAX_BYTES),
  };
}
