import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createMockMouse } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ActivityFeed } from "../../src/tui/activity-feed";
import { TUI_THEME } from "../../src/tui/theme";
import type { ActivityBlockView } from "../../src/tui/view-model";

test("selected activity background covers wrapped continuation lines", async () => {
  const block: ActivityBlockView = {
    callId: "call-1", toolName: "start_process", selected: true, tone: "success", status: "completed",
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


function activityBlock(callId: string, selected = false): ActivityBlockView {
  return {
    callId,
    toolName: "read_file",
    selected,
    tone: "success",
    status: "completed",
    target: `/project/${callId}.ts`,
    duration: "1ms",
    lines: [`${selected ? "›" : " "} ✓ read_file · 1ms`, `    /project/${callId}.ts`],
  };
}

test("single click selects the logical activity call", async () => {
  const selected: string[] = [];
  const blocks = [activityBlock("call-1", true), activityBlock("call-2")];
  const setup = await testRender(
    () => <ActivityFeed blocks={blocks} following={true} onSelect={(callId) => selected.push(callId)} onOpen={() => {}} />,
    { width: 60, height: 8 },
  );
  await setup.renderOnce();
  const row = setup.renderer.root.findDescendantById("activity-call-call-2");
  expect(row).toBeDefined();
  if (!row) { setup.renderer.destroy(); return; }
  await createMockMouse(setup.renderer).click(row.screenX + 1, row.screenY);
  expect(selected.at(-1)).toBe("call-2");
  setup.renderer.destroy();
});

test("double click opens the logical activity call", async () => {
  const opened: string[] = [];
  const blocks = [activityBlock("call-1", true), activityBlock("call-2")];
  const setup = await testRender(
    () => <ActivityFeed blocks={blocks} following={true} onSelect={() => {}} onOpen={(callId) => opened.push(callId)} />,
    { width: 60, height: 8 },
  );
  await setup.renderOnce();
  const row = setup.renderer.root.findDescendantById("activity-call-call-2");
  expect(row).toBeDefined();
  if (!row) { setup.renderer.destroy(); return; }
  await createMockMouse(setup.renderer).doubleClick(row.screenX + 1, row.screenY);
  expect(opened.at(-1)).toBe("call-2");
  setup.renderer.destroy();
});

test("selected offscreen activity call is scrolled into view on mount", async () => {
  const blocks = Array.from({ length: 12 }, (_, index) => activityBlock(`call-${index + 1}`, index === 11));
  const setup = await testRender(
    () => <ActivityFeed blocks={blocks} following={false} onSelect={() => {}} onOpen={() => {}} />,
    { width: 60, height: 6 },
  );
  await setup.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("/project/call-12.ts");
  setup.renderer.destroy();
});


test("uses semantic color only for the status glyph, not the whole activity target", async () => {
  const block = activityBlock("call-color", true);
  const setup = await testRender(
    () => <ActivityFeed blocks={[block]} following={true} />,
    { width: 60, height: 6 },
  );
  await setup.renderOnce();
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const glyph = spans.find((span) => span.text === "✓");
  const target = spans.find((span) => span.text.includes("/project/call-color.ts"));
  expect(glyph?.fg.equals(RGBA.fromHex(TUI_THEME.success))).toBe(true);
  expect(target?.fg.equals(RGBA.fromHex(TUI_THEME.muted))).toBe(true);
  setup.renderer.destroy();
});

test("reuses activity renderables across repeated snapshot refreshes", async () => {
  const longLines = Array.from({ length: 120 }, (_, index) => `    command fragment ${index}`);
  const makeBlock = (): ActivityBlockView => ({
    callId: "call-stable",
    toolName: "start_process",
    selected: true,
    tone: "warning",
    status: "running",
    target: "large command",
    duration: "1.0s ●",
    lines: ["› ● start_process · 1.0s ●", ...longLines],
  });
  const [blocks, setBlocks] = createSignal<ActivityBlockView[]>([makeBlock()]);
  const setup = await testRender(
    () => <ActivityFeed blocks={blocks()} following={true} />,
    { width: 80, height: 12 },
  );
  await setup.renderOnce();

  for (let index = 0; index < 250; index += 1) {
    setBlocks([makeBlock()]);
    await setup.renderOnce();
  }

  expect(setup.captureCharFrame()).toContain("command fragment 119");
  setup.renderer.destroy();
});
