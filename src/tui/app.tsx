import { For, createSignal, type Accessor } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { SessionStore } from "../session/store";
import type { SessionSnapshot, StatusFilter } from "../session/types";
import { CallDetailView } from "./detail-view";
import {
  actionForKey,
  transitionMode,
  type TuiMode,
} from "./interaction";
import {
  buildActivityRows,
  buildContextSummary,
  buildEmptyState,
  connectionVisual,
} from "./view-model";
import {
  TUI_THEME,
  toneColor,
} from "./theme";

export interface DesktopRemoteAppProps {
  store: SessionStore;
  snapshot: Accessor<SessionSnapshot>;
  refresh: () => void;
  onQuit: () => void | Promise<void>;
}

const FILTERS: StatusFilter[] = ["all", "running", "completed", "failed"];
export function DesktopRemoteApp(props: DesktopRemoteAppProps) {
  const dimensions = useTerminalDimensions();
  const [mode, setMode] = createSignal<TuiMode>("activity");

  const refresh = () => props.refresh();
  const selected = () => props.snapshot().selectedCall;
  const activityRows = () => buildActivityRows(props.snapshot(), dimensions().width);
  const contextSummary = () => buildContextSummary(props.snapshot(), dimensions().width);
  const connection = () => connectionVisual(props.snapshot().connection);
  const filterLabel = () => props.snapshot().statusFilter === "all"
    ? ""
    : ` · ${props.snapshot().statusFilter}`;

  const move = (delta: number) => {
    props.store.moveSelection(delta);
    refresh();
  };
  const cycleFilter = () => {
    const current = props.snapshot().statusFilter;
    const index = FILTERS.indexOf(current);
    props.store.setStatusFilter(FILTERS[(index + 1) % FILTERS.length] ?? "all");
    refresh();
  };

  useKeyboard((key) => {
    const action = actionForKey(key);
    const currentMode = mode();

    if (action === "quit") {
      void Promise.resolve(props.onQuit());
      return;
    }
    if (currentMode === "search") {
      if (action === "escape") setMode("activity");
      return;
    }
    if (currentMode === "detail" || currentMode === "help") {
      setMode(transitionMode(currentMode, action, selected() !== undefined));
      return;
    }
    if (action === "next") move(1);
    else if (action === "previous") move(-1);
    else if (action === "cycle-filter") cycleFilter();
    else setMode(transitionMode(currentMode, action, selected() !== undefined));
  });

  return (
    <box width="100%" height="100%" flexDirection="column" paddingX={1} gap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={TUI_THEME.accent}><b>desktop-remote</b></text>
        <text fg={toneColor(connection().tone)}>
          {props.snapshot().device?.deviceName ?? "Desktop Commander"} · {connection().glyph} {connection().label}
        </text>
      </box>

      <box visible={mode() === "search"} height={1} flexDirection="row">
        <text fg={TUI_THEME.accent}>/ </text>
        <input
          focused={mode() === "search"}
          flexGrow={1}
          value={props.snapshot().query}
          placeholder="Search tool, path or command…"
          onInput={(value) => {
            props.store.setQuery(value);
            refresh();
          }}
          onSubmit={() => setMode("activity")}
        />
      </box>

      <box visible={mode() !== "detail"} flexGrow={1} minHeight={5} flexDirection="column">
        <box height={1} flexDirection="row" justifyContent="space-between">
          <box flexDirection="row">
            <text><b>Tool calls</b></text>
            <text fg={TUI_THEME.muted}>{filterLabel()}</text>
          </box>
          <text fg={TUI_THEME.muted}>{props.snapshot().filteredRows.length}</text>
        </box>

        <scrollbox flexGrow={1} viewportCulling>
          <For each={activityRows()}>
            {(row) => (
              <text
                fg={toneColor(row.tone)}
                bg={row.selected ? TUI_THEME.selectedBackground : undefined}
                wrapMode="none"
                truncate
              >
                {row.text}
              </text>
            )}
          </For>
          <For each={activityRows().length === 0 ? buildEmptyState() : []}>
            {(line, index) => (
              <text fg={index() === 0 ? TUI_THEME.text : TUI_THEME.muted}>
                {line}
              </text>
            )}
          </For>
        </scrollbox>

        <box
          visible={contextSummary().length > 0}
          height={contextSummary().length + 1}
          flexDirection="column"
        >
          <text fg={TUI_THEME.muted}>────────────────────────────────────────</text>
          <For each={contextSummary()}>
            {(line) => <text fg={TUI_THEME.muted}>{line}</text>}
          </For>
        </box>
      </box>

      <box visible={mode() === "detail"} flexGrow={1} minHeight={5}>
        <For each={mode() === "detail" && selected() ? [selected()!] : []}>
          {(row) => <CallDetailView row={row} width={dimensions().width} />}
        </For>
      </box>

      <text height={1} fg={TUI_THEME.muted}>
        {footerText(mode())}
      </text>

      <box
        visible={props.snapshot().auth !== undefined}
        position="absolute"
        zIndex={100}
        top={2}
        left={4}
        width={Math.max(40, Math.min(76, dimensions().width - 8))}
        height={6}
        border
        borderColor={TUI_THEME.warning}
        backgroundColor={TUI_THEME.panelBackground}
        title="Authentication required"
        paddingX={1}
        flexDirection="column"
      >
        <text fg={TUI_THEME.warning}>Complete Desktop Commander authentication</text>
        <text fg={TUI_THEME.text}>{props.snapshot().auth?.url ?? ""}</text>
        <text fg={TUI_THEME.warning}>Code: <b>{props.snapshot().auth?.code ?? ""}</b></text>
        <text fg={TUI_THEME.muted}>Expires {props.snapshot().auth?.expiresIn ?? ""}</text>
      </box>

      <box
        visible={mode() === "help"}
        position="absolute"
        zIndex={110}
        top={3}
        left={4}
        width={Math.max(42, Math.min(72, dimensions().width - 8))}
        height={8}
        border
        borderColor={TUI_THEME.accent}
        backgroundColor={TUI_THEME.panelBackground}
        title="Keyboard shortcuts"
        paddingX={1}
        flexDirection="column"
      >
        <text><b>↑/↓ · j/k</b> move selection</text>
        <text><b>Enter</b> open selected call</text>
        <text><b>/</b> search tool, path or command</text>
        <text><b>f</b> cycle all/running/completed/failed</text>
        <text><b>Esc</b> close detail, search or help</text>
        <text><b>Ctrl+C</b> graceful shutdown</text>
      </box>
    </box>
  );
}

function footerText(mode: TuiMode): string {
  if (mode === "detail") return "Esc back · ? help";
  if (mode === "search") return "Type to search · Enter apply · Esc close";
  if (mode === "help") return "Esc close";
  return "↑↓ navigate · Enter details · / search · ? help";
}
