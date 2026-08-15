import type { RuntimeEvent } from "../runtime/events";
import type {
  ConnectionStatus,
  SessionAuth,
  SessionDevice,
  SessionSnapshot,
  StatusFilter,
  ToolCallRow,
} from "./types";

export class SessionStore {
  private connection: ConnectionStatus = "starting";
  private device: SessionDevice | undefined;
  private auth: SessionAuth | undefined;
  private readonly calls = new Map<string, ToolCallRow>();
  private readonly order: string[] = [];
  private query = "";
  private statusFilter: StatusFilter = "all";
  private selectedCallId: string | undefined;

  constructor(private readonly maxHistory = 1000) {}

  consume(event: RuntimeEvent): void {
    if (event.type === "device.ready") {
      this.connection = "online";
      this.auth = undefined;
      this.device = {
        user: event.user,
        deviceId: event.deviceId,
        deviceName: event.deviceName,
      };
      return;
    }

    if (event.type === "auth.required") {
      this.connection = "auth";
      this.auth = { url: event.url, code: event.code, expiresIn: event.expiresIn };
      return;
    }
    if (event.type === "runtime.exited") {
      this.connection = "offline";
      return;
    }
    if (event.type === "runtime.error") {
      this.connection = "error";
      return;
    }
    if (event.type === "tool.started") {
      this.upsertStarted(event);
      return;
    }
    if (event.type === "tool.completed") {
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

    if (event.type === "tool.failed") {
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
    }
  }

  setQuery(query: string): void {
    this.query = query;
    this.ensureSelection();
  }

  setStatusFilter(filter: StatusFilter): void {
    this.statusFilter = filter;
    this.ensureSelection();
  }

  selectLastFiltered(): void {
    const rows = this.getFilteredRows();
    this.selectedCallId = rows.at(-1)?.callId;
  }

  selectCall(callId: string): void {
    if (this.getFilteredRows().some((row) => row.callId === callId)) {
      this.selectedCallId = callId;
    }
  }

  moveSelection(delta: number): void {
    const rows = this.getFilteredRows();
    if (rows.length === 0) {
      this.selectedCallId = undefined;
      return;
    }
    const currentIndex = Math.max(
      0,
      rows.findIndex((row) => row.callId === this.selectedCallId),
    );
    const nextIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
    this.selectedCallId = rows[nextIndex]?.callId;
  }

  snapshot(): SessionSnapshot {
    const rows = this.order
      .map((callId) => this.calls.get(callId))
      .filter((row): row is ToolCallRow => row !== undefined);
    const filteredRows = this.filterRows(rows);
    const selectedCall = filteredRows.find((row) => row.callId === this.selectedCallId);
    const counts = {
      total: rows.length,
      running: rows.filter((row) => row.status === "running").length,
      completed: rows.filter((row) => row.status === "completed").length,
      failed: rows.filter((row) => row.status === "failed").length,
    };

    return {
      connection: this.connection,
      device: this.device,
      auth: this.auth,
      rows,
      filteredRows,
      selectedCall,
      counts,
      query: this.query,
      statusFilter: this.statusFilter,
    };
  }

  private upsertStarted(event: Extract<RuntimeEvent, { type: "tool.started" }>) {
    this.setCall(event.callId, {
      callId: event.callId,
      toolName: event.toolName,
      args: event.args,
      metadata: event.metadata,
      status: "running",
      startedAt: event.startedAt,
    });
  }

  private setCall(callId: string, row: ToolCallRow) {
    if (!this.calls.has(callId)) {
      this.order.push(callId);
      if (!this.selectedCallId) this.selectedCallId = callId;
    }
    this.calls.set(callId, row);
    this.prune();
    this.ensureSelection();
  }

  private prune() {
    while (this.order.length > this.maxHistory) {
      const removed = this.order.shift();
      if (removed) this.calls.delete(removed);
      if (removed === this.selectedCallId) this.selectedCallId = undefined;
    }
  }
  private getFilteredRows(): ToolCallRow[] {
    return this.filterRows(
      this.order
        .map((callId) => this.calls.get(callId))
        .filter((row): row is ToolCallRow => row !== undefined),
    );
  }

  private filterRows(rows: ToolCallRow[]): ToolCallRow[] {
    const query = this.query.trim().toLowerCase();
    return rows.filter((row) => {
      if (this.statusFilter !== "all" && row.status !== this.statusFilter) return false;
      if (!query) return true;
      const searchable = [
        row.callId,
        row.toolName,
        safeStringify(row.args),
        row.resultText ?? "",
        row.error ?? "",
      ].join(" ").toLowerCase();
      return searchable.includes(query);
    });
  }

  private ensureSelection() {
    const rows = this.getFilteredRows();
    if (rows.length === 0) {
      this.selectedCallId = undefined;
      return;
    }
    if (!rows.some((row) => row.callId === this.selectedCallId)) {
      this.selectedCallId = rows[0]?.callId;
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
