import { describe, expect, test } from "bun:test";
import { SessionStore } from "../../src/session/store";
import type { RuntimeEvent } from "../../src/runtime/events";

const started = (callId: string, toolName = "read_file"): RuntimeEvent => ({
  type: "tool.started",
  callId,
  toolName,
  args: { path: `/${callId}` },
  metadata: {},
  startedAt: 10,
});

const completed = (callId: string, toolName = "read_file"): RuntimeEvent => ({
  type: "tool.completed",
  callId,
  toolName,
  resultText: `${callId} result`,
  durationMs: 25,
  completedAt: 35,
});

describe("SessionStore", () => {
  test("tracks tool lifecycle and aggregate counts", () => {
    const store = new SessionStore();
    store.consume(started("a"));

    expect(store.snapshot().counts).toEqual({ total: 1, running: 1, completed: 0, failed: 0 });
    store.consume(completed("a"));
    const snapshot = store.snapshot();

    expect(snapshot.counts).toEqual({ total: 1, running: 0, completed: 1, failed: 0 });
    expect(snapshot.rows[0]).toMatchObject({
      callId: "a",
      status: "completed",
      durationMs: 25,
      resultText: "a result",
    });
  });

  test("tracks connection and selected device without owning connectivity", () => {
    const store = new SessionStore();
    store.consume({
      type: "device.ready",
      user: "user@example.test",
      deviceId: "device-1",
      deviceName: "mac.local",
      at: 1,
    });

    expect(store.snapshot()).toMatchObject({
      connection: "online",
      device: { deviceId: "device-1", deviceName: "mac.local" },
    });
  });

  test("filters by query and status", () => {
    const store = new SessionStore();
    store.consume(started("alpha", "read_file"));
    store.consume(completed("alpha", "read_file"));
    store.consume(started("beta", "start_process"));

    store.setQuery("process");
    expect(store.snapshot().filteredRows.map((row) => row.callId)).toEqual(["beta"]);

    store.setQuery("");
    store.setStatusFilter("completed");
    expect(store.snapshot().filteredRows.map((row) => row.callId)).toEqual(["alpha"]);
  });

  test("keeps selection inside the filtered list", () => {
    const store = new SessionStore();
    store.consume(started("a"));
    store.consume(started("b"));
    store.consume(started("c"));

    expect(store.snapshot().selectedCall?.callId).toBe("a");
    store.moveSelection(99);
    expect(store.snapshot().selectedCall?.callId).toBe("c");
    store.moveSelection(-99);
    expect(store.snapshot().selectedCall?.callId).toBe("a");

    store.setQuery("/b");
    expect(store.snapshot().selectedCall?.callId).toBe("b");
  });
});


test("SessionStore keeps official auth details for local presentation", () => {
  const store = new SessionStore();
  store.consume({
    type: "auth.required",
    url: "https://example.test/device",
    code: "ABCD-EFGH",
    expiresIn: "15 minutes",
    at: 1,
  });

  expect(store.snapshot()).toMatchObject({
    connection: "auth",
    auth: {
      url: "https://example.test/device",
      code: "ABCD-EFGH",
      expiresIn: "15 minutes",
    },
  });
});


test("selectLastFiltered jumps to the newest visible call", () => {
  const store = new SessionStore();
  store.consume(started("a"));
  store.consume(started("b"));
  store.consume(started("c"));
  store.selectLastFiltered();
  expect(store.snapshot().selectedCall?.callId).toBe("c");
});

test("selectCall selects only calls visible in the current view", () => {
  const store = new SessionStore();
  store.consume(started("a"));
  store.consume(completed("a"));
  store.consume(started("b"));
  store.selectCall("b");
  expect(store.snapshot().selectedCall?.callId).toBe("b");

  store.setStatusFilter("completed");
  expect(store.snapshot().selectedCall?.callId).toBe("a");
  store.selectCall("b");
  expect(store.snapshot().selectedCall?.callId).toBe("a");
  store.selectCall("missing");
  expect(store.snapshot().selectedCall?.callId).toBe("a");
});
