import { expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/runtime/events";
import { SessionStore } from "../../src/session/store";
import { TuiSessionBridge } from "../../src/tui/run-tui";

test("TuiSessionBridge feeds events into store and log", () => {
  const runtime = new FakeRuntime();
  const store = new SessionStore();
  const written: RuntimeEvent[] = [];
  const writer = { write: (event: RuntimeEvent) => written.push(event), close: async () => {} };
  let refreshes = 0;
  const bridge = new TuiSessionBridge({ runtime, store, logWriter: writer });

  bridge.start(() => refreshes++);
  runtime.emit(deviceReady());

  expect(runtime.starts).toBe(1);
  expect(store.snapshot().connection).toBe("online");
  expect(written.map((event) => event.type)).toEqual(["device.ready"]);
  expect(refreshes).toBe(1);
});

test("TuiSessionBridge stops runtime before closing the event log", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime(() => order.push("runtime.stop"));
  const store = new SessionStore();
  const writer = {
    write: (_event: RuntimeEvent) => {},
    close: async () => { order.push("writer.close"); },
  };
  const bridge = new TuiSessionBridge({ runtime, store, logWriter: writer });

  bridge.start(() => {});
  await bridge.stop();

  expect(order).toEqual(["runtime.stop", "writer.close"]);
  expect(runtime.unsubscribed).toBe(true);
});

class FakeRuntime {
  starts = 0;
  unsubscribed = false;
  private listener: ((event: RuntimeEvent) => void) | undefined;
  constructor(private readonly onStop: () => void = () => {}) {}
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      this.unsubscribed = true;
    };
  }

  start(): void {
    this.starts++;
  }

  async stop(): Promise<void> {
    this.onStop();
  }

  emit(event: RuntimeEvent): void {
    this.listener?.(event);
  }
}

function deviceReady(): RuntimeEvent {
  return {
    type: "device.ready",
    user: "user@example.test",
    deviceId: "device-1",
    deviceName: "mac.local",
    at: 1,
  };
}
