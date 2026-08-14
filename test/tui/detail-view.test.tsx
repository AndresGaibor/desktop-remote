import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { CallDetailView } from "../../src/tui/detail-view";
import type { ToolCallRow } from "../../src/session/types";
import { TUI_THEME } from "../../src/tui/theme";

function row(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    callId: "call-1234567890",
    toolName: "read_file",
    args: { path: "/project/src/app.ts" },
    metadata: {},
    status: "completed",
    startedAt: 1,
    completedAt: 20,
    durationMs: 19,
    resultText: "const ok: boolean = true;",
    ...overrides,
  };
}

test("renders source output through the code view", async () => {
  const setup = await testRender(
    () => <CallDetailView row={row()} width={90} />,
    { width: 90, height: 20 },
  );
  await setup.renderOnce();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Call details");
  expect(frame).toContain("read_file");
  expect(frame).toContain("const ok: boolean = true;");
  setup.renderer.destroy();
});

test("colors test and lint diagnostics semantically", async () => {
  const setup = await testRender(
    () => <CallDetailView row={row({
      toolName: "start_process",
      args: { command: "bun test && eslint src" },
      resultText: [
        "PASS test/app.test.ts",
        "warning src/app.ts:9:2 unused value",
        "error src/app.ts:12:4 Unexpected any",
        "37 pass",
      ].join("\n"),
    })} width={100} />,
    { width: 100, height: 22 },
  );
  await setup.renderOnce();
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const pass = spans.find((span) => span.text.includes("PASS"));
  const warning = spans.find((span) => span.text.includes("warning"));
  const error = spans.find((span) => span.text.includes("error"));

  expect(pass?.fg.equals(RGBA.fromHex(TUI_THEME.success))).toBe(true);
  expect(warning?.fg.equals(RGBA.fromHex(TUI_THEME.warning))).toBe(true);
  expect(error?.fg.equals(RGBA.fromHex(TUI_THEME.danger))).toBe(true);
  setup.renderer.destroy();
});
