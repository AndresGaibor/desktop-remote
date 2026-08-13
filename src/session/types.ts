export type ConnectionStatus = "starting" | "auth" | "online" | "offline" | "error";
export type ToolStatus = "running" | "completed" | "failed";
export type StatusFilter = "all" | ToolStatus;

export interface SessionDevice {
  user: string;
  deviceId: string;
  deviceName: string;
}

export interface ToolCallRow {
  callId: string;
  toolName: string;
  args: unknown;
  metadata: unknown;
  status: ToolStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  resultText?: string;
  error?: string;
}

export interface SessionCounts {
  total: number;
  running: number;
  completed: number;
  failed: number;
}

export interface SessionSnapshot {
  connection: ConnectionStatus;
  device?: SessionDevice;
  rows: ToolCallRow[];
  filteredRows: ToolCallRow[];
  selectedCall?: ToolCallRow;
  counts: SessionCounts;
  query: string;
  statusFilter: StatusFilter;
}
