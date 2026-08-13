export type StreamSource = "stdout" | "stderr";

export interface AuthRequiredEvent {
  type: "auth.required";
  url: string;
  code: string;
  expiresIn: string;
  at: number;
}

export interface DeviceReadyEvent {
  type: "device.ready";
  user: string;
  deviceId: string;
  deviceName: string;
  at: number;
}

export interface ToolStartedEvent {
  type: "tool.started";
  callId: string;
  toolName: string;
  args: unknown;
  metadata: unknown;
  startedAt: number;
}

export interface ToolCompletedEvent {
  type: "tool.completed";
  callId: string;
  toolName: string;
  resultText: string;
  durationMs?: number;
  completedAt: number;
}

export interface ToolFailedEvent {
  type: "tool.failed";
  callId: string;
  toolName: string;
  error: string;
  durationMs?: number;
  completedAt: number;
}

export interface RuntimeLogEvent {
  type: "runtime.log";
  source: StreamSource;
  message: string;
  at: number;
}

export interface RuntimeExitedEvent {
  type: "runtime.exited";
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export interface RuntimeErrorEvent {
  type: "runtime.error";
  message: string;
  at: number;
}

export type RuntimeEvent =
  | AuthRequiredEvent
  | DeviceReadyEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | RuntimeLogEvent
  | RuntimeExitedEvent
  | RuntimeErrorEvent;
