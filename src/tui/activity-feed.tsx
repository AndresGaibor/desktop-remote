import type { ScrollBoxRenderable } from "@opentui/core";
import { Index } from "solid-js";
import { registerActivityClick, type ActivityClickState } from "./interaction";
import type { ActivityBlockView } from "./view-model";
import { TUI_THEME, toneColor } from "./theme";

export interface ActivityFeedProps {
  blocks: ActivityBlockView[];
  following: boolean;
  viewportHeight?: number;
  onSelect?: (callId: string) => void;
  onOpen?: (callId: string) => void;
}

export function ActivityFeed(props: ActivityFeedProps) {
  let scrollBox: ScrollBoxRenderable | undefined;
  let clickState: ActivityClickState | undefined;
  const lineCount = () => props.blocks.reduce((total, block) => total + block.lines.length + (block.dayLabel ? 1 : 0), 0);
  const stickyBottom = () => props.following && lineCount() > (props.viewportHeight ?? 10);
  const selectedCallId = () => props.blocks.find((block) => block.selected)?.callId;

  let lastScrollKey = "";

  function scrollSelectedIntoViewAfterLayout() {
    const callId = selectedCallId();
    if (!callId || !scrollBox || scrollBox.viewport.height <= 0) return;
    const scrollKey = `${callId}:${scrollBox.viewport.width}x${scrollBox.viewport.height}`;
    if (scrollKey === lastScrollKey) return;
    lastScrollKey = scrollKey;
    scrollBox.scrollChildIntoView(`activity-call-${callId}`);
  }

  return (
    <scrollbox
      ref={(renderable) => { scrollBox = renderable; }}
      renderAfter={scrollSelectedIntoViewAfterLayout}
      width="100%"
      height="100%"
      viewportCulling
      stickyScroll={stickyBottom()}
      stickyStart={stickyBottom() ? "bottom" : undefined}
    >
      <Index each={props.blocks}>
        {(block) => (
          <box
            id={`activity-call-${block().callId}`}
            width="100%"
            flexDirection="column"
            flexShrink={0}
            onMouseUp={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              const callId = block().callId;
              const click = registerActivityClick(clickState, callId, Date.now());
              clickState = click.state;
              props.onSelect?.(callId);
              if (click.open) props.onOpen?.(callId);
            }}
          >
            <text visible={Boolean(block().dayLabel)} fg={TUI_THEME.muted}>
              {block().dayLabel ? `  ${block().dayLabel}` : ""}
            </text>
            <box width="100%" flexDirection="row" flexShrink={0}>
              <text fg={TUI_THEME.muted} bg={block().selected ? TUI_THEME.selectedBackground : undefined}>
                {block().selected ? "› " : "  "}
              </text>
              <text fg={toneColor(block().tone)} bg={block().selected ? TUI_THEME.selectedBackground : undefined}>
                {block().status === "completed" ? "✓" : block().status === "failed" ? "✕" : "●"}
              </text>
              <text fg={TUI_THEME.text} bg={block().selected ? TUI_THEME.selectedBackground : undefined}>
                <b> {block().toolName}</b>
              </text>
              <text fg={TUI_THEME.muted} bg={block().selected ? TUI_THEME.selectedBackground : undefined}>
                {` · ${block().duration}`}
              </text>
              <text flexGrow={1} bg={block().selected ? TUI_THEME.selectedBackground : undefined}> </text>
              <text fg={TUI_THEME.muted} bg={block().selected ? TUI_THEME.selectedBackground : undefined}>
                {block().startedTime ? ` ${block().startedTime} ` : ""}
              </text>
            </box>
            <Index each={block().lines.slice(1)}>
              {(line) => (
                <text
                  fg={TUI_THEME.muted}
                  bg={block().selected ? TUI_THEME.selectedBackground : undefined}
                  wrapMode="none"
                >
                  {line() || " "}
                </text>
              )}
            </Index>
          </box>
        )}
      </Index>
    </scrollbox>
  );
}
