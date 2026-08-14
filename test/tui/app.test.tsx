import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { DesktopRemoteApp } from "../../src/tui/app";
import { SessionStore } from "../../src/session/store";
import { TUI_THEME } from "../../src/tui/theme";

function populatedStore(): SessionStore {
  const store = new SessionStore();
  store.consume({
    type: "device.ready",
    user: "user@example.test",
    deviceId: "device-1",
    deviceName: "mac.local",
    at: 1,
  });
  store.consume({
    type: "tool.started",
    callId: "call-1",
    toolName: "read_file",
    args: { path: "/project/src/index.ts" },
    metadata: {},
    startedAt: 2,
  });
  store.consume({
    type: "tool.completed",
    callId: "call-1",
    toolName: "read_file",
    resultText: "const ok: boolean = true;",
    durationMs: 18,
    completedAt: 20,
  });
  return store;
}

test("renders a minimal activity screen with a highlighted selection", async () => {
  const store = populatedStore();
  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 110, height: 24 },
  );
  await setup.renderOnce();

  const frame = setup.captureCharFrame();
  expect(frame).toContain("desktop-remote");
  expect(frame).toContain("Tool calls");
  expect(frame).toContain("✓ read_file");
  expect(frame).not.toContain("Details");
  expect(frame).toContain("↑↓ navigate · Enter details · / search · ? help");
  expect(frame).not.toContain("f filter");

  const span = setup.captureSpans().lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes("read_file"));
  expect(span?.bg.equals(RGBA.fromHex(TUI_THEME.selectedBackground))).toBe(true);
  setup.renderer.destroy();
});

test("renders a concise empty state", async () => {
  const store = new SessionStore();
  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 100, height: 20 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Waiting for tool calls…");
  expect(frame).toContain("MCP activity will appear here automatically.");
  expect(frame).not.toContain("No tool calls match the current view.");
  setup.renderer.destroy();
});
