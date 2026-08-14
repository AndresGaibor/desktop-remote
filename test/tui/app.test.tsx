import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { DesktopRemoteApp } from "../../src/tui/app";
import { SessionStore } from "../../src/session/store";

test("renders the main session screen with OpenTUI", async () => {
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

  const setup = await testRender(
    () => <DesktopRemoteApp store={store} snapshot={() => store.snapshot()} refresh={() => {}} onQuit={() => {}} />,
    { width: 110, height: 24 },
  );

  await setup.renderOnce();
  const frame = setup.captureCharFrame();

  expect(frame).toContain("desktop-remote");
  expect(frame).toContain("mac.local");
  expect(frame).toContain("read_file");
  expect(frame).toContain("1 calls");

  setup.renderer.destroy();
});
