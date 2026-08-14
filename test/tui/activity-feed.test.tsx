import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { ActivityFeed } from "../../src/tui/activity-feed";
import { TUI_THEME } from "../../src/tui/theme";
import type { ActivityBlockView } from "../../src/tui/view-model";

test("selected activity background covers wrapped continuation lines", async () => {
  const block: ActivityBlockView = {
    callId: "call-1", selected: true, tone: "success", status: "completed",
    target: "very long command", duration: "42ms",
    lines: ["› ✓ start_process · 42ms", "    first wrapped line", "    second wrapped line"],
  };
  const setup = await testRender(
    () => <ActivityFeed blocks={[block]} following={true} />,
    { width: 60, height: 10 },
  );
  await setup.renderOnce();
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  for (const text of ["start_process", "first wrapped line", "second wrapped line"]) {
    const span = spans.find((candidate) => candidate.text.includes(text));
    expect(span?.bg.equals(RGBA.fromHex(TUI_THEME.selectedBackground))).toBe(true);
  }
  setup.renderer.destroy();
});
