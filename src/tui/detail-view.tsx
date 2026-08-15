import { For } from "solid-js";
import type { ToolCallRow } from "../session/types";
import {
  classifyDetailContent,
  type DetailContent,
  type DiagnosticRole,
} from "./output-renderer";
import {
  buildToolDetailPresentation,
  type ToolDetailPresentation,
} from "./tool-detail";
import {
  TUI_SYNTAX_STYLE,
  TUI_THEME,
  toneColor,
} from "./theme";
import { statusVisual } from "./view-model";

export interface CallDetailViewProps {
  row: ToolCallRow;
  width: number;
  argumentsExpanded?: boolean;
}

export function CallDetailView(props: CallDetailViewProps) {
  const detail = () => classifyDetailContent(props.row);
  const tool = () => buildToolDetailPresentation(props.row);
  const visual = () => statusVisual(props.row.status);
  const rawArgs = () => argumentLines(props.row.args);
  const specialized = () => tool().kind !== "generic";

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text><b>Call details</b></text>
        <text fg={TUI_THEME.muted}>Esc/← back</text>
      </box>

      <box height={2} flexDirection="column">
        <text fg={toneColor(visual().tone)}>
          {visual().glyph} <b>{props.row.toolName}</b> · {visual().label}
        </text>
        <text fg={TUI_THEME.muted}>
          {shortCallId(props.row.callId)} · {formatDuration(props.row.durationMs, props.row.startedAt)}
        </text>
      </box>

      <box visible={specialized()} flexDirection="column">
        <box visible={tool().path !== undefined} flexDirection="column">
          <text fg={TUI_THEME.muted}>Path</text>
          <text fg={TUI_THEME.accent} wrapMode="word">
            {tool().path ?? ""}
          </text>
        </box>
        <For each={tool().fields}>
          {(field) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={TUI_THEME.muted}>{field.label}:</text>
              <text fg={TUI_THEME.text} wrapMode="word" flexGrow={1}>{` ${field.value}`}</text>
            </box>
          )}
        </For>
        <box visible={tool().mode !== undefined} flexDirection="row" flexShrink={0}>
          <text fg={TUI_THEME.muted}>Mode:</text>
          <text fg={TUI_THEME.text}>{` ${tool().mode ?? ""}`}</text>
        </box>
      </box>
      <box
        visible={!specialized() || props.argumentsExpanded === true}
        height={argumentBoxHeight(rawArgs(), props.argumentsExpanded === true)}
        flexDirection="column"
      >
        <text fg={TUI_THEME.muted}>
          {specialized() ? "Raw arguments" : "Arguments"}
        </text>
        <For each={visibleArgumentLines(rawArgs(), props.argumentsExpanded === true)}>
          {(line) => <text fg={TUI_THEME.text} wrapMode="word">{line}</text>}
        </For>
        <text
          visible={!props.argumentsExpanded && rawArgs().length > 3}
          fg={TUI_THEME.muted}
        >
          Press 'a' to expand all arguments
        </text>
      </box>

      <text
        visible={specialized() && props.argumentsExpanded !== true}
        fg={TUI_THEME.muted}
      >
        Press 'a' to view raw arguments
      </text>

      <ToolPrimaryContent row={props.row} tool={tool()} detail={detail()} />
    </box>
  );
}
interface ToolPrimaryContentProps {
  row: ToolCallRow;
  tool: ToolDetailPresentation;
  detail: DetailContent;
}

function ToolPrimaryContent(props: ToolPrimaryContentProps) {
  const isRead = () => props.tool.kind === "read";
  const isWrite = () => props.tool.kind === "write";
  const isEdit = () => props.tool.kind === "edit";
  const isProcess = () => props.tool.kind === "process";
  const isGeneric = () => props.tool.kind === "generic";

  return (
    <box flexGrow={1} minHeight={3} flexDirection="column" gap={1}>
      <box visible={isRead()} flexGrow={1} flexDirection="column">
        <text fg={TUI_THEME.muted}>
          {props.tool.content === undefined ? "Read" : "Content"}
        </text>
        <text
          visible={props.tool.content === undefined}
          fg={TUI_THEME.warning}
        >
          {props.row.status === "running" ? "Reading…" : "No content"}
        </text>
        <ContentPane
          visible={props.tool.content !== undefined}
          content={props.tool.content ?? ""}
          filetype={props.tool.filetype}
        />
      </box>
      <box visible={isWrite()} flexGrow={1} flexDirection="column">
        <text fg={TUI_THEME.muted}>Content to write</text>
        <ContentPane
          visible
          content={props.tool.content ?? ""}
          filetype={props.tool.filetype}
        />
      </box>

      <box visible={isEdit()} flexGrow={1} flexDirection="column">
        <text fg={TUI_THEME.muted}>Changes</text>
        <scrollbox flexGrow={1} viewportCulling>
          <For each={props.tool.diffLines ?? []}>
            {(line) => (
              <text fg={diffLineColor(line)} wrapMode="word">
                {line || " "}
              </text>
            )}
          </For>
        </scrollbox>
      </box>

      <box visible={isProcess()} flexGrow={1} flexDirection="column" gap={1}>
        <text fg={TUI_THEME.muted}>Command</text>
        <text fg={TUI_THEME.text} wrapMode="word">
          {props.tool.content ?? ""}
        </text>
        <ResultPane
          detail={props.detail}
          title="Output"
          isRunning={props.row.status === "running"}
        />
      </box>

      <box visible={isGeneric()} flexGrow={1} minHeight={3}>
        <ResultPane detail={props.detail} />
      </box>
    </box>
  );
}
interface ContentPaneProps {
  visible: boolean;
  content: string;
  filetype?: string;
}

function ContentPane(props: ContentPaneProps) {
  return (
    <box visible={props.visible} flexGrow={1} minHeight={3}>
      <code
        visible={props.filetype !== undefined}
        content={props.content}
        filetype={props.filetype ?? "typescript"}
        syntaxStyle={TUI_SYNTAX_STYLE}
        drawUnstyledText
        width="100%"
        height="100%"
        wrapMode="word"
      />
      <scrollbox
        visible={props.filetype === undefined}
        width="100%"
        height="100%"
        viewportCulling
      >
        <For each={props.content.split(/\r?\n/)}>
          {(line) => <text fg={TUI_THEME.text} wrapMode="word">{line || " "}</text>}
        </For>
      </scrollbox>
    </box>
  );
}
interface ResultPaneProps {
  detail: DetailContent;
  title?: string;
  isRunning?: boolean;
}

function ResultPane(props: ResultPaneProps) {
  const title = () => props.title ?? (props.detail.source === "error" ? "Error" : "Result");
  const hasContent = () => props.detail.source !== "empty";
  const showWaiting = () => props.isRunning && !hasContent();
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text
        visible={hasContent() || !props.isRunning}
        fg={props.detail.source === "error" ? TUI_THEME.danger : TUI_THEME.muted}
      >
        {title()}
      </text>
      <text visible={showWaiting()} fg={TUI_THEME.muted}>
        Running…
      </text>
      <code
        visible={props.detail.kind === "code" || props.detail.kind === "json"}
        content={props.detail.content}
        filetype={props.detail.filetype ?? "typescript"}
        syntaxStyle={TUI_SYNTAX_STYLE}
        drawUnstyledText
        width="100%"
        flexGrow={1}
        wrapMode="word"
      />
      <scrollbox
        visible={props.detail.kind !== "code" && props.detail.kind !== "json"}
        width="100%"
        flexGrow={1}
        viewportCulling
      >
        <For each={props.detail.lines}>
          {(line) => (
            <text fg={detailLineColor(line.role, props.detail.source === "error")} wrapMode="word">
              {line.text || " "}
            </text>
          )}
        </For>
      </scrollbox>
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

function diffLineColor(line: string): string {
  if (line.startsWith("- ")) return TUI_THEME.danger;
  if (line.startsWith("+ ")) return TUI_THEME.success;
  return TUI_THEME.muted;
}

function argumentLines(value: unknown): string[] {
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

function visibleArgumentLines(lines: string[], expanded: boolean): string[] {
  return expanded ? lines : lines.slice(0, 3);
}
function argumentBoxHeight(lines: string[], expanded: boolean): number {
  const visible = expanded ? lines.length : Math.min(3, lines.length);
  const hint = !expanded && lines.length > 3 ? 1 : 0;
  return Math.min(10, visible + hint + 1);
}

function shortCallId(callId: string): string {
  return callId.length > 12 ? `call ${callId.slice(0, 8)}…` : `call ${callId}`;
}

function formatDuration(ms?: number, startedAt?: number): string {
  if (ms === undefined) {
    if (startedAt !== undefined) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 1000) return `${elapsed}ms ●`;
      if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s ●`;
      return `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1000)}s ●`;
    }
    return "running";
  }
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}