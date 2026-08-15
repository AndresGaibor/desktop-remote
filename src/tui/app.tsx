import { For, createEffect, createSignal, type Accessor } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { SessionStore } from "../session/store";
import type { SessionSnapshot, StatusFilter } from "../session/types";
import { ActivityFeed } from "./activity-feed";
import { CallDetailView } from "./detail-view";
import {
  actionForKey,
  transitionMode,
  updateFollowForTotalCalls,
  updateFollowState,
  type FollowState,
  type TuiMode,
} from "./interaction";
import {
  buildActivityBlocks,
  buildContextSummary,
  buildEmptyState,
  buildSearchCounter,
  connectionVisual,
} from "./view-model";
import { TUI_THEME, toneColor } from "./theme";

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
  const [follow, setFollow] = createSignal<FollowState>({ following: true, pendingNew: 0 });
  const [argumentsExpanded, setArgumentsExpanded] = createSignal(false);
  let lastTotalCalls = -1;

  const refresh = () => props.refresh();
  const selected = () => props.snapshot().selectedCall;
  const blocks = () => buildActivityBlocks(props.snapshot(), dimensions().width);
  const contextSummary = () => buildContextSummary(props.snapshot(), dimensions().width);
  const connection = () => connectionVisual(props.snapshot().connection);
  const filterLabel = () => props.snapshot().statusFilter === "all"
    ? ""
    : ` · ${props.snapshot().statusFilter}`;

  createEffect(() => {
    const total = props.snapshot().counts.total;
    const previous = lastTotalCalls;
    lastTotalCalls = total;
    const current = follow();
    const update = updateFollowForTotalCalls(current, previous, total);
    if (update.state !== current) setFollow(update.state);
    if (update.selectNewest) selectNewest();
  });

  function selectNewest() {
    props.store.selectLastFiltered();
    refresh();
  }

  function move(delta: number) {
    props.store.moveSelection(delta);
    refresh();
  }

  function jumpToNewest() {
    props.store.selectLastFiltered();
    setFollow((state) => updateFollowState(state, "resume"));
    refresh();
  }

  function cycleFilter() {
    const current = props.snapshot().statusFilter;
    const index = FILTERS.indexOf(current);
    props.store.setStatusFilter(FILTERS[(index + 1) % FILTERS.length] ?? "all");
    props.store.selectLastFiltered();
    refresh();
  }

  function selectCall(callId: string) {
    props.store.selectCall(callId);
    refresh();
  }

  function openDetail(callId?: string) {
    if (callId) props.store.selectCall(callId);
    setArgumentsExpanded(false);
    setFollow((state) => updateFollowState(state, "freeze"));
    setMode("detail");
    refresh();
  }

  function backToActivity() {
    props.store.selectLastFiltered();
    setFollow((state) => updateFollowState(state, "resume"));
    setMode("activity");
    refresh();
  }

  useKeyboard((key) => {
    const action = actionForKey(key);
    const currentMode = mode();

    if (action === "quit") {
      void Promise.resolve(props.onQuit());
      return;
    }
    if (currentMode === "search") {
      if (action === "escape" || action === "back") backToActivity();
      return;
    }
    if (currentMode === "detail") {
      if (action === "toggle-arguments") {
        setArgumentsExpanded((value) => !value);
        return;
      }
      if (action === "escape" || action === "back") backToActivity();
      return;
    }
    if (currentMode === "help") {
      if (action === "escape" || action === "toggle-help") setMode("activity");
      return;
    }

    if (action === "next") move(1);
    else if (action === "previous") move(-1);
    else if (action === "jump-end") jumpToNewest();
    else if (action === "cycle-filter") cycleFilter();
    else if (action === "open-detail" && selected()) {
      openDetail();
    } else {
      setMode(transitionMode(currentMode, action, selected() !== undefined));
    }
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
            props.store.selectLastFiltered();
            refresh();
          }}
          onSubmit={backToActivity}
        />
        <text fg={TUI_THEME.muted}>{buildSearchCounter(props.snapshot())}</text>
      </box>

      <box visible={mode() !== "detail"} flexGrow={1} minHeight={5} flexDirection="column">
        <box height={1} flexDirection="row" justifyContent="space-between">
          <box flexDirection="row">
            <text><b>Tool calls</b></text>
            <text fg={TUI_THEME.muted}>{filterLabel()}</text>
          </box>
          <text fg={follow().pendingNew > 0 ? TUI_THEME.accent : TUI_THEME.muted}>
            {follow().pendingNew > 0 ? `↓ ${follow().pendingNew} new` : props.snapshot().filteredRows.length}
          </text>
        </box>

        <box visible={blocks().length > 0} flexGrow={1} minHeight={3}>
          <ActivityFeed
            blocks={blocks()}
            following={follow().following}
            viewportHeight={Math.max(3, dimensions().height - 9)}
            onSelect={selectCall}
            onOpen={openDetail}
          />
        </box>
        <box visible={blocks().length === 0} flexGrow={1} flexDirection="column">
          <For each={buildEmptyState()}>
            {(line, index) => (
              <text fg={index() === 0 ? TUI_THEME.text : TUI_THEME.muted}>
                {line}
              </text>
            )}
          </For>
        </box>

        <box
          visible={contextSummary().length > 0 && dimensions().height >= 18}
          height={contextSummary().length + 1}
          flexDirection="column"
        >
          <text fg={TUI_THEME.muted}>────────────────────────────────────────</text>
          <For each={contextSummary()}>
            {(line) => <text fg={TUI_THEME.muted} wrapMode="word">{line}</text>}
          </For>
        </box>
      </box>

      <box visible={mode() === "detail"} flexGrow={1} minHeight={5} flexDirection="column">
        <box visible={follow().pendingNew > 0} height={follow().pendingNew > 0 ? 1 : 0} justifyContent="flex-end">
          <text fg={TUI_THEME.accent}>↓ {follow().pendingNew} new</text>
        </box>
        <box flexGrow={1}>
          <For each={mode() === "detail" && selected() ? [selected()!] : []}>
            {(row) => (
              <CallDetailView
                row={row}
                width={dimensions().width}
                argumentsExpanded={argumentsExpanded()}
              />
            )}
          </For>
        </box>
      </box>
      <text height={1} fg={TUI_THEME.muted}>
        {footerText(mode(), follow())}
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
        height={7}
        border
        borderColor={TUI_THEME.accent}
        backgroundColor={TUI_THEME.panelBackground}
        title="Keyboard shortcuts"
        paddingX={1}
        flexDirection="column"
      >
        <text><b>Navigate</b>  ↑/↓ · j/k · End latest</text>
        <text><b>Inspect</b>   Enter detail · a raw args · Esc/← back</text>
        <text><b>Filter</b>    / search · f status</text>
        <text><b>Exit</b>      Ctrl+C graceful shutdown</text>
      </box>
    </box>
  );
}

export function footerText(mode: TuiMode, follow: FollowState): string {
  if (mode === "detail") {
    const pending = follow.pendingNew > 0 ? `↓ ${follow.pendingNew} new · ` : "";
    return `${pending}Esc/← back · a arguments`;
  }
  if (mode === "search") return "Type to search · Enter apply · Esc close";
  if (mode === "help") return "Esc close";
  if (follow.pendingNew > 0) {
    return `↓ ${follow.pendingNew} new · End latest · ↑↓ navigate · Enter details · / search · f filter`;
  }
  return "↑↓ navigate · Enter details · / search · f filter · ? help";
}