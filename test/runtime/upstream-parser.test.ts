import { describe, expect, test } from "bun:test";
import { UpstreamParser } from "../../src/runtime/upstream-parser";

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
});
