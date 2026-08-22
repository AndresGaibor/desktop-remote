import type { RuntimeEvent } from "../runtime/events";
import { RuntimeSessionStore } from "./runtime-store";
import type {
  RuntimeSessionSnapshot,
  SessionSnapshot,
  StatusFilter,
  ToolCallRow,
} from "./types";

export class SessionStore {
  private readonly runtime: RuntimeSessionStore;
  private query = "";
  private statusFilter: StatusFilter = "all";
  private selectedCallId: string | undefined;

  constructor(maxHistory = 50) {
    this.runtime = new RuntimeSessionStore(maxHistory);
  }

  consume(event: RuntimeEvent): void {
    this.runtime.consume(event);
    this.ensureSelection();
  }

  replaceRuntime(snapshot: RuntimeSessionSnapshot): void {
    this.runtime.restore(snapshot);
    this.ensureSelection();
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
    const runtime = this.runtime.snapshot();
    const filteredRows = this.filterRows(runtime.rows);
    const selectedCall = filteredRows.find((row) => row.callId === this.selectedCallId);
    return {
      ...runtime,
      filteredRows,
      selectedCall,
      query: this.query,
      statusFilter: this.statusFilter,
    };
  }

  private getFilteredRows(): ToolCallRow[] {
    return this.filterRows(this.runtime.snapshot().rows);
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
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }

  private ensureSelection(): void {
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
