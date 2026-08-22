import { describe, expect, test } from "bun:test";
import { JsonLineDecoder } from "../../src/ipc/framing";
import { MAX_IPC_FRAME_BYTES, encodeFrame } from "../../src/ipc/protocol";

describe("IPC framing", () => {
  test("decodes a frame split across chunks", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"type":"ping"')).toEqual([]);
    expect(decoder.push(',"protocolVersion":1,"at":1}\n')).toEqual([
      { type: "ping", protocolVersion: 1, at: 1 },
    ]);
  });

  test("decodes multiple newline-delimited messages", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("rejects oversized retained frames and recovers after reset", () => {
    const decoder = new JsonLineDecoder();
    expect(() => decoder.push("x".repeat(MAX_IPC_FRAME_BYTES + 1))).toThrow(/512 KiB/);
    expect(decoder.push('{"ok":true}\n')).toEqual([{ ok: true }]);
  });

  test("encodeFrame enforces the same hard frame ceiling", () => {
    expect(encodeFrame({ type: "ping", protocolVersion: 1, at: 1 })).toEndWith("\n");
    expect(() => encodeFrame({
      type: "error",
      protocolVersion: 1,
      code: "huge",
      message: "x".repeat(MAX_IPC_FRAME_BYTES),
    })).toThrow(/512 KiB/);
  });
});
