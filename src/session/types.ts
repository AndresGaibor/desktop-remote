export type ConnectionStatus = "starting" | "auth" | "online" | "offline" | "error";
export type ToolStatus = "running" | "completed" | "failed";
export type StatusFilter = "all" | ToolStatus;

export interface SessionDevice {
  user: string;
  deviceId: string;
  deviceName: string;
}

export interface SessionAuth {
  url: string;
  code: string;
  expiresIn: string;
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

export interface RuntimeSessionSnapshot {
  connection: ConnectionStatus;
  device?: SessionDevice;
  auth?: SessionAuth;
  rows: ToolCallRow[];
  counts: SessionCounts;
}

export interface SessionSnapshot extends RuntimeSessionSnapshot {
  filteredRows: ToolCallRow[];
  selectedCall?: ToolCallRow;
  query: string;
  statusFilter: StatusFilter;
}
