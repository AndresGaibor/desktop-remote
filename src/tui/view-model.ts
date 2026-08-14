import type { SessionSnapshot, ToolCallRow } from "../session/types";

export function shouldUseSplitPane(width: number): boolean {
  return width >= 100;
}

export function buildTimelineRows(snapshot: SessionSnapshot, width: number): string[] {
  const usableWidth = Math.max(30, width - 4);
  return snapshot.filteredRows.map((row) => {
    const selected = snapshot.selectedCall?.callId === row.callId ? "›" : " ";
    const status = statusGlyph(row.status);
    const duration = row.durationMs === undefined ? "…" : formatDuration(row.durationMs);
    const target = summarizeTarget(row);
    const prefix = `${selected} ${status} ${row.toolName}`;
    const suffix = `${duration}`;
    const middleWidth = Math.max(4, usableWidth - prefix.length - suffix.length - 4);
    return `${prefix}  ${truncate(target, middleWidth)}  ${suffix}`;
  });
}

export function buildDetailLines(snapshot: SessionSnapshot, width: number): string[] {
  const row = snapshot.selectedCall;
  if (!row) return ["No tool call selected.", "Use ↑/↓ or j/k to navigate."];

  const lines = [
    `${statusGlyph(row.status)} ${row.toolName}`,
    `call ${row.callId}`,
    `status ${row.status}${row.durationMs === undefined ? "" : ` · ${formatDuration(row.durationMs)}`}`,
    "",
    "Arguments",
  ];

  for (const line of formatUnknown(row.args)) lines.push(line);

  if (row.resultText !== undefined) {
    lines.push("", "Result", ...row.resultText.split("\n"));
  }
  if (row.error !== undefined) {
    lines.push("", "Error", ...row.error.split("\n"));
  }

  const maxWidth = Math.max(20, width - 4);
  return lines.map((line) => truncate(line, maxWidth));
}

export function buildStatusLine(snapshot: SessionSnapshot, width: number): string {
  const { counts } = snapshot;
  const filter = snapshot.statusFilter === "all" ? "" : ` · filter ${snapshot.statusFilter}`;
  const query = snapshot.query ? ` · /${snapshot.query}` : "";
  const device = snapshot.device ? ` · ${snapshot.device.deviceName}` : "";
  const line = [
    snapshot.connection,
    `${counts.total} calls`,
    `✓ ${counts.completed}`,
    `✕ ${counts.failed}`,
    `running ${counts.running}`,
  ].join(" · ") + device + filter + query;
  return truncate(line, Math.max(20, width));
}

function statusGlyph(status: ToolCallRow["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  return "●";
}

function summarizeTarget(row: ToolCallRow): string {
  if (!isRecord(row.args)) return "";
  const path = row.args.path ?? row.args.filePath;
  if (typeof path === "string") return path;
  const command = row.args.command;
  if (typeof command === "string") return command.replace(/\s+/g, " ").trim();
  const pid = row.args.pid;
  if (typeof pid === "number" || typeof pid === "string") return `PID ${pid}`;
  return formatUnknown(row.args)[0] ?? "";
}

function formatUnknown(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n");
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
