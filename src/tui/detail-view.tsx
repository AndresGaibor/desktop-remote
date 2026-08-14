import { For } from "solid-js";
import type { ToolCallRow } from "../session/types";
import {
  classifyDetailContent,
  type DiagnosticRole,
} from "./output-renderer";
import {
  TUI_SYNTAX_STYLE,
  TUI_THEME,
  toneColor,
} from "./theme";
import { statusVisual } from "./view-model";

export interface CallDetailViewProps {
  row: ToolCallRow;
  width: number;
}

export function CallDetailView(props: CallDetailViewProps) {
  const detail = () => classifyDetailContent(props.row);
  const visual = () => statusVisual(props.row.status);
  const args = () => argumentLines(props.row.args);

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text><b>Call details</b></text>
        <text fg={TUI_THEME.muted}>Esc back</text>
      </box>
      <box height={2} flexDirection="column">
        <text fg={toneColor(visual().tone)}>
          {visual().glyph} <b>{props.row.toolName}</b> · {visual().label}
        </text>
        <text fg={TUI_THEME.muted}>
          {shortCallId(props.row.callId)} · {formatDuration(props.row.durationMs)}
        </text>
      </box>

      <box height={Math.min(6, args().length + 1)} flexDirection="column">
        <text fg={TUI_THEME.muted}>Arguments</text>
        <For each={args().slice(0, 5)}>
          {(line) => <text fg={TUI_THEME.text} wrapMode="none" truncate>{line}</text>}
        </For>
      </box>

      <text fg={detail().source === "error" ? TUI_THEME.danger : TUI_THEME.muted}>
        {detail().source === "error" ? "Error" : "Result"}
      </text>

      <box flexGrow={1} minHeight={3}>
        <code
          visible={detail().kind === "code" || detail().kind === "json"}
          content={detail().content}
          filetype={detail().filetype ?? "typescript"}
          syntaxStyle={TUI_SYNTAX_STYLE}
          drawUnstyledText
          width="100%"
          height="100%"
          wrapMode="none"
        />
        <scrollbox
          visible={detail().kind !== "code" && detail().kind !== "json"}
          width="100%"
          height="100%"
          viewportCulling
        >
          <For each={detail().lines}>
            {(line) => (
              <text
                fg={detailLineColor(line.role, detail().source === "error")}
                wrapMode="none"
                truncate
              >
                {line.text || " "}
              </text>
            )}
          </For>
        </scrollbox>
      </box>
    </box>
  );
}
function detailLineColor(role: DiagnosticRole, isErrorSource: boolean): string {
  if (role === "pass") return TUI_THEME.success;
  if (role === "fail" || role === "error") return TUI_THEME.danger;
  if (role === "warning") return TUI_THEME.warning;
  if (role === "location") return TUI_THEME.accent;
  if (role === "summary") return TUI_THEME.muted;
  return isErrorSource ? TUI_THEME.danger : TUI_THEME.text;
}

function argumentLines(value: unknown): string[] {
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

function shortCallId(callId: string): string {
  return callId.length > 12 ? `call ${callId.slice(0, 8)}…` : `call ${callId}`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "running";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
