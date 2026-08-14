import type {
  ConnectionStatus,
  SessionSnapshot,
  ToolCallRow,
  ToolStatus,
} from "../session/types";
import type { SemanticTone } from "./theme";

export interface VisualToken {
  glyph: string;
  label: string;
  tone: SemanticTone;
}

export interface ActivityRowView {
  callId: string;
  text: string;
  selected: boolean;
  tone: SemanticTone;
  status: ToolStatus;
  target: string;
  duration: string;
}

export interface ActivityBlockView {
  callId: string;
  selected: boolean;
  tone: SemanticTone;
  status: ToolStatus;
  lines: string[];
  target: string;
  duration: string;
}

export function shouldUseSplitPane(_width: number): boolean {
  return false;
}
export function statusVisual(status: ToolStatus): VisualToken {
  if (status === "completed") return { glyph: "✓", label: "completed", tone: "success" };
  if (status === "failed") return { glyph: "✕", label: "failed", tone: "danger" };
  return { glyph: "●", label: "running", tone: "warning" };
}

export function connectionVisual(status: ConnectionStatus): VisualToken {
  if (status === "online") return { glyph: "●", label: "online", tone: "success" };
  if (status === "auth") return { glyph: "!", label: "auth", tone: "warning" };
  if (status === "error") return { glyph: "✕", label: "error", tone: "danger" };
  if (status === "offline") return { glyph: "○", label: "offline", tone: "muted" };
  return { glyph: "●", label: "connecting", tone: "warning" };
}

export function buildActivityBlocks(snapshot: SessionSnapshot, width: number): ActivityBlockView[] {
  const contentWidth = Math.max(12, width - 8);
  return snapshot.filteredRows.map((row) => {
    const visual = statusVisual(row.status);
    const selected = snapshot.selectedCall?.callId === row.callId;
    const target = summarizeTarget(row);
    const duration = row.status === "running" ? "running" : formatDuration(row.durationMs ?? 0);
    const lines = [`${selected ? "›" : " "} ${visual.glyph} ${row.toolName} · ${duration}`];
    if (target) lines.push(...wrapDisplayText(target, contentWidth).map((line) => `    ${line}`));
    return { callId: row.callId, selected, tone: visual.tone, status: row.status, lines, target, duration };
  });
}

export function buildSearchCounter(snapshot: SessionSnapshot): string {
  const eligible = snapshot.statusFilter === "all"
    ? snapshot.rows
    : snapshot.rows.filter((row) => row.status === snapshot.statusFilter);
  return `${snapshot.filteredRows.length} / ${eligible.length}`;
}

export function buildActivityRows(snapshot: SessionSnapshot, width: number): ActivityRowView[] {
  const usableWidth = Math.max(30, width - 4);
  return snapshot.filteredRows.map((row) => {
    const visual = statusVisual(row.status);
    const selected = snapshot.selectedCall?.callId === row.callId;
    const target = summarizeTarget(row);
    const duration = row.status === "running" ? "running" : formatDuration(row.durationMs ?? 0);
    const prefix = `${selected ? "›" : " "} ${visual.glyph} ${row.toolName}`;
    const middleWidth = Math.max(4, usableWidth - prefix.length - duration.length - 4);
    return {
      callId: row.callId,
      text: `${prefix}  ${truncate(target, middleWidth)}  ${duration}`,
      selected,
      tone: visual.tone,
      status: row.status,
      target,
      duration,
    };
  });
}

export function buildEmptyState(): string[] {
  return [
    "Waiting for tool calls…",
    "MCP activity will appear here automatically.",
  ];
}

export function buildContextSummary(snapshot: SessionSnapshot, width: number): string[] {
  const row = snapshot.selectedCall;
  if (!row) return [];
  const visual = statusVisual(row.status);
  const duration = row.status === "running" ? "" : ` · ${formatDuration(row.durationMs ?? 0)}`;
  const header = `${visual.glyph} ${row.toolName} · ${visual.label}${duration}`;
  const target = summarizeTarget(row);
  const maxWidth = Math.max(20, width - 4);
  return [
    ...wrapDisplayText(header, maxWidth),
    ...(target ? wrapDisplayText(target, maxWidth) : []),
  ];
}

export function buildTimelineRows(snapshot: SessionSnapshot, width: number): string[] {
  return buildActivityRows(snapshot, width).map((row) => row.text);
}
export function buildDetailLines(snapshot: SessionSnapshot, width: number): string[] {
  const row = snapshot.selectedCall;
  if (!row) return ["No tool call selected.", "Use ↑/↓ or j/k to navigate."];

  const visual = statusVisual(row.status);
  const lines = [
    `${visual.glyph} ${row.toolName}`,
    `call ${row.callId}`,
    `status ${visual.label}${row.durationMs === undefined ? "" : ` · ${formatDuration(row.durationMs)}`}`,
    "",
    "Arguments",
    ...formatUnknown(row.args),
  ];

  if (row.resultText !== undefined) lines.push("", "Result", ...row.resultText.split("\n"));
  if (row.error !== undefined) lines.push("", "Error", ...row.error.split("\n"));

  const maxWidth = Math.max(20, width - 4);
  return lines.map((line) => truncate(line, maxWidth));
}

export function buildStatusLine(snapshot: SessionSnapshot, width: number): string {
  const { counts } = snapshot;
  const filter = snapshot.statusFilter === "all" ? "" : ` · filter ${snapshot.statusFilter}`;
  const query = snapshot.query ? ` · /${snapshot.query}` : "";
  return truncate(`${snapshot.connection} · ${counts.total} calls · ✓ ${counts.completed} · ✕ ${counts.failed} · running ${counts.running}${filter}${query}`, Math.max(20, width));
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
function wrapDisplayText(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const physicalLine of value.split("\n")) {
    let remaining = physicalLine;
    if (!remaining) { lines.push(""); continue; }
    while (remaining.length > width) {
      const window = remaining.slice(0, width + 1);
      const space = window.lastIndexOf(" ");
      const cut = space >= Math.floor(width / 2) ? space : width;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut + (space === cut ? 1 : 0));
    }
    lines.push(remaining);
  }
  return lines;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
