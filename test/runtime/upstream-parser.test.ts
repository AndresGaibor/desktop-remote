import { describe, expect, test } from "bun:test";
import { MAX_ACTIVE_CALLS, MAX_PENDING_RESULT_BYTES, UpstreamParser } from "../../src/runtime/upstream-parser";

function createClock(...values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("UpstreamParser", () => {
  test("emits one auth event after collecting the official auth flow", () => {
    const parser = new UpstreamParser({ now: () => 10 });

    expect(parser.pushLine("Please complete authentication:")).toEqual([]);
    expect(parser.pushLine("Open https://example.test/device")).toEqual([]);
    expect(parser.pushLine("Code: ABCD-EFGH")).toEqual([]);
    const events = parser.pushLine("Code expires in 15 minutes");

    expect(events).toEqual([
      {
        type: "auth.required",
        url: "https://example.test/device",
        code: "ABCD-EFGH",
        expiresIn: "15 minutes",
        at: 10,
      },
    ]);
  });

  test("emits device ready after collecting device fields", () => {
    const parser = new UpstreamParser({ now: () => 20 });

    expect(parser.pushLine("✅ Device ready:")).toEqual([]);
    expect(parser.pushLine("   - User: user@example.test")).toEqual([]);
    expect(parser.pushLine("   - Device ID: device-123")).toEqual([]);
    const events = parser.pushLine("   - Device Name: macbook.local");

    expect(events).toEqual([
      {
        type: "device.ready",
        user: "user@example.test",
        deviceId: "device-123",
        deviceName: "macbook.local",
        at: 20,
      },
    ]);
  });

  test("emits tool start and completion using call id timing", () => {
    const parser = new UpstreamParser({ now: createClock(100, 145) });
    const started = parser.pushLine(
      '🔧 Received tool call call-a: read_file {"path":"/tmp/a.ts"} metadata: {}',
    );

    expect(started).toEqual([
      {
        type: "tool.started",
        callId: "call-a",
        toolName: "read_file",
        args: { path: "/tmp/a.ts" },
        metadata: {},
        startedAt: 100,
      },
    ]);

    expect(parser.pushLine("✅ Tool call read_file completed:")).toEqual([]);
    const completed = parser.pushLine(
      ' {"content":[{"type":"text","text":"hello"}]}',
    );

    expect(completed).toEqual([
      {
        type: "tool.completed",
        callId: "call-a",
        toolName: "read_file",
        resultText: "hello",
        durationMs: 45,
        completedAt: 145,
      },
    ]);
  });

  test("keeps concurrent calls to the same tool distinct", () => {
    const parser = new UpstreamParser({ now: createClock(10, 20, 40, 70) });

    parser.pushLine('🔧 Received tool call call-a: read_file {"path":"a"} metadata: {}');
    parser.pushLine('🔧 Received tool call call-b: read_file {"path":"b"} metadata: {}');

    parser.pushLine("✅ Tool call read_file completed:");
    const first = parser.pushLine('{"content":[{"type":"text","text":"A"}]}');
    parser.pushLine("✅ Tool call read_file completed:");
    const second = parser.pushLine('{"content":[{"type":"text","text":"B"}]}');

    expect(first[0]).toMatchObject({ callId: "call-a", durationMs: 30 });
    expect(second[0]).toMatchObject({ callId: "call-b", durationMs: 50 });
  });

  test("emits a failed event for the oldest matching active call", () => {
    const parser = new UpstreamParser({ now: createClock(5, 25) });
    parser.pushLine('🔧 Received tool call call-x: start_process {"command":"false"} metadata: {}');

    const events = parser.pushLine("❌ Tool call start_process failed: command failed", "stderr");

    expect(events[0]).toMatchObject({
      type: "tool.failed",
      callId: "call-x",
      toolName: "start_process",
      error: "command failed",
      durationMs: 20,
    });
  });

  test("bounds incomplete multiline tool results and recovers", () => {
    const parser = new UpstreamParser({ now: () => 100 });
    parser.pushLine('🔧 Received tool call call-large: read_file {} metadata: {}');
    parser.pushLine("✅ Tool call read_file completed:");

    const chunk = `"${"x".repeat(64 * 1024)}`;
    let events = [] as ReturnType<UpstreamParser["pushLine"]>;
    for (let i = 0; i < Math.ceil(MAX_PENDING_RESULT_BYTES / (64 * 1024)) + 2; i += 1) {
      events = parser.pushLine(chunk);
      if (events.some((event) => event.type === "runtime.error")) break;
    }

    expect(events.some((event) => event.type === "runtime.error" && event.message.includes("512 KiB"))).toBe(true);
    const recovered = parser.pushLine('🔧 Received tool call after-overflow: read_file {} metadata: {}');
    expect(recovered.some((event) => event.type === "tool.started" && event.callId === "after-overflow")).toBe(true);
  });

  test("keeps at most 128 unfinished calls and evicts the oldest tracking entry", () => {
    const parser = new UpstreamParser({ now: () => 1 });
    let overflowEvents = [] as ReturnType<UpstreamParser["pushLine"]>;
    for (let i = 0; i <= MAX_ACTIVE_CALLS; i += 1) {
      overflowEvents = parser.pushLine(`🔧 Received tool call call-${i}: read_file {} metadata: {}`);
    }

    expect(parser.activeCallCountForTest()).toBe(MAX_ACTIVE_CALLS);
    expect(overflowEvents.some((event) => event.type === "runtime.error" && event.message.includes("128"))).toBe(true);
    expect(overflowEvents.some((event) => event.type === "tool.started" && event.callId === `call-${MAX_ACTIVE_CALLS}`)).toBe(true);
  });

});
