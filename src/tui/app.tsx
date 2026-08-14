import { For, createSignal, type Accessor } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { SessionStore } from "../session/store";
import type { SessionSnapshot, StatusFilter } from "../session/types";
import {
  buildDetailLines,
  buildStatusLine,
  buildTimelineRows,
  shouldUseSplitPane,
} from "./view-model";

export interface DesktopRemoteAppProps {
  store: SessionStore;
  snapshot: Accessor<SessionSnapshot>;
  refresh: () => void;
  onQuit: () => void | Promise<void>;
}

const FILTERS: StatusFilter[] = ["all", "running", "completed", "failed"];

export function DesktopRemoteApp(props: DesktopRemoteAppProps) {
  const dimensions = useTerminalDimensions();
  const [searchMode, setSearchMode] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showNarrowDetail, setShowNarrowDetail] = createSignal(false);

  const splitPane = () => shouldUseSplitPane(dimensions().width);
  const refresh = () => props.refresh();
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
    if (key.ctrl && key.name === "c") {
      void Promise.resolve(props.onQuit());
      return;
    }
    if (searchMode()) {
      if (key.name === "escape") setSearchMode(false);
      return;
    }
    if (key.name === "escape") {
      setShowHelp(false);
      setShowNarrowDetail(false);
      return;
    }
    if (key.name === "up" || key.name === "k") move(-1);
    else if (key.name === "down" || key.name === "j") move(1);    else if (key.name === "f") cycleFilter();
    else if (key.name === "return" || key.name === "enter") {
      if (!splitPane()) setShowNarrowDetail((value) => !value);
    } else if (key.sequence === "/" || key.name === "/") {
      setSearchMode(true);
    } else if (key.sequence === "?" || key.name === "?") {
      setShowHelp((value) => !value);
    }
  });

  const timelineWidth = () =>
    splitPane() ? Math.max(50, Math.floor(dimensions().width * 0.55)) : dimensions().width;
  const detailWidth = () =>
    splitPane() ? Math.max(38, dimensions().width - timelineWidth()) : dimensions().width;
  const showTimeline = () => splitPane() || !showNarrowDetail();
  const showDetail = () => splitPane() || showNarrowDetail();

  return (
    <box width="100%" height="100%" flexDirection="column" paddingX={1} gap={1}>
      <box height={2} flexDirection="row" justifyContent="space-between">
        <text fg="#7dd3fc"><b>desktop-remote</b></text>
        <text fg="#94a3b8">
          {props.snapshot().device?.deviceName ?? "Desktop Commander"} · {props.snapshot().connection}
        </text>
      </box>
      <box
        visible={props.snapshot().auth !== undefined}
        border
        borderColor="#f59e0b"
        title="Desktop Commander authentication"
        paddingX={1}
        height={5}
        flexDirection="column"
      >
        <text fg="#fbbf24">{props.snapshot().auth?.url ?? ""}</text>
        <text>
          Code: <b>{props.snapshot().auth?.code ?? ""}</b> · expires {props.snapshot().auth?.expiresIn ?? ""}
        </text>
      </box>

      <box
        visible={searchMode()}
        border
        borderColor="#38bdf8"
        title="Search"
        height={3}
        paddingX={1}
      >
        <input
          focused={searchMode()}
          width="100%"
          value={props.snapshot().query}          placeholder="tool, path, command..."
          onInput={(value) => {
            props.store.setQuery(value);
            refresh();
          }}
          onSubmit={() => setSearchMode(false)}
        />
      </box>

      <box flexGrow={1} minHeight={5} flexDirection="row" gap={1}>
        <box
          visible={showTimeline()}
          width={splitPane() ? timelineWidth() : "100%"}
          height="100%"
          border
          borderColor="#334155"
          title={`Tool calls · ${props.snapshot().statusFilter}`}
          paddingX={1}
          flexDirection="column"
        >
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
            <text
              visible={props.snapshot().filteredRows.length === 0}
              fg="#64748b"
            >
              No tool calls match the current view.
            </text>
            <For each={buildTimelineRows(props.snapshot(), timelineWidth())}>
              {(row) => <text wrapMode="none" truncate>{row}</text>}
            </For>
          </scrollbox>
        </box>

        <box
          visible={showDetail()}
          width={splitPane() ? detailWidth() : "100%"}
          height="100%"
          border
          borderColor="#475569"
          title="Details"
          paddingX={1}
          flexDirection="column"
        >
          <scrollbox flexGrow={1}>
            <For each={buildDetailLines(props.snapshot(), detailWidth())}>
              {(line) => <text wrapMode="none" truncate>{line || " "}</text>}
            </For>
          </scrollbox>
        </box>
      </box>

      <box
        visible={showHelp()}
        border
        borderColor="#64748b"        title="Help"
        height={5}
        paddingX={1}
        flexDirection="column"
      >
        <text>↑/↓ or j/k  navigate · Enter  details · /  search · f  filter</text>
        <text>?  toggle help · Esc  close panel/search · Ctrl+C  graceful quit</text>
      </box>

      <box height={2} flexDirection="column">
        <text fg="#94a3b8">{buildStatusLine(props.snapshot(), dimensions().width - 2)}</text>
        <text fg="#64748b">
          ↑↓ navigate · Enter details · / search · f filter · ? help · Ctrl+C quit
        </text>
      </box>
    </box>
  );
}
