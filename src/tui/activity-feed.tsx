import { For } from "solid-js";
import type { ActivityBlockView } from "./view-model";
import { TUI_THEME, toneColor } from "./theme";

export interface ActivityFeedProps {
  blocks: ActivityBlockView[];
  following: boolean;
  viewportHeight?: number;
}

export function ActivityFeed(props: ActivityFeedProps) {
  const lineCount = () => props.blocks.reduce((total, block) => total + block.lines.length, 0);
  const stickyBottom = () => props.following && lineCount() > (props.viewportHeight ?? 10);

  return (
    <scrollbox
      width="100%"
      height="100%"
      viewportCulling
      stickyScroll={stickyBottom()}
      stickyStart={stickyBottom() ? "bottom" : undefined}
    >
      <For each={props.blocks}>
        {(block) => (
          <For each={block.lines}>
            {(line) => (
              <text
                fg={toneColor(block.tone)}
                bg={block.selected ? TUI_THEME.selectedBackground : undefined}
                wrapMode="none"
              >
                {line || " "}
              </text>
            )}
          </For>
        )}
      </For>
    </scrollbox>
  );
}
