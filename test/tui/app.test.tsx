import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createMockMouse } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { DesktopRemoteApp, footerText } from "../../src/tui/app";
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
  expect(frame).toContain("↑↓ navigate · Enter details · / search · f filter · ? help");

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

test("renders a long process target completely without ellipsis", async () => {
  const store = new SessionStore();
  const command = "printf BEGIN very long command with src/tui/app.tsx:42:7 warning and FINAL_TOKEN";
  store.consume({
    type: "tool.started",
    callId: "long-1",
    toolName: "start_process",
    args: { command },
    metadata: {},
    startedAt: 1,
  });
  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 52, height: 20 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("FINAL_TOKEN");
  expect(frame).not.toContain("…");
  setup.renderer.destroy();
});
test("builds contextual footer text for pending activity and detail", () => {
  expect(footerText("activity", { following: false, pendingNew: 3 }))
    .toContain("↓ 3 new · End latest");
  expect(footerText("detail", { following: false, pendingNew: 0 }))
    .toBe("Esc/← back · a arguments");
  expect(footerText("detail", { following: false, pendingNew: 3 }))
    .toBe("↓ 3 new · Esc/← back · a arguments");
  expect(footerText("activity", { following: true, pendingNew: 0 }))
    .toContain("f filter · ? help");
});

test("clicking an activity call through the app selects that call", async () => {
  const store = populatedStore();
  store.consume({
    type: "tool.started",
    callId: "call-2",
    toolName: "start_process",
    args: { command: "printf second-call" },
    metadata: {},
    startedAt: 30,
  });
  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 110, height: 24 },
  );
  await setup.renderOnce();
  expect(store.snapshot().selectedCall?.callId).toBe("call-1");
  const row = setup.renderer.root.findDescendantById("activity-call-call-2");
  expect(row).toBeDefined();
  if (!row) { setup.renderer.destroy(); return; }
  await createMockMouse(setup.renderer).click(row.screenX + 1, row.screenY);
  expect(store.snapshot().selectedCall?.callId).toBe("call-2");
  setup.renderer.destroy();
});


test("does not duplicate the selected activity target below the feed", async () => {
  const store = populatedStore();
  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 110, height: 24 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame.split("/project/src/index.ts").length - 1).toBe(1);
  setup.renderer.destroy();
});
