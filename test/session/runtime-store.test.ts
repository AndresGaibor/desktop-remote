import { describe, expect, test } from "bun:test";
import { ARGUMENT_MAX_BYTES, RESULT_MAX_BYTES, boundText, boundUnknown } from "../../src/session/bounds";
import { RuntimeSessionStore } from "../../src/session/runtime-store";
import type { RuntimeEvent } from "../../src/runtime/events";

function started(index: number): RuntimeEvent {
  return {
    type: "tool.started",
    callId: `call-${index}`,
    toolName: "read_file",
    args: { path: `/tmp/${index}.txt` },
    metadata: {},
    startedAt: index,
  };
}

describe("session bounds", () => {
  test("bounds long text by UTF-8 bytes while preserving head and tail", () => {
    const input = `BEGIN-${"á".repeat(300_000)}-END`;
    const output = boundText(input, RESULT_MAX_BYTES);

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(output).toContain("BEGIN-");
    expect(output).toContain("-END");
    expect(output).toContain("[truncated:");
  });

  test("bounds structured values without retaining the oversized graph", () => {
    const input = { command: `echo ${"x".repeat(100_000)}`, nested: { ok: true } };
    const output = boundUnknown(input, ARGUMENT_MAX_BYTES) as Record<string, unknown>;

    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(ARGUMENT_MAX_BYTES);
    expect(output).toHaveProperty("__desktopRemoteTruncated", true);
    expect(output).toHaveProperty("originalBytes");
    expect(String(output.preview)).toContain("command");
  });
});

describe("RuntimeSessionStore", () => {
  test("retains only the latest 50 bounded calls", () => {
    const store = new RuntimeSessionStore();
    for (let i = 0; i < 75; i += 1) store.consume(started(i));

    const snapshot = store.snapshot();
    expect(snapshot.rows).toHaveLength(50);
    expect(snapshot.rows[0]?.callId).toBe("call-25");
    expect(snapshot.rows.at(-1)?.callId).toBe("call-74");
  });

  test("bounds completed result text before retaining it", () => {
    const store = new RuntimeSessionStore();
    store.consume(started(1));
    store.consume({
      type: "tool.completed",
      callId: "call-1",
      toolName: "read_file",
      resultText: "x".repeat(300 * 1024),
      completedAt: 2,
    });

    const result = store.snapshot().rows[0]?.resultText ?? "";
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(result).toContain("[truncated:");
  });

  test("restores canonical state without presentation fields", () => {
    const source = new RuntimeSessionStore();
    source.consume(started(1));
    source.consume({
      type: "device.ready",
      user: "user@example.test",
      deviceId: "device-1",
      deviceName: "mac.local",
      at: 2,
    });

    const restored = new RuntimeSessionStore();
    restored.restore(source.snapshot());
    expect(restored.snapshot()).toEqual(source.snapshot());
  });
});
