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

test("renders running read_file as readable metadata instead of raw JSON", async () => {
  const setup = await testRender(
    () => <CallDetailView row={row({
      status: "running",
      completedAt: undefined,
      durationMs: undefined,
      resultText: undefined,
      args: { path: "/project/src/app.ts", isUrl: false, offset: 0, length: 10 },
    })} width={100} argumentsExpanded={false} />,
    { width: 100, height: 22 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Local file");
  expect(frame).toContain("lines 1–10");
  expect(frame).toContain("Reading…");
  expect(frame).not.toContain('"isUrl"');
  setup.renderer.destroy();
});
test("renders write_file content directly while running", async () => {
  const setup = await testRender(
    () => <CallDetailView row={row({
      toolName: "write_file",
      status: "running",
      completedAt: undefined,
      durationMs: undefined,
      resultText: undefined,
      args: {
        path: "/project/src/app.ts",
        mode: "append",
        content: "export const written = true;\nexport default written;",
      },
    })} width={100} argumentsExpanded={false} />,
    { width: 100, height: 22 },
  );
  await setup.renderOnce();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Content to write");
  expect(frame).toContain("export const written = true;");
  expect(frame).not.toContain('"content"');
  setup.renderer.destroy();
});
test("renders edit_block as a readable change diff", async () => {
  const setup = await testRender(
    () => <CallDetailView row={row({
      toolName: "edit_block",
      status: "running",
      completedAt: undefined,
      durationMs: undefined,
      resultText: undefined,
      args: {
        file_path: "/project/src/app.ts",
        old_string: "const oldValue = true;",
        new_string: "const newValue = true;",
      },
    })} width={100} argumentsExpanded={false} />,
    { width: 100, height: 22 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Changes");
  expect(frame).toContain("- const oldValue = true;");
  expect(frame).toContain("+ const newValue = true;");
  expect(frame).not.toContain('"old_string"');
  setup.renderer.destroy();
});